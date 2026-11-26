import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import type { PartnerRequestStatus } from '../../database/types';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';
import { distanceM, newReference, Phase4Gate } from './common';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('Not found.') });

// ---- Night Mode (P4-01) ----------------------------------------------------------------------

const nightBody = z.object({ active: z.boolean() });

// ---- Safe Place Finder (P4-02) -----------------------------------------------------------------

export const SAFE_CATEGORIES = [
  'police',
  'hospital',
  'pharmacy',
  'petrol',
  'help_desk',
  'partner',
] as const;
type SafeCategory = (typeof SAFE_CATEGORIES)[number];

/** Which Google Places type each category searches for. Help desks and partners are our own list. */
const PLACE_TYPE: Partial<Record<SafeCategory, string>> = {
  police: 'police',
  hospital: 'hospital',
  pharmacy: 'pharmacy',
  petrol: 'gas_station',
};

const safeQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  category: z.enum(SAFE_CATEGORIES).optional(),
  radiusM: z.coerce.number().int().min(300).max(10000).default(3000),
  sort: z.enum(['distance', 'verified']).default('distance'),
});

export interface SafePlace {
  id: string;
  source: 'partner' | 'map';
  name: string;
  category: string;
  address: string | null;
  phone: string | null;
  hours: string | null;
  openNow: boolean | null;
  lat: number;
  lng: number;
  distanceM: number;
  verified: boolean;
  services: string | null;
  verifiedUntil: string | null;
}

interface GooglePlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  internationalPhoneNumber?: string;
  currentOpeningHours?: { openNow?: boolean };
}

// ---- Guidance (WOM-10) ------------------------------------------------------------------------

const guidanceQuery = z.object({
  situation: z
    .enum(['threat', 'harassment', 'stalking', 'medical', 'travel', 'child', 'senior'])
    .optional(),
  language: z.string().trim().min(2).max(8).default('en'),
});

// ---- Partner directory and requests (WOM-08, MEN-06, LEG-01..04) ------------------------------

const partnersQuery = z.object({
  kind: z.enum(['women_support', 'lawyer']),
  category: z.string().trim().min(1).max(40).optional(),
  language: z.string().trim().min(2).max(20).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

const requestBody = z.object({
  id: z.uuid(),
  kind: z.enum(['women_support', 'legal']),
  partnerId: z.uuid().nullish(),
  category: z.string().trim().min(2).max(40),
  urgency: z.enum(['low', 'normal', 'urgent']).default('normal'),
  preferredContact: z.enum(['phone', 'sms', 'any']).default('phone'),
  summary: z
    .string()
    .trim()
    .min(10, { error: 'Write a short summary (at least 10 characters)' })
    .max(1000),
  sharedItemIds: z.array(z.uuid()).max(20).default([]),
  sharedDays: z.number().int().min(1).max(90).default(14),
});

// ---- Incident reports (WOM-07, MEN-02/03/05) ----------------------------------------------------

const reportBody = z.object({
  kind: z.enum(['harassment', 'workplace', 'false_accusation']),
  category: z.string().trim().min(2).max(40),
  occurredAt: z.iso.datetime({ offset: true }),
  placeLabel: z.string().trim().max(160).nullish(),
  description: z
    .string()
    .trim()
    .min(10, { error: 'Describe what happened (at least 10 characters)' })
    .max(3000),
  frequency: z.string().trim().max(60).nullish(),
  immediateRisk: z.boolean().default(false),
  organisation: z.string().trim().max(160).nullish(),
  witnessNotes: z.string().trim().max(1500).nullish(),
  details: z
    .object({
      allegationType: z.string().trim().max(80).optional(),
      authorityRef: z.string().trim().max(80).optional(),
      stage: z.string().trim().max(80).optional(),
    })
    .default({}),
  evidenceItemIds: z.array(z.uuid()).max(30).default([]),
  route: z.enum(['private', 'guardian', 'legal', 'organisation']).default('private'),
  partnerId: z.uuid().nullish(),
  submit: z.boolean().default(false),
});

export type ReportInput = z.infer<typeof reportBody>;

const PARTNER_OPEN = sql<boolean>`p.status = 'approved' AND (p.expires_at IS NULL OR p.expires_at > now())`;

@Injectable()
export class SafetyServicesService {
  private readonly logger = new Logger(SafetyServicesService.name);
  private readonly cache = new Map<string, { at: number; items: SafePlace[] }>();

  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
    private readonly gate: Phase4Gate,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // -- Night Mode ---------------------------------------------------------------------------

  async nightMode(userId: string): Promise<{ active: boolean }> {
    await this.gate.require('feature.night_mode');
    const row = await this.database.db
      .selectFrom('night_mode_state')
      .select('active')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return { active: row?.active ?? false };
  }

  /** Navigation state only: it never starts or stops an SOS, a journey or a recording. */
  async setNightMode(userId: string, active: boolean): Promise<{ active: boolean }> {
    await this.gate.require('feature.night_mode');
    await this.database.db
      .insertInto('night_mode_state')
      .values({ user_id: userId, active })
      .onConflict((oc) => oc.column('user_id').doUpdateSet({ active, updated_at: new Date() }))
      .execute();
    return { active };
  }

  // -- Safe places --------------------------------------------------------------------------

  async safePlaces(q: z.infer<typeof safeQuery>) {
    await this.gate.require('feature.safe_places');
    const here = sql`ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography`;
    let partners = this.database.db
      .selectFrom('partners as p')
      .select([
        'p.id',
        'p.name',
        'p.category',
        'p.address',
        'p.phone',
        'p.hours',
        'p.services',
        'p.expires_at',
        sql<number>`ST_Y(p.location::geometry)`.as('lat'),
        sql<number>`ST_X(p.location::geometry)`.as('lng'),
        sql<number>`ST_Distance(p.location, ${here})`.as('distance_m'),
      ])
      .where('p.kind', '=', 'safe_point')
      .where(PARTNER_OPEN)
      .where('p.location', 'is not', null)
      .where(sql<boolean>`ST_DWithin(p.location, ${here}, ${q.radiusM})`);
    if (q.category && q.category !== 'partner') {
      partners = partners.where('p.category', '=', q.category);
    }
    const rows = await partners
      .orderBy(sql`distance_m`)
      .limit(30)
      .execute();
    const items: SafePlace[] = rows.map((r) => ({
      id: `partner:${r.id}`,
      source: 'partner',
      name: r.name,
      category: r.category,
      address: r.address,
      phone: r.phone,
      hours: r.hours,
      openNow: null,
      lat: r.lat,
      lng: r.lng,
      distanceM: Math.round(r.distance_m),
      // The badge means onboarding and verification were completed and are still valid.
      verified: true,
      services: r.services,
      verifiedUntil: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    }));

    let providerAvailable = false;
    let providerMessage: string | null = null;
    const type = q.category ? PLACE_TYPE[q.category] : undefined;
    if (q.category === 'partner' || (q.category && !type)) {
      providerAvailable = true; // nothing to ask the map provider for this category
    } else if (!this.env.GOOGLE_PLACES_API_KEY) {
      providerMessage =
        'Map places are not switched on yet. Only verified partner points are listed.';
    } else {
      try {
        const types = type ? [type] : Object.values(PLACE_TYPE);
        for (const t of types) items.push(...(await this.mapPlaces(t, q)));
        providerAvailable = true;
      } catch (err) {
        this.logger.warn(`Places search failed: ${(err as Error).message}`);
        providerMessage =
          'Map places could not be loaded right now. Verified partner points are shown.';
      }
    }
    items.sort((a, b) =>
      q.sort === 'verified' && a.verified !== b.verified
        ? a.verified
          ? -1
          : 1
        : a.distanceM - b.distanceM,
    );
    return {
      items: items.slice(0, 40),
      providerAvailable,
      providerMessage,
      disclaimer:
        'A listing does not guarantee a place is open, staffed or able to protect anyone. The badge means the partner completed onboarding and verification, not guaranteed protection.',
    };
  }

  private async mapPlaces(type: string, q: z.infer<typeof safeQuery>): Promise<SafePlace[]> {
    const ttl = (await this.settings.get('safe_places.cache_minutes')) * 60_000;
    const key = `${type}:${q.lat.toFixed(2)}:${q.lng.toFixed(2)}:${q.radiusM}`;
    const hit = this.cache.get(key);
    let raw = hit && Date.now() - hit.at < ttl ? hit.items : null;
    if (!raw) {
      const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.env.GOOGLE_PLACES_API_KEY!,
          'x-goog-fieldmask':
            'places.id,places.displayName,places.formattedAddress,places.location,places.internationalPhoneNumber,places.currentOpeningHours.openNow',
        },
        body: JSON.stringify({
          includedTypes: [type],
          maxResultCount: 20,
          rankPreference: 'DISTANCE',
          locationRestriction: {
            circle: { center: { latitude: q.lat, longitude: q.lng }, radius: q.radiusM },
          },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Places answered ${res.status}`);
      const json = (await res.json()) as { places?: GooglePlace[] };
      const category = Object.entries(PLACE_TYPE).find(([, v]) => v === type)?.[0] ?? type;
      raw = (json.places ?? [])
        .filter((p) => p.location)
        .map((p) => ({
          id: `map:${p.id}`,
          source: 'map' as const,
          name: p.displayName?.text ?? 'Place',
          category,
          address: p.formattedAddress ?? null,
          phone: p.internationalPhoneNumber ?? null,
          hours: null,
          openNow: p.currentOpeningHours?.openNow ?? null,
          lat: p.location!.latitude,
          lng: p.location!.longitude,
          distanceM: 0,
          verified: false,
          services: null,
          verifiedUntil: null,
        }));
      this.cache.set(key, { at: Date.now(), items: raw });
    }
    // Distance is worked out for this user, not for whoever filled the cache.
    return raw.map((p) => ({
      ...p,
      distanceM: Math.round(distanceM(q.lat, q.lng, p.lat, p.lng)),
    }));
  }

  // -- Guidance -----------------------------------------------------------------------------

  async guidance(q: z.infer<typeof guidanceQuery>) {
    await this.gate.require(
      'feature.women_safety',
      'feature.legal_support',
      'feature.child_safety',
    );
    let query = this.database.db
      .selectFrom('guidance_articles')
      .select(['id', 'situation', 'title', 'steps', 'language', 'reviewed_on', 'review_due'])
      .where('status', '=', 'approved')
      .where('language', '=', q.language)
      // Content past its review date is never shown as current.
      .where(sql<boolean>`review_due IS NOT NULL AND review_due >= current_date`);
    if (q.situation) query = query.where('situation', '=', q.situation);
    const rows = await query.orderBy('title').execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        situation: r.situation,
        title: r.title,
        steps: r.steps,
        language: r.language,
        reviewedOn: r.reviewed_on ? String(r.reviewed_on).slice(0, 10) : null,
        reviewDue: r.review_due ? String(r.review_due).slice(0, 10) : null,
      })),
      disclaimer:
        'This is general information, not medical or legal advice. It never replaces calling 112 or starting an SOS.',
    };
  }

  // -- Partners and requests ----------------------------------------------------------------

  async partners(q: z.infer<typeof partnersQuery>) {
    await this.gate.require(q.kind === 'lawyer' ? 'feature.legal_support' : 'feature.women_safety');
    let query = this.database.db
      .selectFrom('partners as p')
      .select([
        'p.id',
        'p.name',
        'p.category',
        'p.city',
        'p.address',
        'p.phone',
        'p.hours',
        'p.languages',
        'p.services',
        'p.expires_at',
      ])
      .where('p.kind', '=', q.kind)
      .where(PARTNER_OPEN);
    if (q.category) query = query.where('p.category', '=', q.category);
    if (q.language) query = query.where(sql<boolean>`${q.language} = ANY (p.languages)`);
    if (q.city) query = query.where(sql<boolean>`lower(p.city) = lower(${q.city})`);
    if (q.lat !== undefined && q.lng !== undefined) {
      const here = sql`ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography`;
      const rows = await query
        .select(sql<number | null>`ST_Distance(p.location, ${here})`.as('distance_m'))
        .orderBy(sql`distance_m NULLS LAST`)
        .limit(40)
        .execute();
      return { items: rows.map((r) => this.partnerOut(r, r.distance_m)) };
    }
    const rows = await query.orderBy('p.name').limit(40).execute();
    return { items: rows.map((r) => this.partnerOut(r, null)) };
  }

  private partnerOut(
    r: {
      id: string;
      name: string;
      category: string;
      city: string | null;
      address: string | null;
      phone: string | null;
      hours: string | null;
      languages: string[];
      services: string | null;
      expires_at: Date | null;
    },
    distance: number | null,
  ) {
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      city: r.city,
      address: r.address,
      phone: r.phone,
      hours: r.hours,
      languages: r.languages,
      services: r.services,
      distanceM: distance === null ? null : Math.round(distance),
      verified: true,
      verifiedUntil: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    };
  }

  async createRequest(userId: string, input: z.infer<typeof requestBody>) {
    await this.gate.require(
      input.kind === 'legal' ? 'feature.legal_support' : 'feature.women_safety',
    );
    const existing = await this.database.db
      .selectFrom('partner_requests')
      .select('user_id')
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (existing) {
      if (existing.user_id !== userId) throw appError.notFound('Request not found.');
      return this.requestDetail(userId, input.id);
    }
    if (input.partnerId) {
      const ok = await this.database.db
        .selectFrom('partners as p')
        .select('p.id')
        .where('p.id', '=', input.partnerId)
        .where('p.kind', '=', input.kind === 'legal' ? 'lawyer' : 'women_support')
        .where(PARTNER_OPEN)
        .executeTakeFirst();
      if (!ok)
        throw appError.invalidInput(
          'This partner is not available any more. Please choose another.',
        );
    }
    await this.checkEvidence(userId, input.sharedItemIds);
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('partner_requests')
        .values({
          id: input.id,
          user_id: userId,
          partner_id: input.partnerId ?? null,
          kind: input.kind,
          category: input.category,
          urgency: input.urgency,
          preferred_contact: input.preferredContact,
          summary: input.summary,
          shared_item_ids: JSON.stringify(input.sharedItemIds),
          shared_until: input.sharedItemIds.length
            ? new Date(Date.now() + input.sharedDays * 86_400_000)
            : null,
          reference: newReference(),
        })
        .execute();
      await trx
        .insertInto('partner_request_events')
        .values({ request_id: input.id, status: 'requested', actor: 'user', note: null })
        .execute();
    });
    return this.requestDetail(userId, input.id);
  }

  async listRequests(userId: string) {
    const rows = await this.database.db
      .selectFrom('partner_requests as r')
      .leftJoin('partners as p', 'p.id', 'r.partner_id')
      .select([
        'r.id',
        'r.kind',
        'r.category',
        'r.status',
        'r.reference',
        'r.created_at',
        'p.name as partner_name',
      ])
      .where('r.user_id', '=', userId)
      .orderBy('r.created_at', 'desc')
      .limit(50)
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        category: r.category,
        status: r.status,
        reference: r.reference,
        partnerName: r.partner_name,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  }

  async requestDetail(userId: string, id: string) {
    const r = await this.database.db
      .selectFrom('partner_requests as r')
      .leftJoin('partners as p', 'p.id', 'r.partner_id')
      .select([
        'r.id',
        'r.kind',
        'r.category',
        'r.urgency',
        'r.preferred_contact',
        'r.summary',
        'r.shared_item_ids',
        'r.shared_until',
        'r.status',
        'r.reference',
        'r.created_at',
        'p.name as partner_name',
        'p.phone as partner_phone',
      ])
      .where('r.id', '=', id)
      .where('r.user_id', '=', userId)
      .executeTakeFirst();
    if (!r) throw appError.notFound('Request not found.');
    const events = await this.database.db
      .selectFrom('partner_request_events')
      .select(['status', 'actor', 'note', 'created_at'])
      .where('request_id', '=', id)
      .orderBy('id')
      .execute();
    const expiresAt = r.shared_until ? new Date(r.shared_until).toISOString() : null;
    const expired = expiresAt !== null && new Date(expiresAt) < new Date();
    return {
      id: r.id,
      kind: r.kind,
      category: r.category,
      urgency: r.urgency,
      preferredContact: r.preferred_contact,
      summary: r.summary,
      status: r.status,
      reference: r.reference,
      partnerName: r.partner_name,
      partnerPhone: r.partner_phone,
      // The partner receives only the items listed here, until this time. Never the whole vault.
      sharedItemIds: expired ? [] : r.shared_item_ids,
      sharedUntil: expiresAt,
      timeline: events.map((e) => ({
        status: e.status,
        by: e.actor,
        note: e.note,
        at: new Date(e.created_at).toISOString(),
      })),
      createdAt: new Date(r.created_at).toISOString(),
      disclaimer: 'Sarthi Rakshak gives no legal advice and promises no response time.',
    };
  }

  async closeRequest(userId: string, id: string) {
    const r = await this.database.db
      .selectFrom('partner_requests')
      .select('status')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!r) throw appError.notFound('Request not found.');
    if (r.status !== 'closed') {
      await this.database.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('partner_requests')
          .set({ status: 'closed' as PartnerRequestStatus })
          .where('id', '=', id)
          .execute();
        await trx
          .insertInto('partner_request_events')
          .values({ request_id: id, status: 'closed', actor: 'user', note: 'Closed by you' })
          .execute();
      });
    }
    return this.requestDetail(userId, id);
  }

  /** Items offered to a partner or a report must be the user's own vault items. */
  private async checkEvidence(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await this.database.db
      .selectFrom('evidence_items')
      .select('id')
      .where('user_id', '=', userId)
      .where('id', 'in', ids)
      .execute();
    if (rows.length !== new Set(ids).size)
      throw appError.invalidInput('Some selected items were not found in your vault.');
  }

  // -- Incident reports ---------------------------------------------------------------------

  private reportFeature(kind: ReportInput['kind']) {
    return kind === 'harassment' ? 'feature.women_safety' : 'feature.legal_support';
  }

  async saveReport(userId: string, id: string, input: ReportInput) {
    await this.gate.require(this.reportFeature(input.kind));
    if (input.route === 'organisation' && !input.organisation) {
      throw appError.invalidInput('Name the organisation that should receive this report.');
    }
    if (input.kind !== 'workplace' && input.route === 'organisation') {
      throw appError.invalidInput('This kind of report cannot go to an organisation.');
    }
    await this.checkEvidence(userId, input.evidenceItemIds);
    const existing = await this.database.db
      .selectFrom('incident_reports')
      .select(['user_id', 'status', 'reference', 'partner_request_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (existing && existing.user_id !== userId) throw appError.notFound('Report not found.');
    if (existing && existing.status !== 'draft') {
      // A submitted report is a record: it is never rewritten.
      return this.reportDetail(userId, id);
    }
    const values = {
      kind: input.kind,
      category: input.category,
      occurred_at: input.occurredAt,
      place_label: input.placeLabel ?? null,
      description: input.description,
      frequency: input.frequency ?? null,
      immediate_risk: input.immediateRisk,
      organisation: input.organisation ?? null,
      witness_notes: input.witnessNotes ?? null,
      details: JSON.stringify(input.details),
      evidence_item_ids: JSON.stringify(input.evidenceItemIds),
      route: input.route,
    };
    await this.database.db.transaction().execute(async (trx) => {
      if (existing) {
        await trx.updateTable('incident_reports').set(values).where('id', '=', id).execute();
      } else {
        await trx
          .insertInto('incident_reports')
          .values({ id, user_id: userId, reference: newReference(), ...values })
          .execute();
        await trx
          .insertInto('incident_report_events')
          .values({ report_id: id, action: 'draft_saved', note: null })
          .execute();
      }
      if (input.submit) {
        let partnerRequestId: string | null = null;
        if (input.route === 'legal') {
          // A legal route is a consultation request carrying only the items chosen for this report.
          partnerRequestId = id;
          const dup = await trx
            .selectFrom('partner_requests')
            .select('id')
            .where('id', '=', id)
            .executeTakeFirst();
          if (!dup) {
            await trx
              .insertInto('partner_requests')
              .values({
                id,
                user_id: userId,
                partner_id: input.partnerId ?? null,
                kind: 'legal',
                category: input.category,
                urgency: input.immediateRisk ? 'urgent' : 'normal',
                summary: input.description.slice(0, 1000),
                shared_item_ids: JSON.stringify(input.evidenceItemIds),
                shared_until: input.evidenceItemIds.length
                  ? new Date(Date.now() + 14 * 86_400_000)
                  : null,
                reference: newReference(),
              })
              .execute();
            await trx
              .insertInto('partner_request_events')
              .values({
                request_id: id,
                status: 'requested',
                actor: 'user',
                note: 'From your report',
              })
              .execute();
          }
        }
        await trx
          .updateTable('incident_reports')
          .set({ status: 'submitted', partner_request_id: partnerRequestId })
          .where('id', '=', id)
          .execute();
        await trx
          .insertInto('incident_report_events')
          .values({ report_id: id, action: `submitted_${input.route}`, note: null })
          .execute();
      }
    });
    return this.reportDetail(userId, id);
  }

  async listReports(userId: string, kinds: string[]) {
    const rows = await this.database.db
      .selectFrom('incident_reports')
      .select([
        'id',
        'kind',
        'category',
        'status',
        'route',
        'reference',
        'occurred_at',
        'created_at',
      ])
      .where('user_id', '=', userId)
      .where('kind', 'in', kinds as ('harassment' | 'workplace' | 'false_accusation')[])
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        category: r.category,
        status: r.status,
        route: r.route,
        reference: r.reference,
        occurredAt: new Date(r.occurred_at).toISOString(),
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  }

  async reportDetail(userId: string, id: string) {
    const r = await this.database.db
      .selectFrom('incident_reports')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!r) throw appError.notFound('Report not found.');
    const events = await this.database.db
      .selectFrom('incident_report_events')
      .select(['action', 'created_at'])
      .where('report_id', '=', id)
      .orderBy('id')
      .execute();
    return {
      id: r.id,
      kind: r.kind,
      category: r.category,
      occurredAt: new Date(r.occurred_at).toISOString(),
      placeLabel: r.place_label,
      description: r.description,
      frequency: r.frequency,
      immediateRisk: r.immediate_risk,
      organisation: r.organisation,
      witnessNotes: r.witness_notes,
      details: r.details,
      evidenceItemIds: r.evidence_item_ids,
      route: r.route,
      status: r.status,
      reference: r.reference,
      partnerRequestId: r.partner_request_id,
      timeline: events.map((e) => ({ action: e.action, at: new Date(e.created_at).toISOString() })),
      createdAt: new Date(r.created_at).toISOString(),
      // The report is the user's own account. It is private by default and nothing is sent to anyone
      // (including police) unless this route says so. Nobody is labelled guilty.
      notice:
        'This is your own account of what happened. It is private unless you chose a recipient. Police are never contacted automatically.',
    };
  }

  async deleteDraft(userId: string, id: string): Promise<void> {
    const r = await this.database.db
      .selectFrom('incident_reports')
      .select('status')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!r) throw appError.notFound('Report not found.');
    if (r.status !== 'draft')
      throw appError.conflict('A submitted report is kept as a record and cannot be deleted here.');
    await this.database.db.deleteFrom('incident_reports').where('id', '=', id).execute();
  }
}

@Controller('v1')
export class SafetyServicesController {
  constructor(
    private readonly support: SafetyServicesService,
    private readonly limiter: AppRateLimiter,
  ) {}

  @Get('night-mode')
  nightMode(@Req() req: AppRequest) {
    return this.support.nightMode(req.user!.id);
  }

  @Put('night-mode')
  setNightMode(@Req() req: AppRequest, @Body() body: unknown) {
    return this.support.setNightMode(req.user!.id, parseAppBody(nightBody, body).active);
  }

  @Get('safe-places')
  async safePlaces(@Req() req: AppRequest, @Query() query: unknown) {
    await this.limiter.check(`safe-places:${req.user!.id}`, 120, 3600);
    return this.support.safePlaces(parseAppBody(safeQuery, query));
  }

  @Get('guidance')
  guidance(@Query() query: unknown) {
    return this.support.guidance(parseAppBody(guidanceQuery, query));
  }

  @Get('partners')
  partners(@Query() query: unknown) {
    return this.support.partners(parseAppBody(partnersQuery, query));
  }

  @Get('partner-requests')
  requests(@Req() req: AppRequest) {
    return this.support.listRequests(req.user!.id);
  }

  @Post('partner-requests')
  @HttpCode(200)
  async createRequest(@Req() req: AppRequest, @Body() body: unknown) {
    await this.limiter.check(`partner-request:${req.user!.id}`, 15, 3600);
    return this.support.createRequest(req.user!.id, parseAppBody(requestBody, body));
  }

  @Get('partner-requests/:id')
  request(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.support.requestDetail(req.user!.id, id);
  }

  @Post('partner-requests/:id/close')
  @HttpCode(200)
  closeRequest(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.support.closeRequest(req.user!.id, id);
  }

  @Get('incident-reports')
  reports(@Req() req: AppRequest, @Query('group') group?: string) {
    return this.support.listReports(
      req.user!.id,
      group === 'women' ? ['harassment'] : ['workplace', 'false_accusation'],
    );
  }

  @Put('incident-reports/:id')
  async saveReport(@Req() req: AppRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    await this.limiter.check(`incident-report:${req.user!.id}`, 60, 3600);
    return this.support.saveReport(req.user!.id, id, parseAppBody(reportBody, body));
  }

  @Get('incident-reports/:id')
  report(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.support.reportDetail(req.user!.id, id);
  }

  @Post('incident-reports/:id/delete')
  @HttpCode(204)
  async deleteDraft(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    await this.support.deleteDraft(req.user!.id, id);
  }
}
