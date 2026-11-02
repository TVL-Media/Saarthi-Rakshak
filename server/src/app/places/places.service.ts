import { Injectable } from '@nestjs/common';
import type { SavePlaceRequest, SavedPlace } from '@sarthi/shared';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import { appError } from '../common/app-http';

/** Saved places with the label "other" (Home and Work come on top). */
export const MAX_OTHER_PLACES = 8;

const LABEL_ORDER = sql<number>`CASE label WHEN 'home' THEN 0 WHEN 'work' THEN 1 ELSE 2 END`;

/** Home, Work and other saved places for Start journey. */
@Injectable()
export class PlacesService {
  constructor(private readonly database: DatabaseService) {}

  async list(userId: string): Promise<SavedPlace[]> {
    const rows = await this.database.db
      .selectFrom('saved_places')
      .select([
        'id',
        'label',
        'name',
        'address',
        sql<number>`ST_Y(location::geometry)`.as('lat'),
        sql<number>`ST_X(location::geometry)`.as('lng'),
      ])
      .where('user_id', '=', userId)
      .orderBy(LABEL_ORDER)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ ...r, lat: Number(r.lat), lng: Number(r.lng) }));
  }

  /** Saves a place; Home or Work again replaces the old one. */
  async save(userId: string, input: SavePlaceRequest): Promise<SavedPlace> {
    const location = sql<string>`ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography`;
    const values = {
      name: input.name,
      address: input.address || null,
      location,
    };

    const id = await this.database.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'places:' + userId}))`.execute(trx);

      if (input.label === 'other') {
        const { count } = await trx
          .selectFrom('saved_places')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('user_id', '=', userId)
          .where('label', '=', 'other')
          .executeTakeFirstOrThrow();
        if (Number(count) >= MAX_OTHER_PLACES) {
          throw appError.limitReached(`You can save up to ${MAX_OTHER_PLACES} other places.`);
        }
        const row = await trx
          .insertInto('saved_places')
          .values({ user_id: userId, label: 'other', ...values })
          .returning('id')
          .executeTakeFirstOrThrow();
        return row.id;
      }

      const existing = await trx
        .selectFrom('saved_places')
        .select('id')
        .where('user_id', '=', userId)
        .where('label', '=', input.label)
        .executeTakeFirst();
      if (existing) {
        await trx.updateTable('saved_places').set(values).where('id', '=', existing.id).execute();
        return existing.id;
      }
      const row = await trx
        .insertInto('saved_places')
        .values({ user_id: userId, label: input.label, ...values })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });

    return (await this.list(userId)).find((p) => p.id === id)!;
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.database.db
      .deleteFrom('saved_places')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (result.numDeletedRows === 0n) throw appError.notFound('Place not found.');
  }
}
