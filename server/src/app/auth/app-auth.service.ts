import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LoginReply } from '@sarthi/shared';
import { sql } from 'kysely';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
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
    @Inject(ENV) private readonly env: Env,
  ) {}

  private readonly logger = new Logger('DevLogin');

  /** Firebase token → our user (created on first login) → a new session. */
  async login(firebaseIdToken: string): Promise<LoginReply> {
    const verified = await this.verifier.verify(firebaseIdToken);
    const phone = normaliseIndianMobile(verified);
    if (!phone) throw appError.invalidInput('Only Indian mobile numbers can be used.');
    return this.loginPhone(phone);
  }

  /**
   * Development only: the test code from .env (DEV_LOGIN_*), until DEV_LOGIN_UNTIL; any number unless DEV_LOGIN_PHONE is set.
   * Looks like an unknown route when it is off, so nothing reveals that it exists.
   */
  async devLogin(phoneInput: string, code: string): Promise<LoginReply> {
    const env = this.env;
    const on =
      env.NODE_ENV !== 'production' &&
      !!env.DEV_LOGIN_CODE &&
      !!env.DEV_LOGIN_UNTIL &&
      new Date(`${env.DEV_LOGIN_UNTIL}T23:59:59+05:30`).getTime() >= Date.now();
    if (!on) throw appError.notFound();
    const phone = normaliseIndianMobile(phoneInput);
    // DEV_LOGIN_PHONE set: only that number. Not set: any Indian mobile (sign up for testing).
    const allowed = env.DEV_LOGIN_PHONE ? normaliseIndianMobile(env.DEV_LOGIN_PHONE) : phone;
    const a = Buffer.from(code);
    const b = Buffer.from(env.DEV_LOGIN_CODE!);
    if (!phone || phone !== allowed || a.length !== b.length || !timingSafeEqual(a, b)) {
      throw appError.invalidInput('Wrong number or code.');
    }
    this.logger.warn(`Test login used for ${phone} (development only)`);
    return this.loginPhone(phone);
  }

  private async loginPhone(phone: string): Promise<LoginReply> {
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
