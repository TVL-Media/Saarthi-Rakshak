import { Injectable, Logger } from '@nestjs/common';
import type { DeleteAccountRequest } from '@sarthi/shared';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import { deleteUserData } from '../../database/delete-user-data';
import { RedisService } from '../../redis/redis.module';
import { StorageService } from '../../storage/storage.module';
import { normaliseIndianMobile } from '../../users/phone';
import { PhoneTokenVerifier } from '../auth/phone-token-verifier';
import { appError } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { liveKeys } from '../locations/live-location';

/** The OTP for "Delete my account" must have been typed at most this long ago. */
export const DELETE_OTP_MAX_AGE_SECONDS = 5 * 60;
/** A phone clock (and Firebase's) may differ a little from ours. */
const CLOCK_SLACK_MS = 60_000;

/** "Delete my account" (Settings). */
@Injectable()
export class AccountService {
  private readonly logger = new Logger('DeleteAccount');

  constructor(
    private readonly database: DatabaseService,
    private readonly verifier: PhoneTokenVerifier,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  /**
   * Needs a fresh OTP for the same number. Refused during an SOS or journey. Removes personal data
   * (SOS events and alerts stay, without the person), the files in storage and the Firebase login.
   */
  async delete(userId: string, input: DeleteAccountRequest): Promise<void> {
    await this.rateLimiter.check(`delete-account:${userId}`, 5, 15 * 60);

    const login = await this.verifier.check(input.firebaseIdToken);
    const age = Date.now() - login.authTime.getTime();
    if (age > DELETE_OTP_MAX_AGE_SECONDS * 1000 + CLOCK_SLACK_MS) {
      throw appError.invalidInput('Please verify with a new OTP and try again.');
    }

    const result = await this.database.db.transaction().execute(async (trx) => {
      // The same locks as SOS and journey start, so neither can begin while the account goes.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'sos:' + userId}))`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'journey:' + userId}))`.execute(trx);

      const user = await trx
        .selectFrom('users')
        .select(['phone', 'photo_key'])
        .where('id', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!user) throw appError.notLoggedIn();
      if (normaliseIndianMobile(login.phone) !== user.phone) {
        throw appError.invalidInput('This OTP was for a different phone number.');
      }

      const activeSos = await trx
        .selectFrom('sos_events')
        .select('id')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      const activeJourney = await trx
        .selectFrom('journeys')
        .select('id')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (activeSos || activeJourney) {
        throw appError.conflict('End your SOS or journey first.');
      }

      const deleted = await deleteUserData(trx, userId);
      return { ...deleted, photoKey: user.photo_key };
    });

    // After the commit: files, live data and the Firebase login. A failure here is logged, never
    // undone; the cleanup job removes stray files later.
    const keys = [...result.mediaStorageKeys, ...(result.photoKey ? [result.photoKey] : [])];
    for (const key of keys) {
      await this.storage.delete(key).catch((err: Error) => {
        this.logger.error(`File not deleted (${key}): ${err.message}`);
      });
    }
    await this.redis.client
      .multi()
      .zrem(liveKeys.heartbeats, userId)
      .del(liveKeys.heartbeat(userId))
      .exec()
      .catch((err: Error) => this.logger.error(`Live data not cleared: ${err.message}`));
    await this.verifier.deleteLogin(login.uid).catch((err: Error) => {
      this.logger.error(`Firebase login not deleted: ${err.message}`);
    });
  }
}
