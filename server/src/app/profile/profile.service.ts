import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  MAX_PHOTO_BYTES,
  type DeviceRequest,
  type Me,
  type UpdateProfileRequest,
  type UploadLink,
} from '@sarthi/shared';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import { StorageService, UPLOAD_LINK_SECONDS } from '../../storage/storage.module';
import { appError } from '../common/app-http';
import { AppSettings } from '../common/app-settings';

/** How long a photo link in a profile reply works. */
const PHOTO_LINK_SECONDS = 3600;
const PHOTO_TYPE = 'image/jpeg';

/** Every profile photo lives under the user's own folder, so a key proves whose it is. */
const photoFolder = (userId: string) => `users/${userId}/photo/`;

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly settings: AppSettings,
  ) {}

  /** Everything the app needs about the user (GET /v1/me and after every change). */
  async me(userId: string): Promise<Me> {
    const user = await this.database.db
      .selectFrom('users as u')
      .select((eb) => [
        'u.id',
        'u.name',
        'u.phone',
        'u.blood_group',
        'u.photo_key',
        'u.consent_at',
        eb
          .selectFrom('guardians as g')
          .select(eb.fn.countAll<string>().as('n'))
          .whereRef('g.user_id', '=', 'u.id')
          .where('g.invite_status', '<>', 'declined')
          .as('guardians_count'),
        eb
          .selectFrom('guardians as g')
          .select(eb.fn.countAll<string>().as('n'))
          .whereRef('g.user_id', '=', 'u.id')
          .where('g.invite_status', '=', 'accepted')
          .as('accepted_count'),
      ])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    if (!user) throw appError.notLoggedIn();
    return {
      id: user.id,
      name: user.name,
      phone: user.phone,
      bloodGroup: user.blood_group,
      photoUrl: user.photo_key
        ? await this.storage.downloadUrl(user.photo_key, PHOTO_LINK_SECONDS)
        : null,
      consentGiven: user.consent_at !== null,
      guardiansCount: Number(user.guardians_count ?? 0),
      acceptedGuardiansCount: Number(user.accepted_count ?? 0),
      rules: await this.settings.snapshot(),
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

  async update(userId: string, change: UpdateProfileRequest): Promise<Me> {
    await this.database.db
      .updateTable('users')
      .set({
        ...(change.name !== undefined && { name: change.name }),
        ...(change.bloodGroup !== undefined && { blood_group: change.bloodGroup }),
      })
      .where('id', '=', userId)
      .execute();
    return this.me(userId);
  }

  async photoUploadLink(userId: string, sizeBytes: number): Promise<UploadLink> {
    const key = `${photoFolder(userId)}${randomUUID()}.jpg`;
    const uploadUrl = await this.storage.uploadUrl(key, PHOTO_TYPE, sizeBytes);
    return {
      key,
      uploadUrl,
      headers: { 'Content-Type': PHOTO_TYPE, 'Content-Length': String(sizeBytes) },
      expiresAt: new Date(Date.now() + UPLOAD_LINK_SECONDS * 1000).toISOString(),
    };
  }

  /** Uses an uploaded photo as the profile photo and deletes the previous one. */
  async savePhoto(userId: string, key: string): Promise<Me> {
    if (!key.startsWith(photoFolder(userId)) || key.includes('..')) {
      throw appError.invalidInput('key: Not an upload link made for you.');
    }
    const file = await this.storage.info(key);
    if (!file) throw appError.invalidInput('key: Nothing was uploaded with this link yet.');
    if (file.contentType !== PHOTO_TYPE || file.sizeBytes > MAX_PHOTO_BYTES) {
      await this.storage.delete(key);
      throw appError.invalidInput('The photo must be a JPEG of at most 2 MB.');
    }

    const previous = await this.database.db
      .selectFrom('users')
      .select('photo_key')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    await this.database.db
      .updateTable('users')
      .set({ photo_key: key })
      .where('id', '=', userId)
      .execute();
    if (previous.photo_key && previous.photo_key !== key) {
      // Not fatal: the profile already points at the new photo.
      await this.storage.delete(previous.photo_key).catch((err: Error) => {
        this.logger.error(`Old photo not deleted: ${err.message}`);
      });
    }
    return this.me(userId);
  }

  /** Creates or updates this phone and links it to the current login session. */
  async saveDevice(userId: string, sessionId: string, device: DeviceRequest): Promise<void> {
    const values = {
      user_id: userId,
      model: device.model,
      android_version: device.androidVersion,
      app_version: device.appVersion,
      push_token: device.pushToken,
      permissions: device.permissions,
      battery_optimisation_off: device.batteryOptimisationOff,
      last_seen_at: sql<Date>`now()`,
    };
    await this.database.db.transaction().execute(async (trx) => {
      // The install id stays the same if someone else logs in on this phone: the phone moves
      // to the new user.
      await trx
        .insertInto('devices')
        .values({ id: device.deviceId, ...values })
        .onConflict((oc) => oc.column('id').doUpdateSet(values))
        .execute();
      // A push token belongs to one install; drop it from any other phone row that still has it.
      if (device.pushToken) {
        await trx
          .updateTable('devices')
          .set({ push_token: null })
          .where('push_token', '=', device.pushToken)
          .where('id', '<>', device.deviceId)
          .execute();
      }
      await trx
        .updateTable('user_sessions')
        .set({ device_id: device.deviceId })
        .where('id', '=', sessionId)
        .execute();
    });
  }
}
