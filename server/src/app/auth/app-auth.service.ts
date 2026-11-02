import { Injectable } from '@nestjs/common';
import type { LoginReply } from '@sarthi/shared';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import { normaliseIndianMobile } from '../../users/phone';
import { appError } from '../common/app-http';
import { ProfileService } from '../profile/profile.service';
import { PhoneTokenVerifier } from './phone-token-verifier';
import { UserSessionsService } from './user-sessions.service';

@Injectable()
export class AppAuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly verifier: PhoneTokenVerifier,
    private readonly sessions: UserSessionsService,
    private readonly profile: ProfileService,
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
          .select('id')
          .where('phone', '=', phone)
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('users')
          .set({ last_seen_at: sql<Date>`now()` })
          .where('id', '=', user.id)
          .execute();
        const token = await this.sessions.start(user.id, trx);
        return { userId: user.id, isNewUser: inserted !== undefined, token };
      });

    return { token, user: await this.profile.me(userId), isNewUser };
  }
}
