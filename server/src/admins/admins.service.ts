import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../auth/sessions.service';
import type { AuthedAdmin, RequestMeta } from '../common/http';
import { DatabaseService } from '../database/database.module';
import { emailSchema, issueTemporaryPassword, nameSchema } from '../setup/setup';

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.issues[0].message);
  return result.data;
}

@Injectable()
export class AdminsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  /** The admin team (no password or 2-step secrets). Removed admins last. */
  async list() {
    const rows = await this.database.db
      .selectFrom('admins')
      .select(['id', 'name', 'email', 'role', 'status', 'last_login_at', 'totp_enabled_at'])
      .orderBy(sql`status = 'disabled'`)
      .orderBy('created_at')
      .execute();
    return rows.map(({ totp_enabled_at, status, ...admin }) => ({
      ...admin,
      removed: status === 'disabled',
      twoStepEnabled: totp_enabled_at !== null,
    }));
  }

  /**
   * Adds an admin with a one-time temporary password (shown once to the Super Admin, stored
   * only as a hash, valid 24 hours, must be changed at first login).
   */
  async create(
    actor: AuthedAdmin,
    input: { name: string; email: string; role: 'super_admin' | 'support_admin' },
    meta: RequestMeta,
  ): Promise<{ id: string; temporaryPassword: string; expiresAt: Date }> {
    const name = parseInput(nameSchema, input.name);
    const email = parseInput(emailSchema, input.email);

    return this.database.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('admins')
        .select('status')
        .where('email', '=', email)
        .executeTakeFirst();
      if (existing) {
        throw new ConflictException(
          existing.status === 'disabled'
            ? 'This email belongs to a removed admin.'
            : 'An admin with this email already exists.',
        );
      }
      const issued = await issueTemporaryPassword();
      const row = await trx
        .insertInto('admins')
        .values({
          name,
          email,
          role: input.role,
          password_hash: issued.passwordHash,
          must_change_password: true,
          password_expires_at: issued.expiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(
        {
          action: 'admin.created',
          admin_id: actor.id,
          session_id: actor.sessionId,
          target_type: 'admin',
          target_id: row.id,
          details: JSON.stringify({ role: input.role }),
        },
        meta,
        trx,
      );
      return {
        id: row.id,
        temporaryPassword: issued.temporaryPassword,
        expiresAt: issued.expiresAt,
      };
    });
  }

  /**
   * New temporary password for a Support Admin. Also turns off their 2-step setup (they set it
   * up again), unlocks the account and ends their sessions. Super Admins: `--reissue` only.
   */
  async resetPassword(
    actor: AuthedAdmin,
    targetId: string,
    meta: RequestMeta,
  ): Promise<{ temporaryPassword: string; expiresAt: Date }> {
    const target = await this.activeTarget(actor, targetId);
    if (target.role !== 'support_admin') {
      throw new ForbiddenException(
        "Only a Support Admin's password can be reset here. For a Super Admin, use --reissue on the server.",
      );
    }
    const issued = await issueTemporaryPassword();
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('admins')
        .set({
          password_hash: issued.passwordHash,
          must_change_password: true,
          password_expires_at: issued.expiresAt,
          totp_secret_encrypted: null,
          totp_enabled_at: null,
          totp_last_step: null,
          failed_login_count: 0,
          locked_until: null,
        })
        .where('id', '=', target.id)
        .execute();
      await trx.deleteFrom('admin_backup_codes').where('admin_id', '=', target.id).execute();
      await this.sessions.endAllForAdmin(target.id, 'password reset', undefined, trx);
      await this.audit.record(
        {
          action: 'admin.password_reset',
          admin_id: actor.id,
          session_id: actor.sessionId,
          target_type: 'admin',
          target_id: target.id,
        },
        meta,
        trx,
      );
    });
    return { temporaryPassword: issued.temporaryPassword, expiresAt: issued.expiresAt };
  }

  /**
   * "Remove" disables the account (history stays): no login, sessions ended. Never yourself,
   * never the last active Super Admin.
   */
  async remove(actor: AuthedAdmin, targetId: string, reason: string, meta: RequestMeta) {
    const target = await this.activeTarget(actor, targetId);
    await this.database.db.transaction().execute(async (trx) => {
      if (target.role === 'super_admin') {
        // Locked so two removals at once can never leave zero Super Admins.
        const { rows } = await sql<{ n: string }>`
          SELECT count(*) AS n FROM (
            SELECT id FROM admins WHERE role = 'super_admin' AND status = 'active' FOR UPDATE
          ) active_super_admins
        `.execute(trx);
        if (Number(rows[0].n) <= 1) {
          throw new BadRequestException('You cannot remove the last Super Admin');
        }
      }
      await trx
        .updateTable('admins')
        .set({ status: 'disabled' })
        .where('id', '=', target.id)
        .execute();
      await this.sessions.endAllForAdmin(target.id, 'admin removed', undefined, trx);
      await this.audit.record(
        {
          action: 'admin.removed',
          admin_id: actor.id,
          session_id: actor.sessionId,
          target_type: 'admin',
          target_id: target.id,
          reason,
        },
        meta,
        trx,
      );
    });
  }

  /** Another admin who is still active (not yourself, not already removed). */
  private async activeTarget(actor: AuthedAdmin, targetId: string) {
    const target = await this.database.db
      .selectFrom('admins')
      .select(['id', 'role', 'status'])
      .where('id', '=', targetId)
      .executeTakeFirst();
    if (!target) throw new NotFoundException('Admin not found');
    if (target.id === actor.id)
      throw new BadRequestException('You cannot do this to your own account');
    if (target.status !== 'active') throw new BadRequestException('This admin has been removed');
    return target;
  }

  /**
   * A Super Admin resets a Support Admin's 2-step setup (lost phone). The Support Admin sets it
   * up again at next login. Super Admins are reset only with `pnpm app:setup --reissue`.
   */
  async resetTwoStep(
    actor: AuthedAdmin,
    targetId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    const target = await this.database.db
      .selectFrom('admins')
      .select(['id', 'role'])
      .where('id', '=', targetId)
      .executeTakeFirst();
    if (!target) throw new NotFoundException('Admin not found');
    if (target.id === actor.id)
      throw new BadRequestException('You cannot reset your own 2-step setup');
    if (target.role !== 'support_admin') {
      throw new ForbiddenException(
        "Only a Support Admin's 2-step setup can be reset here. For a Super Admin, use --reissue on the server.",
      );
    }

    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('admins')
        .set({ totp_secret_encrypted: null, totp_enabled_at: null, totp_last_step: null })
        .where('id', '=', target.id)
        .execute();
      await trx.deleteFrom('admin_backup_codes').where('admin_id', '=', target.id).execute();
      await this.sessions.endAllForAdmin(target.id, '2-step setup reset', undefined, trx);
      await this.audit.record(
        {
          action: 'admin.2fa_reset',
          admin_id: actor.id,
          session_id: actor.sessionId,
          target_type: 'admin',
          target_id: target.id,
          reason,
        },
        meta,
        trx,
      );
    });
  }
}
