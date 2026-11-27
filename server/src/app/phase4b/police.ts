import { Controller, Get, Inject, Injectable, Logger, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import { appError, type AppRequest } from '../common/app-http';
import { AppSettings } from '../common/app-settings';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('Not found.') });

export const PAYLOAD_VERSION = 'erss-v1';
export const MAX_ATTEMPTS = 3;
export const ALLOWED_PAYLOAD_FIELDS = ['eventId', 'callbackNumber', 'location', 'accuracyM', 'time'] as const;

export type HandoffStatus = 'pending' | 'sent' | 'accepted' | 'rejected' | 'timed_out' | 'fallback' | 'acknowledged';

/** What the phone shows. It never claims dispatch or acknowledgement the authority did not confirm. */
export function handoffText(status: HandoffStatus | null): { label: string; detail: string } {
  switch (status) {
    case 'pending':
      return { label: 'Sending to the authority…', detail: 'Your guardians are being alerted at the same time. You can call 112 now.' };
    case 'sent':
      return { label: 'Sent, waiting for the authority', detail: 'Delivery is not confirmed yet. Call 112 if you need help now.' };
    case 'accepted':
      return { label: 'Received by the authority’s system', detail: 'This does not mean police are on the way. Call 112 if you need help now.' };
    case 'acknowledged':
      return { label: 'Acknowledged by the authority', detail: 'Confirmed by the authority. Stay on the line if they call you.' };
    case 'rejected':
      return { label: 'The authority did not accept it', detail: 'Call 112 yourself. Your guardians were still alerted.' };
    case 'timed_out':
      return { label: 'Could not be delivered', detail: 'Call 112 yourself. Your guardians were still alerted.' };
    case 'fallback':
      return { label: 'Call 112 yourself', detail: 'There is no police connection for this SOS. Your guardians were still alerted.' };
    default:
      return { label: 'Call 112 yourself', detail: 'No police connection is set up. Your guardians were still alerted.' };
  }
}

/** Keeps only the allowed fields (the minimal payload). */
export function minimalPayload(
  full: Record<string, unknown>,
  permitted: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ALLOWED_PAYLOAD_FIELDS) if (permitted.includes(f) && full[f] !== undefined) out[f] = full[f];
  return out;
}

interface EndpointRow {
  id: string; name: string; kind: string; jurisdiction: string; environment: string; base_url: string;
  credential_env: string; credential_expires_at: Date | null; permitted_ops: string[]; permitted_fields: string[];
  enabled: boolean; sandbox_passed: boolean;
}

@Injectable()
export class PoliceHandoffService {
  private readonly logger = new Logger(PoliceHandoffService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Usable only when approved: enabled, not expired, and a production endpoint has passed sandbox tests. */
  private async liveEndpoints(): Promise<EndpointRow[]> {
    const r = await sql<EndpointRow>`
      SELECT * FROM authority_endpoints
       WHERE kind = 'erss' AND enabled
         AND (environment = 'sandbox' OR sandbox_passed)
         AND (credential_expires_at IS NULL OR credential_expires_at > now())
         AND 'send_event' = ANY (permitted_ops)
         AND environment = ${this.env.NODE_ENV === 'production' ? 'production' : 'sandbox'}`.execute(this.db);
    return r.rows;
  }

  /**
   * Called after an SOS starts. It never throws and never delays the SOS: guardian alerts and
   * Call 112 carry on whatever happens here.
   */
  async onSos(userId: string, sosId: string): Promise<void> {
    try {
      if ((await this.settings.get('feature.police_handoff')) < 1) return;
      const endpoints = await this.liveEndpoints();
      const u = await sql<{ phone: string }>`SELECT phone FROM users WHERE id = ${userId}`.execute(this.db);
      const loc = await sql<{ lat: number; lng: number; accuracy_m: number | null; recorded_at: Date }>`
        SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, accuracy_m, recorded_at
          FROM location_points WHERE sos_event_id = ${sosId} ORDER BY recorded_at DESC LIMIT 1`.execute(this.db);
      if (endpoints.length === 0) {
        await sql`INSERT INTO handoff_attempts (sos_id, idempotency_key, status, error_type, payload_version, payload)
                  VALUES (${sosId}, ${`erss:${sosId}:none`}, 'fallback', 'no_endpoint', ${PAYLOAD_VERSION}, '{}')
                  ON CONFLICT (idempotency_key) DO NOTHING`.execute(this.db);
        return;
      }
      for (const ep of endpoints) {
        const full: Record<string, unknown> = {
          eventId: sosId,
          callbackNumber: u.rows[0]?.phone,
          location: loc.rows[0] ? { lat: loc.rows[0].lat, lng: loc.rows[0].lng } : undefined,
          accuracyM: loc.rows[0]?.accuracy_m ?? undefined,
          time: new Date().toISOString(),
        };
        const payload = minimalPayload(full, ep.permitted_fields);
        const key = `erss:${sosId}:${ep.id}`;
        const ins = await sql<{ id: string }>`
          INSERT INTO handoff_attempts (sos_id, endpoint_id, idempotency_key, status, payload_version, payload)
          VALUES (${sosId}, ${ep.id}, ${key}, 'pending', ${PAYLOAD_VERSION}, ${JSON.stringify(payload)})
          ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`.execute(this.db);
        // A repeat of the same SOS finds the row already there and sends nothing again.
        if (ins.rows[0]) void this.deliver(ins.rows[0].id).catch((e) => this.logger.error(`Handoff failed: ${(e as Error).message}`));
      }
    } catch (e) {
      this.logger.error(`Handoff not started: ${(e as Error).message}`);
    }
  }

  /** Sends one attempt, with limited retries and a dead-letter state. Exposed for tests. */
  async deliver(attemptId: string, delaysMs: number[] = [1000, 3000]): Promise<void> {
    const a = await sql<{ payload: Record<string, unknown>; idempotency_key: string; endpoint_id: string }>`
      SELECT payload, idempotency_key, endpoint_id FROM handoff_attempts WHERE id = ${attemptId} AND status IN ('pending','sent')`.execute(this.db);
    if (!a.rows[0]) return;
    const e = await sql<EndpointRow>`SELECT * FROM authority_endpoints WHERE id = ${a.rows[0].endpoint_id}`.execute(this.db);
    const ep = e.rows[0];
    if (!ep) return;
    const token = process.env[ep.credential_env];
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      await sql`UPDATE handoff_attempts SET attempts = ${n}, status = 'sent', updated_at = now() WHERE id = ${attemptId}`.execute(this.db);
      try {
        const res = await fetch(`${ep.base_url.replace(/\/$/, '')}/events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': a.rows[0].idempotency_key,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ version: PAYLOAD_VERSION, ...a.rows[0].payload }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const body = (await res.json().catch(() => ({}))) as { reference?: string };
          await sql`UPDATE handoff_attempts SET status = 'accepted', response_ref = ${body.reference ? String(body.reference).slice(0, 80) : null}, updated_at = now() WHERE id = ${attemptId}`.execute(this.db);
          return;
        }
        if (res.status >= 400 && res.status < 500) {
          await sql`UPDATE handoff_attempts SET status = 'rejected', error_type = ${`http_${res.status}`}, updated_at = now() WHERE id = ${attemptId}`.execute(this.db);
          return; // retrying a rejected payload cannot help
        }
        await sql`UPDATE handoff_attempts SET error_type = ${`http_${res.status}`} WHERE id = ${attemptId}`.execute(this.db);
      } catch (err) {
        await sql`UPDATE handoff_attempts SET error_type = ${(err as Error).name === 'TimeoutError' ? 'timeout' : 'network'} WHERE id = ${attemptId}`.execute(this.db);
      }
      if (n < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, delaysMs[n - 1] ?? 1000));
    }
    await sql`UPDATE handoff_attempts SET status = 'timed_out', dead_letter = true, updated_at = now() WHERE id = ${attemptId}`.execute(this.db);
  }

  /** What the SOS screen shows. The owner can see only their own SOS. */
  async statusFor(userId: string, sosId: string) {
    const own = await sql`SELECT 1 FROM sos_events WHERE id = ${sosId} AND user_id = ${userId}`.execute(this.db);
    if (own.rows.length === 0) throw appError.notFound('SOS not found.');
    const on = (await this.settings.get('feature.police_handoff')) >= 1;
    const r = await sql<{ status: HandoffStatus; updated_at: Date }>`
      SELECT status, updated_at FROM handoff_attempts WHERE sos_id = ${sosId} ORDER BY created_at DESC LIMIT 1`.execute(this.db);
    const status = on ? (r.rows[0]?.status ?? null) : null;
    return { enabled: on, status, ...handoffText(status), call: '112', updatedAt: r.rows[0]?.updated_at.toISOString() ?? null };
  }

  // -- Admin -----------------------------------------------------------------------------------

  private endpointOut(e: EndpointRow & { last_health_at?: Date | null; last_health_ok?: boolean | null; credential_owner?: string }) {
    return {
      id: e.id, name: e.name, kind: e.kind, jurisdiction: e.jurisdiction, environment: e.environment, baseUrl: e.base_url,
      credentialEnv: e.credential_env, // the name of the secret only, never its value
      credentialConfigured: Boolean(process.env[e.credential_env]),
      credentialOwner: e.credential_owner ?? null,
      credentialExpiresAt: e.credential_expires_at ? e.credential_expires_at.toISOString() : null,
      permittedOps: e.permitted_ops, permittedFields: e.permitted_fields, enabled: e.enabled, sandboxPassed: e.sandbox_passed,
      lastHealthAt: e.last_health_at ? e.last_health_at.toISOString() : null, lastHealthOk: e.last_health_ok ?? null,
    };
  }

  async endpoints() {
    const r = await sql<EndpointRow & { last_health_at: Date | null; last_health_ok: boolean | null; credential_owner: string }>`SELECT * FROM authority_endpoints ORDER BY created_at DESC`.execute(this.db);
    return { items: r.rows.map((e) => this.endpointOut(e)) };
  }

  async createEndpoint(i: { name: string; kind: 'erss' | 'cctns'; jurisdiction: string; environment: 'sandbox' | 'production'; baseUrl: string; credentialEnv: string; credentialOwner: string; credentialExpiresAt?: string | null; permittedOps: string[]; permittedFields: string[] }) {
    if (i.environment === 'production' && !i.baseUrl.startsWith('https://')) throw appError.invalidInput('A production endpoint must use https.');
    const bad = i.permittedFields.filter((f) => !(ALLOWED_PAYLOAD_FIELDS as readonly string[]).includes(f) && i.kind === 'erss');
    if (bad.length > 0) throw appError.invalidInput(`Not an allowed field: ${bad.join(', ')}`);
    const r = await sql<{ id: string }>`
      INSERT INTO authority_endpoints (name, kind, jurisdiction, environment, base_url, credential_env, credential_owner, credential_expires_at, permitted_ops, permitted_fields)
      VALUES (${i.name}, ${i.kind}, ${i.jurisdiction}, ${i.environment}, ${i.baseUrl}, ${i.credentialEnv}, ${i.credentialOwner}, ${i.credentialExpiresAt ?? null}, ${i.permittedOps}, ${i.permittedFields})
      RETURNING id`.execute(this.db);
    return { id: r.rows[0].id };
  }

  async setEnabled(id: string, enabled: boolean) {
    const r = await sql<EndpointRow>`SELECT * FROM authority_endpoints WHERE id = ${id}`.execute(this.db);
    const e = r.rows[0];
    if (!e) throw appError.notFound('Endpoint not found.');
    if (enabled) {
      if (e.environment === 'production' && !e.sandbox_passed) throw appError.conflict('Production stays off until the sandbox tests pass.');
      if (e.credential_expires_at && e.credential_expires_at.getTime() < Date.now()) throw appError.conflict('The credential has expired.');
      if (!process.env[e.credential_env]) throw appError.conflict(`The secret ${e.credential_env} is not set on the server.`);
    }
    await sql`UPDATE authority_endpoints SET enabled = ${enabled} WHERE id = ${id}`.execute(this.db);
    return { ok: true };
  }

  async markSandboxPassed(id: string) {
    const r = await sql`UPDATE authority_endpoints SET sandbox_passed = true WHERE id = ${id} RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.notFound('Endpoint not found.');
    return { ok: true };
  }

  async health(id: string) {
    const r = await sql<EndpointRow>`SELECT * FROM authority_endpoints WHERE id = ${id}`.execute(this.db);
    const e = r.rows[0];
    if (!e) throw appError.notFound('Endpoint not found.');
    let ok = false;
    try {
      const res = await fetch(`${e.base_url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
      ok = res.ok;
    } catch {
      ok = false;
    }
    await sql`UPDATE authority_endpoints SET last_health_at = now(), last_health_ok = ${ok} WHERE id = ${id}`.execute(this.db);
    return { ok };
  }

  async attempts() {
    const r = await sql<{ id: string; sos_id: string; status: string; error_type: string | null; attempts: number; dead_letter: boolean; payload_version: string; response_ref: string | null; name: string | null; created_at: Date }>`
      SELECT a.id, a.sos_id, a.status, a.error_type, a.attempts, a.dead_letter, a.payload_version, a.response_ref, e.name, a.created_at
        FROM handoff_attempts a LEFT JOIN authority_endpoints e ON e.id = a.endpoint_id
       ORDER BY a.created_at DESC LIMIT 200`.execute(this.db);
    return { items: r.rows.map((a) => ({ id: a.id, sosId: a.sos_id, status: a.status, errorType: a.error_type, attempts: a.attempts, deadLetter: a.dead_letter, payloadVersion: a.payload_version, responseRef: a.response_ref, endpoint: a.name, createdAt: a.created_at.toISOString() })) };
  }

  /** The operator took the manual route (called 112 or the control room). Recorded, not claimed as delivery. */
  async manualFallback(id: string) {
    const r = await sql`UPDATE handoff_attempts SET status = 'fallback', error_type = COALESCE(error_type, 'manual'), updated_at = now()
                         WHERE id = ${id} AND status NOT IN ('accepted','acknowledged') RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.conflict('This attempt is already accepted or does not exist.');
    return { ok: true };
  }

  /** Only when the authority itself confirmed. The reason is kept in the audit log. */
  async markAcknowledged(id: string) {
    const r = await sql`UPDATE handoff_attempts SET status = 'acknowledged', updated_at = now() WHERE id = ${id} AND status = 'accepted' RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.conflict('Only an accepted attempt can be marked acknowledged.');
    return { ok: true };
  }

  /** CCTNS verification: only permitted fields, only for a stated purpose, never "verified" without a clear yes. */
  async verify(adminId: string, endpointId: string, purpose: string, fields: Record<string, string>) {
    const r = await sql<EndpointRow>`SELECT * FROM authority_endpoints WHERE id = ${endpointId} AND kind = 'cctns' AND enabled`.execute(this.db);
    const ep = r.rows[0];
    if (!ep || !ep.permitted_ops.includes('verify')) throw appError.notFound('No approved verification endpoint.');
    const extra = Object.keys(fields).filter((f) => !ep.permitted_fields.includes(f));
    if (extra.length > 0) throw appError.invalidInput(`Field not permitted: ${extra.join(', ')}`);
    const token = process.env[ep.credential_env];
    let status = 'unavailable';
    let reference: string | null = null;
    try {
      const res = await fetch(`${ep.base_url.replace(/\/$/, '')}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(8000),
      });
      const body = (await res.json().catch(() => ({}))) as { verified?: unknown; reference?: string };
      status = res.ok ? (body.verified === true ? 'verified' : 'not_verified') : 'unavailable';
      reference = body.reference ? String(body.reference).slice(0, 80) : null;
    } catch {
      status = 'unavailable';
    }
    // Only the field names are kept, never their values.
    await sql`INSERT INTO authority_queries (endpoint_id, admin_id, purpose, fields, status, reference)
              VALUES (${endpointId}, ${adminId}, ${purpose}, ${JSON.stringify(Object.keys(fields))}, ${status}, ${reference})`.execute(this.db);
    return { status, reference, fingerprint: createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 12) };
  }

  async queries() {
    const r = await sql<{ id: string; purpose: string; fields: string[]; status: string; reference: string | null; created_at: Date; name: string }>`
      SELECT q.id, q.purpose, q.fields, q.status, q.reference, q.created_at, e.name
        FROM authority_queries q JOIN authority_endpoints e ON e.id = q.endpoint_id ORDER BY q.created_at DESC LIMIT 200`.execute(this.db);
    return { items: r.rows.map((q) => ({ id: q.id, endpoint: q.name, purpose: q.purpose, fields: q.fields, status: q.status, reference: q.reference, createdAt: q.created_at.toISOString() })) };
  }
}

@Controller('v1')
export class PoliceHandoffController {
  constructor(private readonly service: PoliceHandoffService) {}

  @Get('sos-handoff/:id')
  status(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.service.statusFor(req.user!.id, id);
  }
}
