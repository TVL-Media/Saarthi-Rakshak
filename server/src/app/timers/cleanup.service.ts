import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import { StorageService } from '../../storage/storage.module';
import { JobHandlers } from '../jobs/job-queue';

/** Rows handled per run of each step, so one run never takes long. */
const BATCH = 500;
/** Ended or expired login sessions are removed after this many days. */
export const OLD_SESSION_DAYS = 30;

/**
 * Every hour: deletes audio past its delete date (unless kept), location points past their
 * delete date (none until the client sets a retention period) and old ended sessions.
 * Guardian link rows stay: History needs them, and an expired link already shows nothing.
 */
@Injectable()
export class CleanupService implements OnModuleInit {
  private readonly logger = new Logger('Cleanup');

  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly handlers: JobHandlers,
  ) {}

  onModuleInit(): void {
    this.handlers.register('cleanup', () => this.run().then(() => undefined));
  }

  async run(): Promise<{ clips: number; points: number; sessions: number }> {
    const db = this.database.db;

    const clips = await db
      .selectFrom('media_clips')
      .select(['id', 'storage_key'])
      .where('deleted_at', 'is', null)
      .where('keep', '=', false)
      .where('delete_after', '<', sql<Date>`now()`)
      .limit(BATCH)
      .execute();
    let deletedClips = 0;
    for (const clip of clips) {
      try {
        await this.storage.delete(clip.storage_key);
        await db
          .updateTable('media_clips')
          .set({ deleted_at: sql<Date>`now()` })
          .where('id', '=', clip.id)
          .execute();
        deletedClips++;
      } catch (err) {
        this.logger.error(`Clip ${clip.id} not deleted: ${(err as Error).message}`);
      }
    }

    const points = await db
      .deleteFrom('location_points')
      .where(
        'id',
        'in',
        db
          .selectFrom('location_points')
          .select('id')
          .where('delete_after', '<', sql<Date>`now()`)
          .limit(BATCH * 10),
      )
      .executeTakeFirst();

    // Phase 2: SOS photos past their delete date (unless kept) …
    const photos = await db
      .selectFrom('sos_photos')
      .select(['id', 'storage_key'])
      .where('keep', '=', false)
      .where('delete_after', '<', sql<Date>`now()`)
      .limit(BATCH)
      .execute();
    for (const photo of photos) {
      try {
        await this.storage.delete(photo.storage_key);
        await db.deleteFrom('sos_photos').where('id', '=', photo.id).execute();
      } catch (err) {
        this.logger.error(`Photo ${photo.id} not deleted: ${(err as Error).message}`);
      }
    }
    // … and Rakshak applications rejected more than 90 days ago (with their documents).
    const oldApps = await db
      .selectFrom('rakshak_applications')
      .select(['id', 'documents'])
      .where('status', '=', 'rejected')
      .where('decided_at', '<', sql<Date>`now() - interval '90 days'`)
      .limit(BATCH)
      .execute();
    for (const app of oldApps) {
      for (const key of Object.values((app.documents ?? {}) as Record<string, string>)) {
        await this.storage.delete(key).catch(() => undefined);
      }
      await db.deleteFrom('rakshak_applications').where('id', '=', app.id).execute();
    }

    const sessions = await db
      .deleteFrom('user_sessions')
      .where((eb) =>
        eb.or([
          eb('ended_at', '<', sql<Date>`now() - make_interval(days => ${OLD_SESSION_DAYS})`),
          eb('expires_at', '<', sql<Date>`now() - make_interval(days => ${OLD_SESSION_DAYS})`),
        ]),
      )
      .executeTakeFirst();

    const result = {
      clips: deletedClips,
      points: Number(points.numDeletedRows),
      sessions: Number(sessions.numDeletedRows),
    };
    if (result.clips || result.points || result.sessions) {
      this.logger.log(
        `Deleted ${result.clips} clips, ${result.points} points, ${result.sessions} sessions`,
      );
    }
    return result;
  }
}
