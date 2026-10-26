import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { sql, type Selectable, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { AuthedAdmin, RequestMeta } from '../common/http';
import { DatabaseService } from '../database/database.module';
import type { AdminsTable, Database, SessionStage } from '../database/types';
import { AUTH_KEYS, type AuthKeys } from './auth-keys';
import { LOCKOUT_FAILURES, LOCKOUT_MINUTES, LOGIN_FAILED_MESSAGE } from './auth.constants';
import { findBackupCode, generateBackupCodes, hashBackupCode } from './backup-codes';
import { base32Encode } from './base32';
import { decrypt, encrypt } from './crypto-box';
import { hashPassword, verifyPassword } from './password';
import { passwordProblem } from './password-rules';
import { SessionsService, type NewSession } from './sessions.service';
import { otpauthUrl, verifyTotp } from './totp';

type Admin = Selectable<AdminsTable>;
/** What the panel should show next. 'done' means fully logged in. */
export type NextStep = Exclude<SessionStage, 'full'> | 'done';

const loginFailed = () => new UnauthorizedException(LOGIN_FAILED_MESSAGE);
const codeNotAccepted = () => new UnauthorizedException('Code not accepted');

function isLocked(admin: Admin): boolean {
  return admin.locked_until !== null && admin.locked_until.getTime() > Date.now();
}

function stageAfterPassword(admin: Admin): SessionStage {
  if (admin.must_change_password) return 'change_password';
  return admin.totp_enabled_at ? 'verify_2fa' : 'setup_2fa';
}

function nextStep(stage: SessionStage): NextStep {
  return stage === 'full' ? 'done' : stage;
}

@Injectable()
export class AuthService {
  /** Checked against when the email is unknown, so the reply takes the same time. */
  private dummyHash?: Promise<string>;

  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    @Inject(AUTH_KEYS) private readonly keys: AuthKeys,
  ) {}

  private get db() {
    return this.database.db;
  }

  async login(
    rawEmail: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{ session: NewSession; next: NextStep }> {
    const email = rawEmail.trim().toLowerCase();
    const admin = await this.db
      .selectFrom('admins')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();

    if (!admin) {
      this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
      await verifyPassword(password, await this.dummyHash);
      await this.audit.record({ action: 'auth.login_failed', reason: 'unknown email' }, meta);
      throw loginFailed();
    }

    const passwordOk = await verifyPassword(password, admin.password_hash);
    const refuse = async (reason: string) => {
      await this.audit.record({ action: 'auth.login_failed', admin_id: admin.id, reason }, meta);
      return loginFailed();
    };
    if (admin.status !== 'active') throw await refuse('account disabled');
    if (isLocked(admin)) throw await refuse('account locked');
    if (!passwordOk) {
      await this.recordFailure(admin.id, 'auth.login_failed', 'wrong password', meta);
      throw loginFailed();
    }
    if (
      admin.must_change_password &&
      admin.password_expires_at &&
      admin.password_expires_at.getTime() <= Date.now()
    ) {
      throw await refuse('temporary password expired');
    }

    const stage = stageAfterPassword(admin);
    const session = await this.sessions.create(admin.id, stage, meta);
    await this.audit.record(
      { action: 'auth.password_accepted', admin_id: admin.id, reason: `next: ${stage}` },
      meta,
    );
    return { session, next: nextStep(stage) };
  }

  /** Forced change (temporary password) or a normal change (needs the current password). */
  async changePassword(
    current: AuthedAdmin,
    body: { currentPassword?: string; newPassword: string },
    meta: RequestMeta,
  ): Promise<{ session?: NewSession; next: NextStep }> {
    const admin = await this.loadAdmin(current.id);

    if (current.stage === 'full') {
      const ok =
        body.currentPassword !== undefined &&
        (await verifyPassword(body.currentPassword, admin.password_hash));
      if (!ok) {
        await this.recordFailure(
          admin.id,
          'auth.password_change_failed',
          'wrong current password',
          meta,
        );
        throw new UnauthorizedException('Current password is wrong');
      }
    } else {
      await this.refuseIfLocked(admin, current, meta);
    }

    const problem = passwordProblem(body.newPassword, admin.email);
    if (problem) throw new BadRequestException(problem);
    if (await verifyPassword(body.newPassword, admin.password_hash)) {
      throw new BadRequestException('New password must be different from the current one');
    }
    const passwordHash = await hashPassword(body.newPassword);

    return this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('admins')
        .set({
          password_hash: passwordHash,
          must_change_password: false,
          password_expires_at: null,
          password_changed_at: new Date(),
        })
        .where('id', '=', admin.id)
        .execute();
      await this.sessions.endAllForAdmin(admin.id, 'password changed', current.sessionId, trx);
      await this.audit.record(
        { action: 'auth.password_changed', admin_id: admin.id, session_id: current.sessionId },
        meta,
        trx,
      );
      if (current.stage === 'full') return { next: 'done' as const };

      const stage: SessionStage = admin.totp_enabled_at ? 'verify_2fa' : 'setup_2fa';
      const session = await this.sessions.rotate(current, stage, meta, trx);
      return { session, next: nextStep(stage) };
    });
  }

  /** Creates a new authenticator secret (not active until confirmed with a code). */
  async startTotpSetup(
    current: AuthedAdmin,
    meta: RequestMeta,
  ): Promise<{ otpauthUrl: string; secret: string }> {
    const admin = await this.loadAdmin(current.id);
    await this.refuseIfLocked(admin, current, meta);
    if (admin.totp_enabled_at)
      throw new BadRequestException('2-step verification is already set up');

    const secret = randomBytes(20);
    await this.db
      .updateTable('admins')
      .set({ totp_secret_encrypted: encrypt(this.keys.totpSecretKey, secret, admin.id) })
      .where('id', '=', admin.id)
      .execute();
    await this.audit.record(
      { action: 'auth.2fa_setup_started', admin_id: admin.id, session_id: current.sessionId },
      meta,
    );
    return { otpauthUrl: otpauthUrl(secret, admin.email), secret: base32Encode(secret) };
  }

  /** First code from the app: turns 2-step on, logs in fully, returns backup codes (once). */
  async confirmTotpSetup(
    current: AuthedAdmin,
    code: string,
    meta: RequestMeta,
  ): Promise<{ session: NewSession; backupCodes: string[] }> {
    const admin = await this.loadAdmin(current.id);
    await this.refuseIfLocked(admin, current, meta);
    if (!admin.totp_secret_encrypted || admin.totp_enabled_at) {
      throw new BadRequestException('Start 2-step setup first');
    }
    const secret = decrypt(this.keys.totpSecretKey, admin.totp_secret_encrypted, admin.id);
    const step = verifyTotp(secret, code, Date.now(), null);
    if (step === null) {
      await this.recordFailure(admin.id, 'auth.2fa_failed', 'wrong code during setup', meta);
      throw codeNotAccepted();
    }

    return this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('admins')
        .set({ totp_enabled_at: new Date(), totp_last_step: step })
        .where('id', '=', admin.id)
        .execute();
      const backupCodes = await this.replaceBackupCodes(trx, admin.id);
      await this.audit.record(
        { action: 'auth.2fa_enabled', admin_id: admin.id, session_id: current.sessionId },
        meta,
        trx,
      );
      const session = await this.finishLogin(trx, current, 'authenticator (first setup)', meta);
      return { session, backupCodes };
    });
  }

  /** The 2-step check at login: an authenticator code or one backup code. */
  async verifySecondFactor(
    current: AuthedAdmin,
    input: { code?: string; backupCode?: string },
    meta: RequestMeta,
  ): Promise<{ session: NewSession; backupCodesLeft: number }> {
    const admin = await this.loadAdmin(current.id);
    await this.refuseIfLocked(admin, current, meta);
    if (!admin.totp_enabled_at || !admin.totp_secret_encrypted) {
      throw new BadRequestException('2-step verification is not set up');
    }

    const ok = input.code
      ? await this.useTotpCode(admin, input.code)
      : await this.useBackupCode(admin.id, input.backupCode ?? '');
    if (!ok) {
      const reason = input.code ? 'wrong authenticator code' : 'wrong backup code';
      await this.recordFailure(admin.id, 'auth.2fa_failed', reason, meta);
      throw codeNotAccepted();
    }

    return this.db.transaction().execute(async (trx) => {
      const backupCodesLeft = await this.countBackupCodes(admin.id, trx);
      if (input.backupCode) {
        await this.audit.record(
          {
            action: 'auth.backup_code_used',
            admin_id: admin.id,
            session_id: current.sessionId,
            reason: `${backupCodesLeft} backup codes left`,
          },
          meta,
          trx,
        );
      }
      const method = input.code ? 'authenticator' : 'backup code';
      const session = await this.finishLogin(trx, current, method, meta);
      return { session, backupCodesLeft };
    });
  }

  /** New backup codes (old ones stop working). Needs a current authenticator code. */
  async regenerateBackupCodes(
    current: AuthedAdmin,
    code: string,
    meta: RequestMeta,
  ): Promise<string[]> {
    const admin = await this.loadAdmin(current.id);
    if (!(await this.useTotpCode(admin, code))) {
      await this.recordFailure(
        admin.id,
        'auth.2fa_failed',
        'wrong code for new backup codes',
        meta,
      );
      throw codeNotAccepted();
    }
    return this.db.transaction().execute(async (trx) => {
      const codes = await this.replaceBackupCodes(trx, admin.id);
      await this.audit.record(
        {
          action: 'auth.backup_codes_regenerated',
          admin_id: admin.id,
          session_id: current.sessionId,
        },
        meta,
        trx,
      );
      return codes;
    });
  }

  async me(current: AuthedAdmin) {
    return {
      id: current.id,
      name: current.name,
      email: current.email,
      role: current.role,
      backupCodesLeft: await this.countBackupCodes(current.id),
    };
  }

  async logout(current: AuthedAdmin, meta: RequestMeta): Promise<void> {
    await this.sessions.end(current.sessionId, 'logout');
    await this.audit.record(
      { action: 'auth.logout', admin_id: current.id, session_id: current.sessionId },
      meta,
    );
  }

  // ----- helpers -----

  private async loadAdmin(id: string): Promise<Admin> {
    const admin = await this.db
      .selectFrom('admins')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!admin) throw new NotFoundException();
    return admin;
  }

  /** A half-finished login on a locked account is ended. */
  private async refuseIfLocked(admin: Admin, current: AuthedAdmin, meta: RequestMeta) {
    if (!isLocked(admin)) return;
    await this.sessions.end(current.sessionId, 'account locked');
    await this.audit.record(
      { action: 'auth.login_failed', admin_id: admin.id, reason: 'account locked' },
      meta,
    );
    throw loginFailed();
  }

  /** Counts a failure; on the 5th in a row, locks the account and ends its sessions. */
  private async recordFailure(
    adminId: string,
    action: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    const { rows } = await sql<{ locked_until: Date | null }>`
      UPDATE admins SET
        failed_login_count = CASE WHEN failed_login_count + 1 >= ${LOCKOUT_FAILURES}
                                  THEN 0 ELSE failed_login_count + 1 END,
        locked_until = CASE WHEN failed_login_count + 1 >= ${LOCKOUT_FAILURES}
                            THEN now() + make_interval(mins => ${LOCKOUT_MINUTES})
                            ELSE locked_until END
      WHERE id = ${adminId}
      RETURNING locked_until
    `.execute(this.db);
    await this.audit.record({ action, admin_id: adminId, reason }, meta);

    const lockedUntil = rows[0]?.locked_until;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      await this.sessions.endAllForAdmin(adminId, 'account locked');
      await this.audit.record(
        {
          action: 'auth.account_locked',
          admin_id: adminId,
          reason: `${LOCKOUT_FAILURES} failures in a row; locked for ${LOCKOUT_MINUTES} minutes`,
        },
        meta,
      );
    }
  }

  /** Accepts a code once: the time step is claimed atomically, so a replay always fails. */
  private async useTotpCode(admin: Admin, code: string): Promise<boolean> {
    if (!admin.totp_secret_encrypted || !admin.totp_enabled_at) return false;
    const secret = decrypt(this.keys.totpSecretKey, admin.totp_secret_encrypted, admin.id);
    const lastStep = admin.totp_last_step === null ? null : Number(admin.totp_last_step);
    const step = verifyTotp(secret, code, Date.now(), lastStep);
    if (step === null) return false;
    const result = await this.db
      .updateTable('admins')
      .set({ totp_last_step: step })
      .where('id', '=', admin.id)
      .where((eb) => eb.or([eb('totp_last_step', 'is', null), eb('totp_last_step', '<', step)]))
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  private async useBackupCode(adminId: string, code: string): Promise<boolean> {
    const unused = await this.db
      .selectFrom('admin_backup_codes')
      .select(['id', 'code_hash'])
      .where('admin_id', '=', adminId)
      .where('used_at', 'is', null)
      .execute();
    const index = findBackupCode(
      this.keys.backupCodeKey,
      code,
      unused.map((row) => row.code_hash),
    );
    if (index === -1) return false;
    const result = await this.db
      .updateTable('admin_backup_codes')
      .set({ used_at: new Date() })
      .where('id', '=', unused[index].id)
      .where('used_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  private async replaceBackupCodes(trx: Transaction<Database>, adminId: string): Promise<string[]> {
    const codes = generateBackupCodes();
    await trx.deleteFrom('admin_backup_codes').where('admin_id', '=', adminId).execute();
    await trx
      .insertInto('admin_backup_codes')
      .values(
        codes.map((code) => ({
          admin_id: adminId,
          code_hash: hashBackupCode(this.keys.backupCodeKey, code),
        })),
      )
      .execute();
    return codes;
  }

  private async countBackupCodes(
    adminId: string,
    db: Transaction<Database> | undefined = undefined,
  ): Promise<number> {
    const row = await (db ?? this.db)
      .selectFrom('admin_backup_codes')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('admin_id', '=', adminId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** Full login: clears the failure count, records the login, swaps in a full session. */
  private async finishLogin(
    trx: Transaction<Database>,
    current: AuthedAdmin,
    method: string,
    meta: RequestMeta,
  ): Promise<NewSession> {
    await trx
      .updateTable('admins')
      .set({ failed_login_count: 0, locked_until: null, last_login_at: new Date() })
      .where('id', '=', current.id)
      .execute();
    const session = await this.sessions.rotate(current, 'full', meta, trx);
    await this.audit.record(
      { action: 'auth.login_succeeded', admin_id: current.id, reason: method },
      meta,
      trx,
    );
    return session;
  }
}
