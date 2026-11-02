import { createHash, createHmac, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  AddGuardianRequest,
  Guardian,
  InviteInfo,
  UpdateGuardianRequest,
} from '@sarthi/shared';
import { sql } from 'kysely';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import { maskPhone, normaliseIndianMobile } from '../../users/phone';
import { AppError, appError } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';
import { OutgoingMessages } from '../messages/outgoing-messages';

/** Invites (including resends) per user per day. */
export const INVITES_PER_DAY = 10;
/** An invite link works for this many days. */
export const INVITE_LINK_DAYS = 7;

interface GuardianRow {
  id: string;
  name: string;
  phone: string | null;
  relation: string | null;
  invite_status: 'pending' | 'accepted' | 'declined';
}

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

function toGuardian(row: GuardianRow): Guardian {
  return {
    id: row.id,
    name: row.name,
    relation: row.relation,
    phoneMasked: maskPhone(row.phone),
    status: row.invite_status,
  };
}

const linkExpired = () =>
  new AppError(
    HttpStatus.GONE,
    'link_expired',
    'This invite link has expired. Ask them to send it again.',
  );

@Injectable()
export class GuardiansService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
    private readonly rateLimiter: AppRateLimiter,
    private readonly messages: OutgoingMessages,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(userId: string): Promise<Guardian[]> {
    const rows = await this.database.db
      .selectFrom('guardians')
      .select(['id', 'name', 'phone', 'relation', 'invite_status'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toGuardian);
  }

  async add(userId: string, input: AddGuardianRequest): Promise<Guardian> {
    const phone = normaliseIndianMobile(input.phone);
    if (!phone) throw appError.invalidInput('phone: Enter a 10-digit Indian mobile number.');

    const user = await this.database.db
      .selectFrom('users')
      .select(['phone', 'name'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    if (user.phone === phone) throw appError.invalidInput("phone: You can't add your own number.");
    await this.countInvite(userId);

    const max = await this.settings.get('guardian.max_count');
    const guardian = await this.database.db.transaction().execute(async (trx) => {
      // One add at a time per user, so two quick taps can't pass the limit together.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`.execute(trx);

      const { n } = await trx
        .selectFrom('guardians')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', userId)
        .where('invite_status', '<>', 'declined')
        .executeTakeFirstOrThrow();
      if (Number(n) >= max) {
        throw appError.limitReached(`You can have up to ${max} guardians.`);
      }
      const existing = await trx
        .selectFrom('guardians')
        .select('id')
        .where('user_id', '=', userId)
        .where('phone', '=', phone)
        .executeTakeFirst();
      if (existing) throw appError.conflict('This number is already one of your guardians.');

      const blocked = await trx
        .selectFrom('guardian_invite_blocklist')
        .select('user_id')
        .where('user_id', '=', userId)
        .where('phone_hash', '=', this.phoneHash(phone))
        .executeTakeFirst();
      if (blocked) throw appError.invalidInput("phone: This number can't be invited.");

      return trx
        .insertInto('guardians')
        .values({
          user_id: userId,
          name: input.name,
          phone,
          relation: input.relation ?? null,
        })
        .returning(['id', 'name', 'phone', 'relation', 'invite_status'])
        .executeTakeFirstOrThrow();
    });

    await this.sendInvite(userId, user.name, guardian.id, phone, input.name);
    return toGuardian(guardian);
  }

  /** Name and relation only; the number can't change (remove and add again instead). */
  async update(
    userId: string,
    guardianId: string,
    change: UpdateGuardianRequest,
  ): Promise<Guardian> {
    const row = await this.database.db
      .updateTable('guardians')
      .set({
        ...(change.name !== undefined && { name: change.name }),
        ...(change.relation !== undefined && { relation: change.relation }),
      })
      .where('id', '=', guardianId)
      .where('user_id', '=', userId)
      .returning(['id', 'name', 'phone', 'relation', 'invite_status'])
      .executeTakeFirst();
    if (!row) throw appError.notFound('Guardian not found.');
    return toGuardian(row);
  }

  async resend(userId: string, guardianId: string): Promise<void> {
    const row = await this.database.db
      .selectFrom('guardians as g')
      .innerJoin('users as u', 'u.id', 'g.user_id')
      .select(['g.id', 'g.name', 'g.phone', 'g.invite_status', 'u.name as userName'])
      .where('g.id', '=', guardianId)
      .where('g.user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw appError.notFound('Guardian not found.');
    if (row.invite_status !== 'pending' || !row.phone) {
      throw appError.conflict('Only a guardian who has not answered yet can be invited again.');
    }
    await this.countInvite(userId);
    await this.sendInvite(userId, row.userName, row.id, row.phone, row.name);
  }

  async remove(userId: string, guardianId: string): Promise<void> {
    const activeSos = await this.database.db
      .selectFrom('sos_events')
      .select('id')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (activeSos) throw appError.conflict("Guardians can't be removed during an SOS.");

    const result = await this.database.db
      .deleteFrom('guardians')
      .where('id', '=', guardianId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (result.numDeletedRows === 0n) throw appError.notFound('Guardian not found.');
  }

  // ----- Guardian side (invite link, no login) -------------------------------------------

  async inviteInfo(code: string): Promise<InviteInfo> {
    const row = await this.findByCode(code);
    if (row.invite_status === 'pending' && row.invite_expires_at! <= new Date()) {
      throw linkExpired();
    }
    return {
      inviterFirstName: row.userName?.trim().split(/\s+/)[0] || 'A Sarthi Rakshak user',
      guardianName: row.name,
      status: row.invite_status,
      expiresAt: row.invite_expires_at!.toISOString(),
    };
  }

  async accept(code: string): Promise<void> {
    const row = await this.findByCode(code);
    if (row.invite_status === 'accepted') return;
    if (row.invite_status === 'declined') throw appError.conflict('This invite was declined.');
    if (row.invite_expires_at! <= new Date()) throw linkExpired();
    await this.database.db
      .updateTable('guardians')
      .set({ invite_status: 'accepted', responded_at: sql<Date>`now()` })
      .where('id', '=', row.id)
      .where('invite_status', '=', 'pending')
      .execute();
  }

  /** Declining removes the number and remembers only its hash, so it can't be invited again. */
  async decline(code: string): Promise<void> {
    const row = await this.findByCode(code);
    if (row.invite_status === 'declined') return;
    if (row.invite_expires_at! <= new Date()) throw linkExpired();
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('guardian_invite_blocklist')
        .values({ user_id: row.user_id, phone_hash: this.phoneHash(row.phone!) })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx
        .updateTable('guardians')
        .set({ invite_status: 'declined', phone: null, responded_at: sql<Date>`now()` })
        .where('id', '=', row.id)
        .execute();
    });
  }

  private async findByCode(code: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(code))
      throw appError.notFound('This invite link is not valid.');
    const row = await this.database.db
      .selectFrom('guardians as g')
      .innerJoin('users as u', 'u.id', 'g.user_id')
      .select([
        'g.id',
        'g.user_id',
        'g.name',
        'g.phone',
        'g.invite_status',
        'g.invite_expires_at',
        'u.name as userName',
      ])
      .where('g.invite_token_hash', '=', hashCode(code))
      .executeTakeFirst();
    if (!row || !row.invite_expires_at) throw appError.notFound('This invite link is not valid.');
    return row;
  }

  /** New link code (the old link stops working), new expiry, then the SMS. */
  private async sendInvite(
    userId: string,
    userName: string | null,
    guardianId: string,
    phone: string,
    guardianName: string,
  ): Promise<void> {
    const code = randomBytes(24).toString('base64url');
    await this.database.db
      .updateTable('guardians')
      .set({
        invite_token_hash: hashCode(code),
        invite_expires_at: sql<Date>`now() + make_interval(days => ${INVITE_LINK_DAYS})`,
        invited_at: sql<Date>`now()`,
      })
      .where('id', '=', guardianId)
      .execute();

    const who = userName?.trim() || 'Someone you know';
    const link = `${this.env.GUARDIAN_WEB_URL}/i/${code}`;
    await this.messages.sendSms(phone, {
      guardianId,
      kind: 'invite',
      text:
        `Hi ${guardianName}, ${who} added you as a guardian on Sarthi Rakshak. ` +
        `If they press SOS, you will get an SMS with their live location. Accept or decline: ${link}`,
    });
  }

  /** Counted before anything is saved, so a refused invite leaves nothing behind. */
  private countInvite(userId: string): Promise<void> {
    return this.rateLimiter.check(`invites:${userId}`, INVITES_PER_DAY, 24 * 3600);
  }

  private phoneHash(phone: string): string {
    return createHmac('sha256', Buffer.from(this.env.PHONE_HASH_KEY, 'base64'))
      .update(phone)
      .digest('hex');
  }
}
