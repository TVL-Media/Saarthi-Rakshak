import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  AccessLogRequest,
  EvidenceUploadRequest,
  MAX_EVIDENCE_BYTES,
  SaveEvidenceRequest,
  SaveIncidentRequest,
  UpdateEvidenceRequest,
  UpdateIncidentRequest,
  VaultKey,
  VaultResetRequest,
  type AccessLogEntry,
  type EvidenceItem,
  type Incident,
  type UploadLink,
  type VaultResetResult,
  type VaultUsage,
} from '@sarthi/shared';
import { sql, type Selectable } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import type { EvidenceItemsTable } from '../../database/types';
import { StorageService, UPLOAD_LINK_SECONDS } from '../../storage/storage.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';
import { PlansService } from './plans';

const DAY_MS = 86_400_000;
/** Evidence files are encrypted on the phone: the server only ever sees bytes it cannot read. */
const LOCKED_TYPE = 'application/octet-stream';
/** How long a download link for an encrypted file works. */
const DOWNLOAD_LINK_SECONDS = 900;
const CLOCK_SLACK_MS = 60_000;

/** Storage key of one encrypted evidence file; the key proves whose it is. */
export const evidenceKey = (userId: string, itemId: string) =>
  `users/${userId}/vault/${itemId}.enc`;

type ItemRow = Selectable<EvidenceItemsTable>;

const toItem = (r: ItemRow): EvidenceItem => ({
  id: r.id,
  kind: r.kind,
  incidentId: r.incident_id,
  lockedFileKey: r.locked_file_key,
  lockedDetails: r.locked_details,
  sha256: r.sha256,
  capturedAt: new Date(r.captured_at).toISOString(),
  receivedAt: new Date(r.received_at).toISOString(),
  sizeBytes: Number(r.size_bytes),
  hasFile: r.storage_key !== null,
  uploaded: r.uploaded,
  hidden: r.hidden,
  deleteLockedUntil: new Date(r.delete_locked_until).toISOString(),
});

/**
 * The evidence vault (features 12–21). No backdoor: files, file keys and details are encrypted
 * on the phone; the vault key exists on the server only locked with the user's recovery phrase.
 * There is no admin route for any of this.
 */
@Injectable()
export class VaultService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly settings: AppSettings,
    private readonly rateLimiter: AppRateLimiter,
    private readonly plans: PlansService,
  ) {}

  // ---- Vault key (recovery) -----------------------------------------------------------------

  async setup(userId: string, key: VaultKey): Promise<void> {
    const values = {
      locked_key: key.lockedKey,
      kdf: JSON.stringify(key.kdf),
      check_value: key.checkValue,
    };
    // A new phrase replaces the old one (the phone re-locked the same vault key with it).
    await this.database.db
      .insertInto('vault_keys')
      .values({ user_id: userId, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
      .execute();
  }

  async recovery(userId: string): Promise<VaultKey> {
    await this.rateLimiter.check(`vault-recovery:${userId}`, 20, 3600);
    const row = await this.database.db
      .selectFrom('vault_keys')
      .select(['locked_key', 'kdf', 'check_value'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw appError.notFound('No vault has been set up yet.');
    return {
      lockedKey: row.locked_key,
      kdf: row.kdf as VaultKey['kdf'],
      checkValue: row.check_value,
    };
  }

  /**
   * Forgotten password: start again. The old evidence can never be opened without the old
   * password (nobody else has the key), so it is deleted with its incidents and the locked key.
   * Items still protected from deletion are not deleted now: they are marked, hidden, and deleted
   * by the hourly cleanup once their protection ends. The access history is kept.
   */
  async reset(userId: string): Promise<VaultResetResult> {
    const now = new Date();
    const { files, deleted, kept } = await this.database.db.transaction().execute(async (trx) => {
      const items = await trx
        .selectFrom('evidence_items')
        .select(['id', 'storage_key', 'delete_locked_until'])
        .where('user_id', '=', userId)
        .where('orphaned_at', 'is', null)
        .execute();
      const locked = items.filter((i) => new Date(i.delete_locked_until) > now);
      const free = items.filter((i) => new Date(i.delete_locked_until) <= now);
      if (free.length > 0) {
        await trx
          .deleteFrom('evidence_items')
          .where(
            'id',
            'in',
            free.map((i) => i.id),
          )
          .execute();
      }
      if (locked.length > 0) {
        await trx
          .updateTable('evidence_items')
          .set({ orphaned_at: now, incident_id: null, hidden: true })
          .where(
            'id',
            'in',
            locked.map((i) => i.id),
          )
          .execute();
      }
      // Incident titles were locked with the old key too.
      await trx.deleteFrom('evidence_incidents').where('user_id', '=', userId).execute();
      await trx.deleteFrom('vault_keys').where('user_id', '=', userId).execute();
      await trx
        .insertInto('evidence_access_log')
        .values({
          user_id: userId,
          item_id: null,
          incident_id: null,
          action: 'reset',
          device: null,
          at: now,
        })
        .execute();
      return {
        files: free.map((i) => i.storage_key).filter((k): k is string => k !== null),
        deleted: free.length,
        kept: locked,
      };
    });
    // The files go after the database change: a file left behind is harmless (unreadable and
    // unlisted); a listed item without its file would not be.
    for (const key of files) {
      await this.storage.delete(key).catch(() => undefined);
    }
    const last = kept.reduce<Date | null>((max, i) => {
      const d = new Date(i.delete_locked_until);
      return max === null || d > max ? d : max;
    }, null);
    return { deleted, keptLocked: kept.length, lockedUntil: last ? last.toISOString() : null };
  }

  // ---- Items ----------------------------------------------------------------------------------

  async uploadLink(userId: string, input: EvidenceUploadRequest): Promise<UploadLink> {
    await this.needVault(userId);
    await this.rateLimiter.check(`vault-upload:${userId}`, 300, 3600);
    const usage = await this.usage(userId);
    if (usage.usedBytes + input.sizeBytes > usage.limitBytes) {
      throw appError.limitReached(
        'Your evidence storage is full. Delete or export items to free space.',
      );
    }
    const key = evidenceKey(userId, input.itemId);
    const uploadUrl = await this.storage.uploadUrl(key, LOCKED_TYPE, input.sizeBytes);
    return {
      key,
      uploadUrl,
      headers: { 'Content-Type': LOCKED_TYPE, 'Content-Length': String(input.sizeBytes) },
      expiresAt: new Date(Date.now() + UPLOAD_LINK_SECONDS * 1000).toISOString(),
    };
  }

  /** Records an item. The same id again returns the saved item (fingerprint never changes). */
  async save(userId: string, input: SaveEvidenceRequest, device?: string): Promise<EvidenceItem> {
    await this.needVault(userId);
    const existing = await this.itemRow(input.id);
    if (existing) {
      if (existing.user_id !== userId) throw appError.conflict('This item id is already used.');
      if (existing.sha256 !== input.sha256) {
        throw appError.conflict('An item with this id has a different fingerprint.');
      }
      return toItem(existing);
    }
    const capturedAt = new Date(input.capturedAt);
    if (capturedAt.getTime() > Date.now() + CLOCK_SLACK_MS) {
      throw appError.invalidInput("capturedAt: Is in the future. Check the phone's clock.");
    }

    let incidentId = input.incidentId ?? null;
    if (input.sosId) incidentId = await this.sosIncident(userId, input.sosId, incidentId);
    if (incidentId) await this.ownIncident(userId, incidentId);

    const hasFile = input.kind !== 'detail';
    let size = 0;
    if (hasFile) {
      const file = await this.storage.info(evidenceKey(userId, input.id));
      if (!file) throw appError.invalidInput('Nothing was uploaded for this item yet.');
      if (file.contentType !== LOCKED_TYPE || file.sizeBytes > MAX_EVIDENCE_BYTES + 1024) {
        await this.storage.delete(evidenceKey(userId, input.id));
        throw appError.invalidInput('An evidence file must be encrypted and at most 200 MB.');
      }
      size = file.sizeBytes;
    }

    const lockDays = await this.settings.get('evidence.delete_lock_days');
    await this.database.db
      .insertInto('evidence_items')
      .values({
        id: input.id,
        user_id: userId,
        incident_id: incidentId,
        kind: input.kind,
        storage_key: hasFile ? evidenceKey(userId, input.id) : null,
        size_bytes: size,
        locked_file_key: input.lockedFileKey,
        locked_details: input.lockedDetails,
        sha256: input.sha256,
        captured_at: capturedAt,
        delete_locked_until: new Date(capturedAt.getTime() + lockDays * DAY_MS),
        uploaded: true,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await this.log(
      userId,
      [{ action: 'created', itemId: input.id, incidentId, at: new Date() }],
      device,
    );
    const saved = await this.itemRow(input.id);
    if (!saved || saved.user_id !== userId)
      throw appError.conflict('This item id is already used.');
    return toItem(saved);
  }

  async list(userId: string): Promise<EvidenceItem[]> {
    const rows = await this.database.db
      .selectFrom('evidence_items')
      .selectAll()
      .where('user_id', '=', userId)
      .where('orphaned_at', 'is', null) // from a reset vault: can never be opened
      .orderBy('captured_at', 'desc')
      .limit(5000)
      .execute();
    return rows.map(toItem);
  }

  async downloadUrl(userId: string, itemId: string): Promise<{ url: string; expiresAt: string }> {
    const item = await this.ownItem(userId, itemId);
    if (!item.storage_key) throw appError.notFound('This item has no file.');
    return {
      url: await this.storage.downloadUrl(item.storage_key, DOWNLOAD_LINK_SECONDS),
      expiresAt: new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000).toISOString(),
    };
  }

  async update(
    userId: string,
    itemId: string,
    change: UpdateEvidenceRequest,
  ): Promise<EvidenceItem> {
    const item = await this.ownItem(userId, itemId);
    if (change.incidentId) await this.ownIncident(userId, change.incidentId);
    await this.database.db
      .updateTable('evidence_items')
      .set({
        ...(change.incidentId !== undefined && { incident_id: change.incidentId }),
        ...(change.lockedDetails !== undefined && { locked_details: change.lockedDetails }),
        ...(change.hidden !== undefined && { hidden: change.hidden }),
      })
      .where('id', '=', itemId)
      .execute();
    const action =
      change.hidden === true ? 'hidden' : change.hidden === false ? 'unhidden' : 'edited';
    await this.log(userId, [{ action, itemId, incidentId: item.incident_id, at: new Date() }]);
    return toItem((await this.itemRow(itemId))!);
  }

  /** Refused while the item is locked: it protects against deleting under pressure. */
  async remove(userId: string, itemId: string): Promise<void> {
    const item = await this.ownItem(userId, itemId);
    const lockedUntil = new Date(item.delete_locked_until);
    if (lockedUntil > new Date()) {
      throw appError.conflict(
        `This item is locked until ${lockedUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}. You can hide it.`,
      );
    }
    if (item.storage_key) await this.storage.delete(item.storage_key);
    await this.database.db.deleteFrom('evidence_items').where('id', '=', itemId).execute();
    await this.log(userId, [
      { action: 'deleted', itemId, incidentId: item.incident_id, at: new Date() },
    ]);
  }

  async usage(userId: string): Promise<VaultUsage> {
    const row = await this.database.db
      .selectFrom('evidence_items')
      .select([
        sql<string>`coalesce(sum(size_bytes), 0)`.as('used'),
        sql<string>`count(*)`.as('items'),
      ])
      .where('user_id', '=', userId)
      .where('orphaned_at', 'is', null)
      .executeTakeFirstOrThrow();
    const limitMb = await this.plans.evidenceLimitMb(userId);
    return {
      usedBytes: Number(row.used),
      limitBytes: limitMb * 1024 * 1024,
      items: Number(row.items),
    };
  }

  // ---- Incidents ------------------------------------------------------------------------------

  async saveIncident(userId: string, input: SaveIncidentRequest): Promise<Incident> {
    await this.needVault(userId);
    const existing = await this.database.db
      .selectFrom('evidence_incidents')
      .select('user_id')
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (existing && existing.user_id !== userId)
      throw appError.conflict('This incident id is already used.');
    if (!existing) {
      const { count } = await this.database.db
        .selectFrom('evidence_incidents')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      if (Number(count) >= 500) throw appError.limitReached('You can keep up to 500 incidents.');
      await this.database.db
        .insertInto('evidence_incidents')
        .values({
          id: input.id,
          user_id: userId,
          kind: input.kind,
          locked_details: input.lockedDetails,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await this.log(userId, [{ action: 'created', incidentId: input.id, at: new Date() }]);
    }
    return this.incident(userId, input.id);
  }

  async updateIncident(
    userId: string,
    id: string,
    change: UpdateIncidentRequest,
  ): Promise<Incident> {
    await this.ownIncident(userId, id);
    await this.database.db
      .updateTable('evidence_incidents')
      .set({
        ...(change.kind !== undefined && { kind: change.kind }),
        ...(change.lockedDetails !== undefined && { locked_details: change.lockedDetails }),
      })
      .where('id', '=', id)
      .execute();
    await this.log(userId, [{ action: 'edited', incidentId: id, at: new Date() }]);
    return this.incident(userId, id);
  }

  async incidents(userId: string): Promise<Incident[]> {
    const rows = await this.incidentQuery(userId).orderBy('i.created_at', 'desc').execute();
    return rows.map(toIncident);
  }

  private async incident(userId: string, id: string): Promise<Incident> {
    const row = await this.incidentQuery(userId).where('i.id', '=', id).executeTakeFirst();
    if (!row) throw appError.notFound('Incident not found.');
    return toIncident(row);
  }

  private incidentQuery(userId: string) {
    return this.database.db
      .selectFrom('evidence_incidents as i')
      .select((eb) => [
        'i.id',
        'i.kind',
        'i.locked_details',
        'i.sos_event_id',
        'i.created_at',
        'i.updated_at',
        eb
          .selectFrom('evidence_items as e')
          .select(eb.fn.countAll<string>().as('n'))
          .whereRef('e.incident_id', '=', 'i.id')
          .as('items'),
      ])
      .where('i.user_id', '=', userId)
      .where('i.deleted_at', 'is', null);
  }

  /** The automatic "SOS on <date>" incident; the phone sends its locked title the first time. */
  private async sosIncident(userId: string, sosId: string, given: string | null): Promise<string> {
    const sos = await this.database.db
      .selectFrom('sos_events')
      .select('user_id')
      .where('id', '=', sosId)
      .executeTakeFirst();
    if (!sos || sos.user_id !== userId) throw appError.notFound('SOS not found.');
    const found = await this.database.db
      .selectFrom('evidence_incidents')
      .select('id')
      .where('user_id', '=', userId)
      .where('sos_event_id', '=', sosId)
      .executeTakeFirst();
    if (found) return found.id;
    if (!given) throw appError.invalidInput('incidentId: Create the SOS incident first.');
    await this.ownIncident(userId, given);
    await this.database.db
      .updateTable('evidence_incidents')
      .set({ sos_event_id: sosId, kind: 'sos' })
      .where('id', '=', given)
      .execute();
    return given;
  }

  // ---- Access history -------------------------------------------------------------------------

  async addLog(userId: string, input: AccessLogRequest): Promise<void> {
    await this.rateLimiter.check(`vault-log:${userId}`, 600, 3600);
    await this.log(
      userId,
      input.entries.map((e) => ({
        action: e.action,
        itemId: e.itemId ?? null,
        incidentId: e.incidentId ?? null,
        at: new Date(Math.min(new Date(e.at).getTime(), Date.now())),
      })),
      input.device,
    );
  }

  async accessLog(userId: string): Promise<AccessLogEntry[]> {
    const rows = await this.database.db
      .selectFrom('evidence_access_log')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('at', 'desc')
      .limit(500)
      .execute();
    return rows.map((r) => ({
      action: r.action as AccessLogEntry['action'],
      itemId: r.item_id,
      incidentId: r.incident_id,
      device: r.device,
      at: new Date(r.at).toISOString(),
    }));
  }

  private async log(
    userId: string,
    entries: { action: string; itemId?: string | null; incidentId?: string | null; at: Date }[],
    device?: string,
  ): Promise<void> {
    await this.database.db
      .insertInto('evidence_access_log')
      .values(
        entries.map((e) => ({
          user_id: userId,
          item_id: e.itemId ?? null,
          incident_id: e.incidentId ?? null,
          action: e.action,
          device: device ?? null,
          at: e.at,
        })),
      )
      .execute();
  }

  // ---- Checks ---------------------------------------------------------------------------------

  private async needVault(userId: string): Promise<void> {
    const row = await this.database.db
      .selectFrom('vault_keys')
      .select('user_id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw appError.conflict('Set up your vault first.');
  }

  private itemRow(id: string) {
    return this.database.db
      .selectFrom('evidence_items')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  private async ownItem(userId: string, id: string) {
    const item = await this.itemRow(id);
    // An item from a reset vault is gone for the user (it waits only for its protection to end).
    if (!item || item.user_id !== userId || item.orphaned_at)
      throw appError.notFound('Item not found.');
    return item;
  }

  private async ownIncident(userId: string, id: string): Promise<void> {
    const row = await this.database.db
      .selectFrom('evidence_incidents')
      .select('user_id')
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row || row.user_id !== userId) throw appError.notFound('Incident not found.');
  }
}

const toIncident = (r: {
  id: string;
  kind: Incident['kind'];
  locked_details: string;
  sos_event_id: string | null;
  created_at: Date;
  updated_at: Date;
  items: string | null;
}): Incident => ({
  id: r.id,
  kind: r.kind,
  lockedDetails: r.locked_details,
  sosId: r.sos_event_id,
  itemsCount: Number(r.items ?? 0),
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

const uuidPipe = (what: string) =>
  new ParseUUIDPipe({ exceptionFactory: () => appError.notFound(`${what} not found.`) });

@Controller('v1/vault')
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Post('setup')
  @HttpCode(204)
  async setup(@Req() req: AppRequest, @Body() body: unknown): Promise<void> {
    await this.vault.setup(req.user!.id, parseAppBody(VaultKey, body));
  }

  @Get('recovery')
  recovery(@Req() req: AppRequest): Promise<VaultKey> {
    return this.vault.recovery(req.user!.id);
  }

  @Post('reset')
  @HttpCode(200)
  reset(@Req() req: AppRequest, @Body() body: unknown): Promise<VaultResetResult> {
    parseAppBody(VaultResetRequest, body); // { confirm: "RESET" }
    return this.vault.reset(req.user!.id);
  }

  @Get('usage')
  usage(@Req() req: AppRequest): Promise<VaultUsage> {
    return this.vault.usage(req.user!.id);
  }

  @Post('items/upload')
  @HttpCode(200)
  upload(@Req() req: AppRequest, @Body() body: unknown): Promise<UploadLink> {
    return this.vault.uploadLink(req.user!.id, parseAppBody(EvidenceUploadRequest, body));
  }

  @Post('items')
  @HttpCode(200)
  save(@Req() req: AppRequest, @Body() body: unknown): Promise<EvidenceItem> {
    return this.vault.save(req.user!.id, parseAppBody(SaveEvidenceRequest, body));
  }

  @Get('items')
  list(@Req() req: AppRequest): Promise<EvidenceItem[]> {
    return this.vault.list(req.user!.id);
  }

  @Get('items/:id/download')
  download(@Req() req: AppRequest, @Param('id', uuidPipe('Item')) id: string) {
    return this.vault.downloadUrl(req.user!.id, id);
  }

  @Patch('items/:id')
  update(@Req() req: AppRequest, @Param('id', uuidPipe('Item')) id: string, @Body() body: unknown) {
    return this.vault.update(req.user!.id, id, parseAppBody(UpdateEvidenceRequest, body));
  }

  @Delete('items/:id')
  @HttpCode(204)
  async remove(@Req() req: AppRequest, @Param('id', uuidPipe('Item')) id: string): Promise<void> {
    await this.vault.remove(req.user!.id, id);
  }

  @Post('incidents')
  @HttpCode(200)
  saveIncident(@Req() req: AppRequest, @Body() body: unknown): Promise<Incident> {
    return this.vault.saveIncident(req.user!.id, parseAppBody(SaveIncidentRequest, body));
  }

  @Get('incidents')
  incidents(@Req() req: AppRequest): Promise<Incident[]> {
    return this.vault.incidents(req.user!.id);
  }

  @Patch('incidents/:id')
  updateIncident(
    @Req() req: AppRequest,
    @Param('id', uuidPipe('Incident')) id: string,
    @Body() body: unknown,
  ) {
    return this.vault.updateIncident(req.user!.id, id, parseAppBody(UpdateIncidentRequest, body));
  }

  @Post('access-log')
  @HttpCode(204)
  async addLog(@Req() req: AppRequest, @Body() body: unknown): Promise<void> {
    await this.vault.addLog(req.user!.id, parseAppBody(AccessLogRequest, body));
  }

  @Get('access-log')
  accessLog(@Req() req: AppRequest): Promise<AccessLogEntry[]> {
    return this.vault.accessLog(req.user!.id);
  }
}
