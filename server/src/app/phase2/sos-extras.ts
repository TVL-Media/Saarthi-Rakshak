import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  FalseAlarmRequest,
  MAX_SOS_PHOTO_BYTES,
  SaveSosPhotoRequest,
  SosPhotoUploadRequest,
  UpdateSosTriggerSettings,
  type SosPhoto,
  type SosTriggerSettings,
  type UploadLink,
} from '@sarthi/shared';
import { DatabaseService } from '../../database/database.module';
import { StorageService, UPLOAD_LINK_SECONDS } from '../../storage/storage.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';
import { LiveEvents } from '../live/live-events';

const DAY_MS = 86_400_000;
const PHOTO_TYPE = 'image/jpeg';
const CLOCK_SLACK_MS = 60_000;

export const DEFAULT_TRIGGERS: SosTriggerSettings = {
  shakeMode: 'off',
  voiceOn: false,
  driveMode: false,
  fallOn: false,
  quietCountdown: false,
  journeySosButton: true,
};

/** Storage key of one SOS photo; the key proves whose SOS it belongs to. */
export const sosPhotoKey = (userId: string, sosId: string, photoId: string) =>
  `users/${userId}/sos-photos/${sosId}/${photoId}.jpg`;

/** Shake, voice, drive, fall and discreet settings (features 1, 2, 4, 5, 6) and false alarms. */
@Injectable()
export class SosTriggersService {
  constructor(private readonly database: DatabaseService) {}

  async get(userId: string): Promise<SosTriggerSettings> {
    const row = await this.database.db
      .selectFrom('sos_trigger_settings')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) return DEFAULT_TRIGGERS;
    return {
      shakeMode: row.shake_mode,
      voiceOn: row.voice_on,
      driveMode: row.drive_mode,
      fallOn: row.fall_on,
      quietCountdown: row.quiet_countdown,
      journeySosButton: row.journey_sos_button,
    };
  }

  async update(userId: string, change: UpdateSosTriggerSettings): Promise<SosTriggerSettings> {
    const next = { ...(await this.get(userId)), ...stripUndefined(change) };
    const values = {
      shake_mode: next.shakeMode,
      voice_on: next.voiceOn,
      drive_mode: next.driveMode,
      fall_on: next.fallOn,
      quiet_countdown: next.quietCountdown,
      journey_sos_button: next.journeySosButton,
    };
    await this.database.db
      .insertInto('sos_trigger_settings')
      .values({ user_id: userId, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
      .execute();
    return next;
  }

  /** A cancelled detection countdown: counted (to tune thresholds), nothing else happens. */
  async falseAlarm(userId: string, input: FalseAlarmRequest): Promise<void> {
    await this.database.db
      .insertInto('sos_false_alarms')
      .values({ id: input.id, user_id: userId, trigger: input.trigger })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
}

/**
 * Photos at SOS start (feature 3): taken while the SOS screen is open, shown to the guardians
 * on the live page, never to admins; deleted with the SOS audio unless the user keeps them.
 */
@Injectable()
export class SosPhotosService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly settings: AppSettings,
    private readonly rateLimiter: AppRateLimiter,
    private readonly events: LiveEvents,
  ) {}

  async uploadLink(
    userId: string,
    sosId: string,
    input: SosPhotoUploadRequest,
  ): Promise<UploadLink> {
    await this.ownActiveSos(userId, sosId);
    await this.rateLimiter.check(`sos-photo:${userId}`, 30, 3600);
    const key = sosPhotoKey(userId, sosId, input.photoId);
    const uploadUrl = await this.storage.uploadUrl(key, PHOTO_TYPE, input.sizeBytes);
    return {
      key,
      uploadUrl,
      headers: { 'Content-Type': PHOTO_TYPE, 'Content-Length': String(input.sizeBytes) },
      expiresAt: new Date(Date.now() + UPLOAD_LINK_SECONDS * 1000).toISOString(),
    };
  }

  async save(userId: string, sosId: string, input: SaveSosPhotoRequest): Promise<SosPhoto> {
    const sos = await this.ownActiveSos(userId, sosId);
    const existing = await this.row(input.photoId);
    if (existing) {
      if (existing.user_id !== userId || existing.sos_event_id !== sosId) {
        throw appError.conflict('This photo id is already used.');
      }
      return toPhoto(existing);
    }

    const takenAt = new Date(input.takenAt);
    if (
      takenAt.getTime() < new Date(sos.started_at).getTime() - CLOCK_SLACK_MS ||
      takenAt.getTime() > Date.now() + CLOCK_SLACK_MS
    ) {
      throw appError.invalidInput('takenAt: Must be during the SOS.');
    }

    const pairs =
      sos.rules?.['sos.photo_pairs_max'] ?? (await this.settings.get('sos.photo_pairs_max'));
    const { count } = await this.database.db
      .selectFrom('sos_photos')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('sos_event_id', '=', sosId)
      .executeTakeFirstOrThrow();
    if (Number(count) >= pairs * 2) {
      throw appError.limitReached(`At most ${pairs} pairs of photos per SOS.`);
    }

    const key = sosPhotoKey(userId, sosId, input.photoId);
    const file = await this.storage.info(key);
    if (!file) throw appError.invalidInput('Nothing was uploaded for this photo yet.');
    if (file.contentType !== PHOTO_TYPE || file.sizeBytes > MAX_SOS_PHOTO_BYTES) {
      await this.storage.delete(key);
      throw appError.invalidInput('A photo must be a JPEG of at most 1 MB.');
    }

    const days =
      sos.rules?.['audio.auto_delete_days'] ?? (await this.settings.get('audio.auto_delete_days'));
    await this.database.db
      .insertInto('sos_photos')
      .values({
        id: input.photoId,
        user_id: userId,
        sos_event_id: sosId,
        camera: input.camera,
        storage_key: key,
        size_bytes: file.sizeBytes,
        taken_at: takenAt,
        delete_after: new Date(takenAt.getTime() + days * DAY_MS),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await this.events.changed('sos', sosId);
    const saved = await this.row(input.photoId);
    if (!saved || saved.user_id !== userId)
      throw appError.conflict('This photo id is already used.');
    return toPhoto(saved);
  }

  async list(userId: string, sosId: string): Promise<SosPhoto[]> {
    const rows = await this.database.db
      .selectFrom('sos_photos')
      .selectAll()
      .where('user_id', '=', userId)
      .where('sos_event_id', '=', sosId)
      .orderBy('taken_at')
      .execute();
    return rows.map(toPhoto);
  }

  /** Photos can be added while the SOS is on (and a few minutes after a phone was offline). */
  private async ownActiveSos(userId: string, sosId: string) {
    const sos = await this.database.db
      .selectFrom('sos_events')
      .select(['user_id', 'status', 'is_test', 'started_at', 'ended_at', 'rules'])
      .where('id', '=', sosId)
      .executeTakeFirst();
    if (!sos || sos.user_id !== userId) throw appError.notFound('SOS not found.');
    if (sos.is_test) throw appError.conflict('A test SOS has no photos.');
    const endedLongAgo =
      sos.status !== 'active' &&
      (!sos.ended_at || new Date(sos.ended_at).getTime() < Date.now() - 10 * 60_000);
    if (endedLongAgo) throw appError.conflict('This SOS has ended.');
    return sos;
  }

  private row(id: string) {
    return this.database.db
      .selectFrom('sos_photos')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }
}

const toPhoto = (p: {
  id: string;
  camera: 'front' | 'back';
  taken_at: Date | string;
  keep: boolean;
  delete_after: Date | string;
}): SosPhoto => ({
  id: p.id,
  camera: p.camera,
  takenAt: new Date(p.taken_at).toISOString(),
  keep: p.keep,
  deleteAfter: new Date(p.delete_after).toISOString(),
});

export function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const uuidPipe = (what: string) =>
  new ParseUUIDPipe({ exceptionFactory: () => appError.notFound(`${what} not found.`) });

@Controller('v1')
export class SosExtrasController {
  constructor(
    private readonly triggers: SosTriggersService,
    private readonly photos: SosPhotosService,
  ) {}

  @Get('me/sos-triggers')
  getTriggers(@Req() req: AppRequest): Promise<SosTriggerSettings> {
    return this.triggers.get(req.user!.id);
  }

  @Put('me/sos-triggers')
  putTriggers(@Req() req: AppRequest, @Body() body: unknown): Promise<SosTriggerSettings> {
    return this.triggers.update(req.user!.id, parseAppBody(UpdateSosTriggerSettings, body));
  }

  @Post('sos/false-alarms')
  @HttpCode(204)
  async falseAlarm(@Req() req: AppRequest, @Body() body: unknown): Promise<void> {
    await this.triggers.falseAlarm(req.user!.id, parseAppBody(FalseAlarmRequest, body));
  }

  @Post('sos/:id/photo-upload')
  @HttpCode(200)
  photoUpload(
    @Req() req: AppRequest,
    @Param('id', uuidPipe('SOS')) id: string,
    @Body() body: unknown,
  ): Promise<UploadLink> {
    return this.photos.uploadLink(req.user!.id, id, parseAppBody(SosPhotoUploadRequest, body));
  }

  @Post('sos/:id/photos')
  @HttpCode(200)
  savePhoto(
    @Req() req: AppRequest,
    @Param('id', uuidPipe('SOS')) id: string,
    @Body() body: unknown,
  ): Promise<SosPhoto> {
    return this.photos.save(req.user!.id, id, parseAppBody(SaveSosPhotoRequest, body));
  }

  @Get('sos/:id/photos')
  listPhotos(
    @Req() req: AppRequest,
    @Param('id', uuidPipe('SOS')) id: string,
  ): Promise<SosPhoto[]> {
    return this.photos.list(req.user!.id, id);
  }
}
