import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';
import { OutgoingMessages } from '../messages/outgoing-messages';
import { distanceM, distanceToRouteM, Phase4Gate } from './common';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('Not found.') });

const MAX_LINKS = 5;
const MAX_ZONES = 10;
const MAX_ROUTES = 5;
const MAX_GUARDIANS = 5;
/** Written on every alert so a stored alert can be traced to the rule numbers it used. */
const RULE_VERSION = 'child-v1';

const linkBody = z.object({
  id: z.uuid(),
  childName: z.string().trim().min(1).max(60),
  childPhone: z
    .string()
    .regex(/^\+[1-9][0-9]{7,14}$/, {
      error: 'Enter the phone number with the country code, e.g. +91…',
    }),
});

const zoneBody = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['home', 'school', 'other']).default('other'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(50).max(5000),
});

const routeBody = z.object({
  name: z.string().trim().min(1).max(60),
  points: z
    .array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]))
    .min(2)
    .max(500),
  active: z.boolean().default(true),
});

const locationBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100000).nullish(),
  recordedAt: z.iso.datetime({ offset: true }).optional(),
});

@Injectable()
export class ChildService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
    private readonly gate: Phase4Gate,
    private readonly messages: OutgoingMessages,
  ) {}

  private async audit(linkId: string, action: string, actor: string | null) {
    await this.database.db
      .insertInto('child_link_events')
      .values({ link_id: linkId, action, actor_user_id: actor })
      .execute();
  }

  /** Only the parent who made the link can manage it, and only while it is not revoked. */
  private async ownLink(parentId: string, linkId: string) {
    const link = await this.database.db
      .selectFrom('child_links')
      .selectAll()
      .where('id', '=', linkId)
      .where('parent_user_id', '=', parentId)
      .executeTakeFirst();
    if (!link) throw appError.notFound('Link not found.');
    return link;
  }

  // -- Parent: links ------------------------------------------------------------------------

  async createLink(parentId: string, input: z.infer<typeof linkBody>) {
    await this.gate.require('feature.child_safety');
    const me = await this.database.db
      .selectFrom('users')
      .select(['name', 'phone'])
      .where('id', '=', parentId)
      .executeTakeFirstOrThrow();
    if (me.phone === input.childPhone)
      throw appError.invalidInput('You cannot link your own number.');
    const existing = await this.database.db
      .selectFrom('child_links')
      .select('parent_user_id')
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (existing && existing.parent_user_id !== parentId)
      throw appError.notFound('Link not found.');
    if (!existing) {
      const open = await this.database.db
        .selectFrom('child_links')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('parent_user_id', '=', parentId)
        .where('status', 'in', ['invited', 'active'])
        .executeTakeFirstOrThrow();
      if (Number(open.n) >= MAX_LINKS)
        throw appError.limitReached(`You can link up to ${MAX_LINKS} children.`);
      const dup = await this.database.db
        .selectFrom('child_links')
        .select('id')
        .where('parent_user_id', '=', parentId)
        .where('child_phone', '=', input.childPhone)
        .where('status', 'in', ['invited', 'active'])
        .executeTakeFirst();
      if (dup) throw appError.conflict('This number is already linked or invited.');
      await this.database.db
        .insertInto('child_links')
        .values({
          id: input.id,
          parent_user_id: parentId,
          child_name: input.childName,
          child_phone: input.childPhone,
        })
        .execute();
      await this.audit(input.id, 'invited', parentId);
      const child = await this.database.db
        .selectFrom('users')
        .select('id')
        .where('phone', '=', input.childPhone)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (child) {
        await this.messages.notifyUser(
          child.id,
          'child_link',
          'Family link request',
          `${me.name ?? 'A parent'} wants to link with you. Open Sarthi Rakshak to accept or decline.`,
          { linkId: input.id },
        );
      }
    }
    return this.linkOut(parentId, input.id);
  }

  async links(parentId: string) {
    await this.gate.require('feature.child_safety');
    const rows = await this.database.db
      .selectFrom('child_links')
      .select('id')
      .where('parent_user_id', '=', parentId)
      .where('status', '!=', 'declined')
      .orderBy('created_at')
      .execute();
    return { items: await Promise.all(rows.map((r) => this.linkOut(parentId, r.id))) };
  }

  private async linkOut(parentId: string, id: string) {
    const link = await this.ownLink(parentId, id);
    const last = await this.database.db
      .selectFrom('child_last_location')
      .select([
        'accuracy_m',
        'recorded_at',
        sql<number>`ST_Y(location::geometry)`.as('lat'),
        sql<number>`ST_X(location::geometry)`.as('lng'),
      ])
      .where('link_id', '=', id)
      .executeTakeFirst();
    const staleMin = await this.settings.get('child.stale_gps_minutes');
    const ageMin = last ? (Date.now() - new Date(last.recorded_at).getTime()) / 60_000 : null;
    const alerts = await this.database.db
      .selectFrom('child_alerts')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('link_id', '=', id)
      .where('acknowledged_at', 'is', null)
      .executeTakeFirstOrThrow();
    return {
      id: link.id,
      childName: link.child_name,
      childPhoneLast4: link.child_phone.slice(-4),
      status: link.status,
      createdAt: new Date(link.created_at).toISOString(),
      acceptedAt: link.accepted_at ? new Date(link.accepted_at).toISOString() : null,
      unseenAlerts: Number(alerts.n),
      lastLocation:
        link.status === 'active' && last
          ? {
              lat: last.lat,
              lng: last.lng,
              accuracyM: last.accuracy_m,
              recordedAt: new Date(last.recorded_at).toISOString(),
              // Old data is flagged, never presented as the child's current position.
              stale: ageMin !== null && ageMin > staleMin,
              approximate:
                last.accuracy_m !== null &&
                last.accuracy_m > (await this.settings.get('child.max_accuracy_m')),
            }
          : null,
      staleAfterMinutes: staleMin,
    };
  }

  async revoke(parentId: string, id: string) {
    const link = await this.ownLink(parentId, id);
    if (link.status === 'revoked') return this.linkOut(parentId, id);
    await this.database.db
      .updateTable('child_links')
      .set({ status: 'revoked', revoked_at: new Date() })
      .where('id', '=', id)
      .execute();
    await this.audit(id, 'revoked', parentId);
    if (link.child_user_id) {
      await this.messages.notifyUser(
        link.child_user_id,
        'child_link',
        'Family link ended',
        'The link with your parent was ended.',
        {
          linkId: id,
        },
      );
    }
    return this.linkOut(parentId, id);
  }

  private async requireActive(parentId: string, id: string) {
    await this.gate.require('feature.child_safety');
    const link = await this.ownLink(parentId, id);
    if (link.status !== 'active') throw appError.conflict('This link is not active.');
    return link;
  }

  // -- Parent: zones, routes, alerts ---------------------------------------------------------

  async zones(parentId: string, id: string) {
    await this.gate.require('feature.child_safety');
    await this.ownLink(parentId, id);
    const rows = await this.database.db
      .selectFrom('child_zones')
      .select([
        'id',
        'name',
        'kind',
        'radius_m',
        'inside',
        'changed_at',
        sql<number>`ST_Y(center::geometry)`.as('lat'),
        sql<number>`ST_X(center::geometry)`.as('lng'),
      ])
      .where('link_id', '=', id)
      .orderBy('created_at')
      .execute();
    return {
      items: rows.map((z) => ({
        id: z.id,
        name: z.name,
        kind: z.kind,
        lat: z.lat,
        lng: z.lng,
        radiusM: z.radius_m,
        inside: z.inside,
        changedAt: z.changed_at ? new Date(z.changed_at).toISOString() : null,
      })),
    };
  }

  async saveZone(parentId: string, id: string, zoneId: string, input: z.infer<typeof zoneBody>) {
    await this.requireActive(parentId, id);
    const existing = await this.database.db
      .selectFrom('child_zones')
      .select('link_id')
      .where('id', '=', zoneId)
      .executeTakeFirst();
    if (existing && existing.link_id !== id) throw appError.notFound('Zone not found.');
    const center = sql<string>`ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography`;
    if (existing) {
      // Moving or resizing a zone resets its state, so the next fix is not read as an entry or exit.
      await this.database.db
        .updateTable('child_zones')
        .set({
          name: input.name,
          kind: input.kind,
          center,
          radius_m: input.radiusM,
          inside: null,
          changed_at: null,
        })
        .where('id', '=', zoneId)
        .execute();
    } else {
      const n = await this.database.db
        .selectFrom('child_zones')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('link_id', '=', id)
        .executeTakeFirstOrThrow();
      if (Number(n.n) >= MAX_ZONES)
        throw appError.limitReached(`You can set up to ${MAX_ZONES} zones.`);
      await this.database.db
        .insertInto('child_zones')
        .values({
          id: zoneId,
          link_id: id,
          name: input.name,
          kind: input.kind,
          center,
          radius_m: input.radiusM,
        })
        .execute();
    }
    await this.audit(id, existing ? 'zone_changed' : 'zone_added', parentId);
    return this.zones(parentId, id);
  }

  async deleteZone(parentId: string, id: string, zoneId: string) {
    await this.requireActive(parentId, id);
    await this.database.db
      .deleteFrom('child_zones')
      .where('id', '=', zoneId)
      .where('link_id', '=', id)
      .execute();
    await this.audit(id, 'zone_removed', parentId);
  }

  async routes(parentId: string, id: string) {
    await this.gate.require('feature.child_safety');
    await this.ownLink(parentId, id);
    const rows = await this.database.db
      .selectFrom('child_routes')
      .select(['id', 'name', 'points', 'active', 'off_since', 'alerted'])
      .where('link_id', '=', id)
      .orderBy('created_at')
      .execute();
    return {
      deviationM: await this.settings.get('child.deviation_m'),
      deviationSeconds: await this.settings.get('child.deviation_seconds'),
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        points: r.points,
        active: r.active,
        offRoute: r.off_since !== null,
        alerted: r.alerted,
      })),
    };
  }

  async saveRoute(parentId: string, id: string, routeId: string, input: z.infer<typeof routeBody>) {
    await this.requireActive(parentId, id);
    const existing = await this.database.db
      .selectFrom('child_routes')
      .select('link_id')
      .where('id', '=', routeId)
      .executeTakeFirst();
    if (existing && existing.link_id !== id) throw appError.notFound('Route not found.');
    if (existing) {
      await this.database.db
        .updateTable('child_routes')
        .set({
          name: input.name,
          points: JSON.stringify(input.points),
          active: input.active,
          off_since: null,
          alerted: false,
        })
        .where('id', '=', routeId)
        .execute();
    } else {
      const n = await this.database.db
        .selectFrom('child_routes')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('link_id', '=', id)
        .executeTakeFirstOrThrow();
      if (Number(n.n) >= MAX_ROUTES)
        throw appError.limitReached(`You can set up to ${MAX_ROUTES} routes.`);
      await this.database.db
        .insertInto('child_routes')
        .values({
          id: routeId,
          link_id: id,
          name: input.name,
          points: JSON.stringify(input.points),
          active: input.active,
        })
        .execute();
    }
    await this.audit(id, existing ? 'route_changed' : 'route_added', parentId);
    return this.routes(parentId, id);
  }

  async deleteRoute(parentId: string, id: string, routeId: string) {
    await this.requireActive(parentId, id);
    await this.database.db
      .deleteFrom('child_routes')
      .where('id', '=', routeId)
      .where('link_id', '=', id)
      .execute();
    await this.audit(id, 'route_removed', parentId);
  }

  async alerts(parentId: string, id: string) {
    await this.gate.require('feature.child_safety');
    await this.ownLink(parentId, id);
    const rows = await this.database.db
      .selectFrom('child_alerts')
      .select(['id', 'kind', 'title', 'accuracy_m', 'approximate', 'acknowledged_at', 'created_at'])
      .where('link_id', '=', id)
      .orderBy('id', 'desc')
      .limit(60)
      .execute();
    return {
      items: rows.map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        accuracyM: a.accuracy_m,
        approximate: a.approximate,
        acknowledged: a.acknowledged_at !== null,
        createdAt: new Date(a.created_at).toISOString(),
      })),
    };
  }

  async acknowledge(parentId: string, alertId: string) {
    const a = await this.database.db
      .selectFrom('child_alerts as a')
      .innerJoin('child_links as l', 'l.id', 'a.link_id')
      .select(['a.id', 'a.link_id'])
      .where('a.id', '=', alertId)
      .where('l.parent_user_id', '=', parentId)
      .executeTakeFirst();
    if (!a) throw appError.notFound('Alert not found.');
    await this.database.db
      .updateTable('child_alerts')
      .set({ acknowledged_at: new Date() })
      .where('id', '=', alertId)
      .where('acknowledged_at', 'is', null)
      .execute();
    await this.audit(a.link_id, 'alert_acknowledged', parentId);
    return { ok: true };
  }

  // -- Child side ---------------------------------------------------------------------------

  async invitations(childId: string) {
    await this.gate.require('feature.child_safety');
    const me = await this.database.db
      .selectFrom('users')
      .select('phone')
      .where('id', '=', childId)
      .executeTakeFirstOrThrow();
    const rows = await this.database.db
      .selectFrom('child_links as l')
      .innerJoin('users as p', 'p.id', 'l.parent_user_id')
      .select(['l.id', 'l.child_name', 'l.created_at', 'p.name as parent_name'])
      .where('l.child_phone', '=', me.phone)
      .where('l.status', '=', 'invited')
      .orderBy('l.created_at', 'desc')
      .execute();
    const active = await this.database.db
      .selectFrom('child_links as l')
      .innerJoin('users as p', 'p.id', 'l.parent_user_id')
      .select(['l.id', 'p.name as parent_name', 'l.accepted_at'])
      .where('l.child_user_id', '=', childId)
      .where('l.status', '=', 'active')
      .execute();
    return {
      invitations: rows.map((r) => ({
        id: r.id,
        parentName: r.parent_name ?? 'A parent',
        createdAt: new Date(r.created_at).toISOString(),
      })),
      linkedParents: active.map((r) => ({
        linkId: r.id,
        parentName: r.parent_name ?? 'Your parent',
        since: r.accepted_at ? new Date(r.accepted_at).toISOString() : null,
      })),
      // Location is shared with the linked parent while child mode is on. No usage tracking is on.
      sharing: active.length > 0,
    };
  }

  async answer(childId: string, linkId: string, accept: boolean) {
    await this.gate.require('feature.child_safety');
    const me = await this.database.db
      .selectFrom('users')
      .select('phone')
      .where('id', '=', childId)
      .executeTakeFirstOrThrow();
    const link = await this.database.db
      .selectFrom('child_links')
      .selectAll()
      .where('id', '=', linkId)
      .where('child_phone', '=', me.phone)
      .executeTakeFirst();
    if (!link) throw appError.notFound('Invitation not found.');
    if (link.status !== 'invited') return { ok: true, status: link.status };
    if (!accept) {
      await this.database.db
        .updateTable('child_links')
        .set({ status: 'declined' })
        .where('id', '=', linkId)
        .execute();
      await this.audit(linkId, 'declined', childId);
      return { ok: true, status: 'declined' as const };
    }
    const parent = await this.database.db
      .selectFrom('users')
      .select(['name', 'phone'])
      .where('id', '=', link.parent_user_id)
      .executeTakeFirstOrThrow();
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('child_links')
        .set({ status: 'active', child_user_id: childId, accepted_at: new Date() })
        .where('id', '=', linkId)
        .execute();
      await trx
        .insertInto('child_link_events')
        .values({ link_id: linkId, action: 'accepted', actor_user_id: childId })
        .execute();
      // The parent becomes one of the child's Guardians, so a child's SOS reaches them like any SOS.
      const have = await trx
        .selectFrom('guardians')
        .select(['phone'])
        .where('user_id', '=', childId)
        .where('invite_status', '!=', 'declined')
        .execute();
      if (!have.some((g) => g.phone === parent.phone) && have.length < MAX_GUARDIANS) {
        await trx
          .insertInto('guardians')
          .values({
            user_id: childId,
            name: parent.name ?? 'Parent',
            phone: parent.phone,
            relation: 'parent',
            invite_status: 'accepted',
            responded_at: new Date(),
          })
          .execute();
      }
    });
    await this.messages.notifyUser(
      link.parent_user_id,
      'child_link',
      'Family link accepted',
      `${link.child_name} accepted your request.`,
      {
        linkId,
      },
    );
    return { ok: true, status: 'active' as const };
  }

  /** A location from the child's phone: updates the last position and may raise zone or route alerts. */
  async report(childId: string, input: z.infer<typeof locationBody>) {
    await this.gate.require('feature.child_safety');
    const links = await this.database.db
      .selectFrom('child_links')
      .select(['id', 'parent_user_id', 'child_name'])
      .where('child_user_id', '=', childId)
      .where('status', '=', 'active')
      .execute();
    if (links.length === 0) return { ok: true, links: 0 };
    const recordedAt = input.recordedAt ? new Date(input.recordedAt) : new Date();
    const acc = input.accuracyM ?? null;
    const maxAcc = await this.settings.get('child.max_accuracy_m');
    const devM = await this.settings.get('child.deviation_m');
    const devS = await this.settings.get('child.deviation_seconds');
    const point = sql<string>`ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography`;
    for (const link of links) {
      // An older point never replaces a newer one (phones send queued points late).
      const written = await this.database.db
        .insertInto('child_last_location')
        .values({ link_id: link.id, location: point, accuracy_m: acc, recorded_at: recordedAt })
        .onConflict((oc) =>
          oc
            .column('link_id')
            .doUpdateSet({
              location: point,
              accuracy_m: acc,
              recorded_at: recordedAt,
              received_at: new Date(),
            })
            .where('child_last_location.recorded_at', '<', recordedAt),
        )
        .returning('link_id')
        .executeTakeFirst();
      if (!written) continue;
      // A fix that is too rough to be sure about is shown as approximate and raises no alert.
      if (acc !== null && acc > maxAcc) continue;
      const margin = acc ?? 0;
      const zones = await this.database.db
        .selectFrom('child_zones')
        .select([
          'id',
          'name',
          'radius_m',
          'inside',
          sql<number>`ST_Y(center::geometry)`.as('lat'),
          sql<number>`ST_X(center::geometry)`.as('lng'),
        ])
        .where('link_id', '=', link.id)
        .execute();
      for (const zone of zones) {
        const d = distanceM(input.lat, input.lng, zone.lat, zone.lng);
        const inside =
          d + margin <= zone.radius_m ? true : d - margin > zone.radius_m ? false : null;
        if (inside === null || inside === zone.inside) continue;
        await this.database.db
          .updateTable('child_zones')
          .set({ inside, changed_at: new Date() })
          .where('id', '=', zone.id)
          .execute();
        // The first fix after a zone is set only records where the child is; it is not an alert.
        if (zone.inside === null) continue;
        await this.raise(
          link,
          inside ? 'zone_enter' : 'zone_exit',
          `${link.child_name} ${inside ? 'reached' : 'left'} ${zone.name}`,
          acc,
          {
            zoneId: zone.id,
          },
        );
      }
      const routes = await this.database.db
        .selectFrom('child_routes')
        .select(['id', 'name', 'points', 'off_since', 'alerted'])
        .where('link_id', '=', link.id)
        .where('active', '=', true)
        .execute();
      for (const route of routes) {
        const d = distanceToRouteM(input.lat, input.lng, route.points);
        if (d - margin > devM) {
          if (route.off_since === null) {
            await this.database.db
              .updateTable('child_routes')
              .set({ off_since: recordedAt })
              .where('id', '=', route.id)
              .execute();
          } else if (
            !route.alerted &&
            recordedAt.getTime() - new Date(route.off_since).getTime() >= devS * 1000
          ) {
            // Exactly one alert for one lasting deviation.
            const flipped = await this.database.db
              .updateTable('child_routes')
              .set({ alerted: true })
              .where('id', '=', route.id)
              .where('alerted', '=', false)
              .returning('id')
              .executeTakeFirst();
            if (flipped) {
              await this.raise(
                link,
                'route_deviation',
                `${link.child_name} is off the route “${route.name}”`,
                acc,
                {
                  routeId: route.id,
                },
              );
            }
          }
        } else if (d <= devM && (route.off_since !== null || route.alerted)) {
          await this.database.db
            .updateTable('child_routes')
            .set({ off_since: null, alerted: false })
            .where('id', '=', route.id)
            .execute();
        }
      }
    }
    return { ok: true, links: links.length };
  }

  private async raise(
    link: { id: string; parent_user_id: string },
    kind: 'zone_enter' | 'zone_exit' | 'route_deviation',
    title: string,
    accuracy: number | null,
    ref: { zoneId?: string; routeId?: string },
  ) {
    await this.database.db
      .insertInto('child_alerts')
      .values({
        link_id: link.id,
        kind,
        title,
        accuracy_m: accuracy,
        zone_id: ref.zoneId ?? null,
        route_id: ref.routeId ?? null,
        rule_version: RULE_VERSION,
      })
      .execute();
    await this.messages.notifyUser(
      link.parent_user_id,
      'child_alert',
      title,
      'Open Sarthi Rakshak to see the last update.',
      {
        linkId: link.id,
      },
    );
  }
}

@Controller('v1/child')
export class ChildController {
  constructor(
    private readonly child: ChildService,
    private readonly limiter: AppRateLimiter,
  ) {}

  @Get('links')
  links(@Req() req: AppRequest) {
    return this.child.links(req.user!.id);
  }

  @Post('links')
  @HttpCode(200)
  async create(@Req() req: AppRequest, @Body() body: unknown) {
    await this.limiter.check(`child-link:${req.user!.id}`, 10, 3600);
    return this.child.createLink(req.user!.id, parseAppBody(linkBody, body));
  }

  @Post('links/:id/revoke')
  @HttpCode(200)
  revoke(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.child.revoke(req.user!.id, id);
  }

  @Get('links/:id/zones')
  zones(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.child.zones(req.user!.id, id);
  }

  @Put('links/:id/zones/:zoneId')
  saveZone(
    @Req() req: AppRequest,
    @Param('id', uuid) id: string,
    @Param('zoneId', uuid) zoneId: string,
    @Body() body: unknown,
  ) {
    return this.child.saveZone(req.user!.id, id, zoneId, parseAppBody(zoneBody, body));
  }

  @Delete('links/:id/zones/:zoneId')
  @HttpCode(204)
  async deleteZone(
    @Req() req: AppRequest,
    @Param('id', uuid) id: string,
    @Param('zoneId', uuid) zoneId: string,
  ) {
    await this.child.deleteZone(req.user!.id, id, zoneId);
  }

  @Get('links/:id/routes')
  routes(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.child.routes(req.user!.id, id);
  }

  @Put('links/:id/routes/:routeId')
  saveRoute(
    @Req() req: AppRequest,
    @Param('id', uuid) id: string,
    @Param('routeId', uuid) routeId: string,
    @Body() body: unknown,
  ) {
    return this.child.saveRoute(req.user!.id, id, routeId, parseAppBody(routeBody, body));
  }

  @Delete('links/:id/routes/:routeId')
  @HttpCode(204)
  async deleteRoute(
    @Req() req: AppRequest,
    @Param('id', uuid) id: string,
    @Param('routeId', uuid) routeId: string,
  ) {
    await this.child.deleteRoute(req.user!.id, id, routeId);
  }

  @Get('links/:id/alerts')
  alerts(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.child.alerts(req.user!.id, id);
  }

  @Post('alerts/:alertId/acknowledge')
  @HttpCode(200)
  acknowledge(@Req() req: AppRequest, @Param('alertId') alertId: string) {
    if (!/^[0-9]{1,18}$/.test(alertId)) throw appError.notFound('Alert not found.');
    return this.child.acknowledge(req.user!.id, alertId);
  }

  @Get('invitations')
  invitations(@Req() req: AppRequest) {
    return this.child.invitations(req.user!.id);
  }

  @Post('invitations/:id/accept')
  @HttpCode(200)
  accept(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.child.answer(req.user!.id, id, true);
  }

  @Post('invitations/:id/decline')
  @HttpCode(200)
  decline(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.child.answer(req.user!.id, id, false);
  }

  @Post('location')
  @HttpCode(200)
  async location(@Req() req: AppRequest, @Body() body: unknown) {
    await this.limiter.check(`child-location:${req.user!.id}`, 600, 3600);
    return this.child.report(req.user!.id, parseAppBody(locationBody, body));
  }
}
