import { Body, Controller, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { Phase4Gate } from '../phase4/common';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('Not found.') });

const pairBody = z.object({
  id: z.uuid(),
  modelId: z.uuid(),
  deviceId: z.string().trim().min(3).max(80),
  firmware: z.string().trim().min(1).max(40),
});
const healthBody = z.object({ batteryPct: z.number().int().min(0).max(100).optional() });
const captureBody = z.object({
  id: z.uuid(),
  incidentId: z.uuid().nullish(),
  capturedAt: z.iso.datetime({ offset: true }),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/, { error: 'A SHA-256 hash is needed' }).nullish(),
  captureState: z.enum(['recording', 'paused', 'stopped']),
  accuracyM: z.number().min(0).max(100000).nullish(),
});

/** Compares dotted version numbers: 1.10.0 is newer than 1.2.0. */
export function versionAtLeast(have: string, need: string): boolean {
  const a = have.split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  const b = need.split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export const GLASSES_NOTICE =
  'Recording from smart glasses is never hidden. The glasses or the app show that recording is on. ' +
  'Only models in this list are supported, and the app never claims to work with every device.';

@Injectable()
export class GlassesService {
  constructor(private readonly database: DatabaseService, private readonly gate: Phase4Gate) {}

  private get db() {
    return this.database.db;
  }

  async models() {
    await this.gate.require('feature.smart_glasses');
    const r = await sql<{ id: string; manufacturer: string; model: string; min_firmware: string; capabilities: string[]; known_limits: string | null; supported: boolean }>`
      SELECT id, manufacturer, model, min_firmware, capabilities, known_limits, supported FROM glasses_models ORDER BY manufacturer, model`.execute(this.db);
    return {
      notice: GLASSES_NOTICE,
      items: r.rows.map((m) => ({ id: m.id, manufacturer: m.manufacturer, model: m.model, minFirmware: m.min_firmware, capabilities: m.capabilities, knownLimits: m.known_limits, supported: m.supported })),
    };
  }

  async mine(userId: string) {
    await this.gate.require('feature.smart_glasses');
    const r = await sql<{ id: string; device_id: string; firmware: string; status: string; block_reason: string | null; battery_pct: number | null; last_seen_at: Date | null; manufacturer: string | null; model: string | null; queued: string }>`
      SELECT g.id, g.device_id, g.firmware, g.status, g.block_reason, g.battery_pct, g.last_seen_at, m.manufacturer, m.model,
             (SELECT count(*) FROM glasses_captures c WHERE c.user_glasses_id = g.id AND c.upload_state = 'queued') AS queued
        FROM user_glasses g LEFT JOIN glasses_models m ON m.id = g.model_id
       WHERE g.user_id = ${userId} AND g.status <> 'unpaired' ORDER BY g.created_at DESC`.execute(this.db);
    return {
      items: r.rows.map((g) => ({
        id: g.id, deviceId: g.device_id, firmware: g.firmware, status: g.status, blockReason: g.block_reason,
        batteryPct: g.battery_pct, lastSeenAt: g.last_seen_at ? g.last_seen_at.toISOString() : null,
        name: `${g.manufacturer ?? ''} ${g.model ?? ''}`.trim(), queuedUploads: Number(g.queued),
      })),
    };
  }

  /** Checks the model and firmware. An unsupported device is saved as blocked, with the reason. */
  async pair(userId: string, input: z.infer<typeof pairBody>) {
    await this.gate.require('feature.smart_glasses');
    const m = await sql<{ supported: boolean; min_firmware: string; manufacturer: string; model: string }>`
      SELECT supported, min_firmware, manufacturer, model FROM glasses_models WHERE id = ${input.modelId}`.execute(this.db);
    if (!m.rows[0]) throw appError.notFound('This model is not in the supported list.');
    let status: 'paired' | 'blocked' = 'paired';
    let reason: string | null = null;
    if (!m.rows[0].supported) {
      status = 'blocked';
      reason = `${m.rows[0].manufacturer} ${m.rows[0].model} is not supported.`;
    } else if (!versionAtLeast(input.firmware, m.rows[0].min_firmware)) {
      status = 'blocked';
      reason = `Firmware ${input.firmware} is older than the supported ${m.rows[0].min_firmware}. Update the glasses first.`;
    }
    await sql`
      INSERT INTO user_glasses (id, user_id, model_id, device_id, firmware, status, block_reason, last_seen_at)
      VALUES (${input.id}, ${userId}, ${input.modelId}, ${input.deviceId}, ${input.firmware}, ${status}, ${reason}, now())
      ON CONFLICT (user_id, device_id) DO UPDATE
        SET model_id = EXCLUDED.model_id, firmware = EXCLUDED.firmware, status = EXCLUDED.status,
            block_reason = EXCLUDED.block_reason, last_seen_at = now()`.execute(this.db);
    return this.mine(userId);
  }

  async unpair(userId: string, id: string) {
    await this.gate.require('feature.smart_glasses');
    const r = await sql`UPDATE user_glasses SET status = 'unpaired' WHERE id = ${id} AND user_id = ${userId} RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.notFound('Device not found.');
    return this.mine(userId);
  }

  async health(userId: string, id: string, input: z.infer<typeof healthBody>) {
    await this.gate.require('feature.smart_glasses');
    const r = await sql`UPDATE user_glasses SET battery_pct = ${input.batteryPct ?? null}, last_seen_at = now()
                         WHERE id = ${id} AND user_id = ${userId} AND status = 'paired' RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.notFound('Device not found.');
    return { ok: true };
  }

  /** Metadata for one capture. The file itself goes to the Evidence Vault from the phone. */
  async capture(userId: string, glassesId: string, input: z.infer<typeof captureBody>) {
    await this.gate.require('feature.smart_glasses');
    const g = await sql`SELECT 1 FROM user_glasses WHERE id = ${glassesId} AND user_id = ${userId} AND status = 'paired'`.execute(this.db);
    if (g.rows.length === 0) throw appError.conflict('Only a paired, supported device can record.');
    if (input.incidentId) {
      const s = await sql`SELECT 1 FROM sos_events WHERE id = ${input.incidentId} AND user_id = ${userId}`.execute(this.db);
      if (s.rows.length === 0) throw appError.notFound('Incident not found.');
    }
    await sql`
      INSERT INTO glasses_captures (id, user_glasses_id, incident_id, captured_at, file_hash, capture_state, accuracy_m)
      VALUES (${input.id}, ${glassesId}, ${input.incidentId ?? null}, ${input.capturedAt}, ${input.fileHash ?? null}, ${input.captureState}, ${input.accuracyM ?? null})
      ON CONFLICT (id) DO NOTHING`.execute(this.db);
    return { ok: true };
  }

  async markUploaded(userId: string, captureId: string) {
    await this.gate.require('feature.smart_glasses');
    const r = await sql`
      UPDATE glasses_captures c SET upload_state = 'uploaded' FROM user_glasses g
       WHERE c.id = ${captureId} AND g.id = c.user_glasses_id AND g.user_id = ${userId} RETURNING c.id`.execute(this.db);
    if (r.rows.length === 0) throw appError.notFound('Capture not found.');
    return { ok: true };
  }

  // -- Admin: the device registry ------------------------------------------------------------

  async adminModels() {
    const r = await sql<{ id: string; manufacturer: string; model: string; min_firmware: string; sdk_version: string | null; capabilities: string[]; known_limits: string | null; supported: boolean; devices: string }>`
      SELECT m.*, (SELECT count(*) FROM user_glasses g WHERE g.model_id = m.id AND g.status = 'paired') AS devices
        FROM glasses_models m ORDER BY manufacturer, model`.execute(this.db);
    return { items: r.rows.map((m) => ({ id: m.id, manufacturer: m.manufacturer, model: m.model, minFirmware: m.min_firmware, sdkVersion: m.sdk_version, capabilities: m.capabilities, knownLimits: m.known_limits, supported: m.supported, pairedDevices: Number(m.devices) })) };
  }

  async saveModel(id: string | null, input: { manufacturer: string; model: string; minFirmware: string; sdkVersion?: string | null; capabilities: string[]; knownLimits?: string | null; supported: boolean }) {
    try {
      if (id) {
        const r = await sql`UPDATE glasses_models SET manufacturer = ${input.manufacturer}, model = ${input.model}, min_firmware = ${input.minFirmware},
          sdk_version = ${input.sdkVersion ?? null}, capabilities = ${input.capabilities}, known_limits = ${input.knownLimits ?? null}, supported = ${input.supported}
          WHERE id = ${id} RETURNING id`.execute(this.db);
        if (r.rows.length === 0) throw appError.notFound('Model not found.');
        return { id };
      }
      const r = await sql<{ id: string }>`INSERT INTO glasses_models (manufacturer, model, min_firmware, sdk_version, capabilities, known_limits, supported)
        VALUES (${input.manufacturer}, ${input.model}, ${input.minFirmware}, ${input.sdkVersion ?? null}, ${input.capabilities}, ${input.knownLimits ?? null}, ${input.supported})
        RETURNING id`.execute(this.db);
      return { id: r.rows[0].id };
    } catch (e) {
      if (e instanceof Error && 'status' in e) throw e;
      throw appError.conflict('That manufacturer and model are already listed.');
    }
  }
}

@Controller('v1/glasses')
export class GlassesController {
  constructor(private readonly service: GlassesService, private readonly limiter: AppRateLimiter) {}

  @Get('models')
  models() {
    return this.service.models();
  }

  @Get()
  mine(@Req() req: AppRequest) {
    return this.service.mine(req.user!.id);
  }

  @Post('pair')
  @HttpCode(200)
  async pair(@Req() req: AppRequest, @Body() body: unknown) {
    await this.limiter.check(`glasses-pair:${req.user!.id}`, 20, 3600);
    return this.service.pair(req.user!.id, parseAppBody(pairBody, body));
  }

  @Post(':id/unpair')
  @HttpCode(200)
  unpair(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.service.unpair(req.user!.id, id);
  }

  @Post(':id/health')
  @HttpCode(200)
  health(@Req() req: AppRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.health(req.user!.id, id, parseAppBody(healthBody, body));
  }

  @Post(':id/captures')
  @HttpCode(200)
  capture(@Req() req: AppRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.capture(req.user!.id, id, parseAppBody(captureBody, body));
  }

  @Post('captures/:id/uploaded')
  @HttpCode(200)
  uploaded(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.service.markUploaded(req.user!.id, id);
  }
}
