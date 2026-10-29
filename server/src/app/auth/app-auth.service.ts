import { Injectable } from '@nestjs/common';
import type { LoginReply, Me } from '@sarthi/shared';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import { normaliseIndianMobile } from '../../users/phone';
import { appError } from '../common/app-http';
import { PhoneTokenVerifier } from './phone-token-verifier';
import { UserSessionsService } from './user-sessions.service';

@Injectable()
export class AppAuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly verifier: PhoneTokenVerifier,
    private readonly sessions: UserSessionsService,
  ) {}

  /** Firebase token → our user (created on first login) → a new session. */
  async login(firebaseIdToken: string): Promise<LoginReply> {
    const verified = await this.verifier.verify(firebaseIdToken);
    const phone = normaliseIndianMobile(verified);
    if (!phone) throw appError.invalidInput('Only Indian mobile numbers can be used.');

    const { userId, isNewUser, token } = await this.database.db
      .transaction()
      .execute(async (trx) => {
        // Two logins at once for a new number: only one insert wins; both then read the same row.
        const inserted = await trx
          .insertInto('users')
          .values({ phone })
          .onConflict((oc) => oc.column('phone').doNothing())
          .returning('id')
          .executeTakeFirst();
        const user = await trx
          .selectFrom('users')
          .select(['id', 'status'])
          .where('phone', '=', phone)
          .executeTakeFirstOrThrow();
        if (user.status === 'blocked') throw appError.accountBlocked();

        await trx
          .updateTable('users')
          .set({ last_seen_at: sql<Date>`now()` })
          .where('id', '=', user.id)
          .execute();
        const token = await this.sessions.start(user.id, trx);
        return { userId: user.id, isNewUser: inserted !== undefined, token };
      });

    return { token, user: await this.me(userId), isNewUser };
  }

  async me(userId: string): Promise<Me> {
    const user = await this.database.db
      .selectFrom('users as u')
      .select((eb) => [
        'u.id',
        'u.name',
        'u.phone',
        'u.blood_group',
        'u.consent_at',
        eb
          .selectFrom('guardians as g')
          .select(eb.fn.countAll<string>().as('n'))
          .whereRef('g.user_id', '=', 'u.id')
          .where('g.invite_status', '<>', 'declined')
          .as('guardians_count'),
      ])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    if (!user) throw appError.notLoggedIn();
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      bloodGroup: user.blood_group,
      consentGiven: user.consent_at !== null,
      guardiansCount: Number(user.guardians_count ?? 0),
    };
  }

  async giveConsent(userId: string, version: string): Promise<Me> {
    await this.database.db
      .updateTable('users')
      .set({ consent_at: sql<Date>`now()`, consent_version: version })
      .where('id', '=', userId)
      .execute();
    return this.me(userId);
  }
}
