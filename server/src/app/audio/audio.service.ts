import { Injectable } from '@nestjs/common';
import {
  MAX_CLIP_BYTES,
  type AudioClip,
  type ClipLink,
  type ClipUploadRequest,
  type SaveClipRequest,
  type UploadLink,
} from '@sarthi/shared';
import { DatabaseService } from '../../database/database.module';
import { StorageService, UPLOAD_LINK_SECONDS } from '../../storage/storage.module';
import { appError } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';

/** Clips are encrypted on the phone: the server only ever sees bytes it cannot read. */
export const CLIP_TYPE = 'application/octet-stream';
/** Upload links per user per hour (an SOS records a clip every 30 seconds). */
export const CLIP_UPLOADS_PER_HOUR = 300;
/** How long a play link works. */
export const PLAY_LINK_SECONDS = 600;
/** A phone clock may differ a little from ours. */
const CLOCK_SLACK_MS = 60_000;

const DAY_MS = 86_400_000;

/** Storage key of one clip; the key proves whose clip it is. */
export const clipKey = (userId: string, sosId: string, clipId: string) =>
  `users/${userId}/audio/${sosId}/${clipId}.enc`;

interface ClipRow {
  id: string;
  recorded_at: Date | null;
  created_at: Date;
  duration_s: number | null;
  keep: boolean;
  delete_after: Date | string;
}

const toClip = (c: ClipRow): AudioClip => ({
  id: c.id,
  recordedAt: (c.recorded_at ?? c.created_at).toISOString(),
  durationS: c.duration_s,
  keep: c.keep,
  deleteAfter: new Date(c.delete_after).toISOString(),
});

/** SOS audio clips: upload, record, keep, play (owner only; admins never). */
@Injectable()
export class AudioService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly settings: AppSettings,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  async uploadLink(userId: string, sosId: string, input: ClipUploadRequest): Promise<UploadLink> {
    await this.ownSos(userId, sosId);
    await this.rateLimiter.check(`clip-upload:${userId}`, CLIP_UPLOADS_PER_HOUR, 3600);
    const key = clipKey(userId, sosId, input.clipId);
    const uploadUrl = await this.storage.uploadUrl(key, CLIP_TYPE, input.sizeBytes);
    return {
      key,
      uploadUrl,
      headers: { 'Content-Type': CLIP_TYPE, 'Content-Length': String(input.sizeBytes) },
      expiresAt: new Date(Date.now() + UPLOAD_LINK_SECONDS * 1000).toISOString(),
    };
  }

  /** Records an uploaded clip. The same clip id again returns the saved clip. */
  async save(userId: string, sosId: string, input: SaveClipRequest): Promise<AudioClip> {
    const sos = await this.ownSos(userId, sosId);

    const existing = await this.clipRow(input.clipId);
    if (existing) {
      if (existing.user_id !== userId || existing.sos_event_id !== sosId) {
        throw appError.conflict('This clip id is already used.');
      }
      return toClip(existing);
    }

    const recordedAt = new Date(input.recordedAt);
    const startedAt = new Date(sos.started_at).getTime();
    if (
      recordedAt.getTime() < startedAt - CLOCK_SLACK_MS ||
      recordedAt.getTime() > Date.now() + CLOCK_SLACK_MS
    ) {
      throw appError.invalidInput('recordedAt: Must be during the SOS.');
    }

    const key = clipKey(userId, sosId, input.clipId);
    const file = await this.storage.info(key);
    if (!file) throw appError.invalidInput('Nothing was uploaded for this clip yet.');
    if (file.contentType !== CLIP_TYPE || file.sizeBytes > MAX_CLIP_BYTES) {
      await this.storage.delete(key);
      throw appError.invalidInput('A clip must be an encrypted file of at most 2 MB.');
    }

    // Kept for the number of days in the rules copied onto the SOS.
    const days =
      sos.rules?.['audio.auto_delete_days'] ?? (await this.settings.get('audio.auto_delete_days'));
    await this.database.db
      .insertInto('media_clips')
      .values({
        id: input.clipId,
        user_id: userId,
        sos_event_id: sosId,
        storage_key: key,
        duration_s: input.durationS,
        size_bytes: file.sizeBytes,
        recorded_at: recordedAt,
        delete_after: new Date(recordedAt.getTime() + days * DAY_MS),
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    const saved = await this.clipRow(input.clipId);
    if (!saved || saved.user_id !== userId || saved.sos_event_id !== sosId) {
      throw appError.conflict('This clip id is already used.');
    }
    return toClip(saved);
  }

  async keep(userId: string, clipId: string, keep: boolean): Promise<AudioClip> {
    const clip = await this.ownClip(userId, clipId);
    await this.database.db
      .updateTable('media_clips')
      .set({ keep })
      .where('id', '=', clip.id)
      .execute();
    return toClip({ ...clip, keep });
  }

  /** A short link to the encrypted file, for the phone that recorded it to decrypt and play. */
  async playLink(userId: string, clipId: string): Promise<ClipLink> {
    const clip = await this.ownClip(userId, clipId);
    return {
      url: await this.storage.downloadUrl(clip.storage_key, PLAY_LINK_SECONDS),
      expiresAt: new Date(Date.now() + PLAY_LINK_SECONDS * 1000).toISOString(),
    };
  }

  /** A real SOS of this user (not a test, not cancelled in the countdown). */
  private async ownSos(userId: string, sosId: string) {
    const sos = await this.database.db
      .selectFrom('sos_events')
      .select(['id', 'started_at', 'rules', 'is_test', 'status'])
      .where('id', '=', sosId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!sos) throw appError.notFound('SOS not found.');
    if (sos.is_test || sos.status === 'cancelled') {
      throw appError.conflict('Audio is only recorded during a real SOS.');
    }
    return sos;
  }

  private clipRow(id: string) {
    return this.database.db
      .selectFrom('media_clips')
      .select([
        'id',
        'user_id',
        'sos_event_id',
        'storage_key',
        'recorded_at',
        'created_at',
        'duration_s',
        'keep',
        'delete_after',
        'deleted_at',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  private async ownClip(userId: string, clipId: string) {
    const clip = await this.clipRow(clipId);
    if (!clip || clip.user_id !== userId || clip.deleted_at) {
      throw appError.notFound('Clip not found.');
    }
    return clip;
  }
}
