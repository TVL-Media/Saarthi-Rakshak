import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { NO_MIGRATIONS } from 'kysely/migration';
import { deleteUserData } from '../src/database/delete-user-data';
import { createMigrator, migrations } from '../src/database/migrator';
import type { Database } from '../src/database/types';
import { TABLES, openTestDatabase } from './test-database';

let db: Kysely<Database>;

beforeAll(async () => {
  db = await openTestDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

class Rollback extends Error {}

/** Runs a test inside a transaction that is always rolled back, so no rows are left behind. */
async function inRollback(fn: (trx: Transaction<Database>) => Promise<void>): Promise<void> {
  await expect(
    db.transaction().execute(async (trx) => {
      await fn(trx);
      throw new Rollback();
    }),
  ).rejects.toBeInstanceOf(Rollback);
}

async function addUser(trx: Transaction<Database>, phone = '+919800004521') {
  return trx.insertInto('users').values({ phone }).returning('id').executeTakeFirstOrThrow();
}

async function addSos(trx: Transaction<Database>, userId: string) {
  return trx
    .insertInto('sos_events')
    .values({ id: randomUUID(), user_id: userId, trigger: 'button', started_at: new Date() })
    .returning('id')
    .executeTakeFirstOrThrow();
}

const NOIDA_SECTOR_18 = sql<string>`ST_MakePoint(77.326, 28.5708)::geography`;
const BOTANICAL_GARDEN = sql<string>`ST_MakePoint(77.334, 28.564)::geography`;

describe('migrations', () => {
  it('create all 14 tables', async () => {
    const { rows } = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${TABLES})
    `.execute(db);
    expect(rows.map((r) => r.table_name).sort()).toEqual(TABLES);
  });

  it('do nothing when run a second time', async () => {
    const { error, results } = await createMigrator(db).migrateToLatest();
    expect(error).toBeUndefined();
    expect(results).toEqual([]);
  });

  it('can all be undone and run again', async () => {
    const migrator = createMigrator(db);
    const down = await migrator.migrateTo(NO_MIGRATIONS);
    expect(down.error).toBeUndefined();
    expect(down.results).toHaveLength(Object.keys(migrations).length);

    const up = await migrator.migrateToLatest();
    expect(up.error).toBeUndefined();
    expect(up.results?.every((r) => r.status === 'Success')).toBe(true);
  });
});

describe('rules in the database', () => {
  it('refuses unknown values (admin role)', () =>
    inRollback(async (trx) => {
      await expect(
        trx
          .insertInto('admins')
          .values({
            email: 'a@example.com',
            name: 'A',
            role: 'hacker' as never,
            password_hash: 'x',
          })
          .execute(),
      ).rejects.toThrow(/admins_role_check/);
    }));

  it('refuses two users with the same phone', () =>
    inRollback(async (trx) => {
      await addUser(trx);
      await expect(addUser(trx)).rejects.toThrow(/users_phone_key/);
    }));

  it('refuses a declined guardian who still has a phone number', () =>
    inRollback(async (trx) => {
      const user = await addUser(trx);
      await expect(
        trx
          .insertInto('guardians')
          .values({
            user_id: user.id,
            name: 'G',
            phone: '+919800000001',
            invite_status: 'declined',
          })
          .execute(),
      ).rejects.toThrow(/guardians_declined_has_no_phone/);
    }));

  it('stores locations and measures real distances in metres (PostGIS)', () =>
    inRollback(async (trx) => {
      const user = await addUser(trx);
      const sos = await addSos(trx, user.id);
      await trx
        .insertInto('location_points')
        .values({
          user_id: user.id,
          sos_event_id: sos.id,
          location: NOIDA_SECTOR_18,
          recorded_at: new Date(),
        })
        .execute();

      const { rows } = await sql<{ metres: number }>`
        SELECT ST_Distance(location, ${BOTANICAL_GARDEN}) AS metres
        FROM location_points WHERE sos_event_id = ${sos.id}
      `.execute(trx);
      expect(rows[0].metres).toBeGreaterThan(1000);
      expect(rows[0].metres).toBeLessThan(1200);
    }));
});

describe('audit_log is append-only', () => {
  it('refuses UPDATE', () =>
    inRollback(async (trx) => {
      const row = await trx
        .insertInto('audit_log')
        .values({ action: 'test.check' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expect(
        trx.updateTable('audit_log').set({ action: 'changed' }).where('id', '=', row.id).execute(),
      ).rejects.toThrow(/append-only/);
    }));

  it('refuses DELETE', () =>
    inRollback(async (trx) => {
      const row = await trx
        .insertInto('audit_log')
        .values({ action: 'test.check' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expect(trx.deleteFrom('audit_log').where('id', '=', row.id).execute()).rejects.toThrow(
        /append-only/,
      );
    }));

  it('refuses TRUNCATE', () =>
    inRollback(async (trx) => {
      await trx.insertInto('audit_log').values({ action: 'test.check' }).execute();
      await expect(sql`TRUNCATE audit_log`.execute(trx)).rejects.toThrow(/append-only/);
    }));
});

describe('sos_events are protected', () => {
  it('allows status, ended_at and end_reason to change', () =>
    inRollback(async (trx) => {
      const user = await addUser(trx);
      const sos = await addSos(trx, user.id);
      await trx
        .updateTable('sos_events')
        .set({ status: 'ended', ended_at: new Date(), end_reason: 'user_safe' })
        .where('id', '=', sos.id)
        .execute();
      const row = await trx
        .selectFrom('sos_events')
        .select('status')
        .where('id', '=', sos.id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('ended');
    }));

  it.each([
    ['trigger', { trigger: 'widget' as const }],
    ['is_test', { is_test: true }],
    ['started_at', { started_at: new Date('2020-01-01') }],
  ])('refuses changing %s', (_name, change) =>
    inRollback(async (trx) => {
      const user = await addUser(trx);
      const sos = await addSos(trx, user.id);
      await expect(
        trx.updateTable('sos_events').set(change).where('id', '=', sos.id).execute(),
      ).rejects.toThrow(/core facts/);
    }),
  );

  it('refuses moving an SOS to another user', () =>
    inRollback(async (trx) => {
      const user = await addUser(trx);
      const other = await addUser(trx, '+919800009999');
      const sos = await addSos(trx, user.id);
      await expect(
        trx.updateTable('sos_events').set({ user_id: other.id }).where('id', '=', sos.id).execute(),
      ).rejects.toThrow(/core facts/);
    }));

  it('refuses DELETE', () =>
    inRollback(async (trx) => {
      const user = await addUser(trx);
      const sos = await addSos(trx, user.id);
      await expect(trx.deleteFrom('sos_events').where('id', '=', sos.id).execute()).rejects.toThrow(
        /cannot be deleted/,
      );
    }));
});

describe('deleteUserData ("delete my account")', () => {
  it('deletes personal rows and keeps SOS events and alerts anonymised', () =>
    inRollback(async (trx) => {
      const user = await addUser(trx);
      const keepUser = await addUser(trx, '+919800009999');
      const keepSos = await addSos(trx, keepUser.id);

      await trx.insertInto('devices').values({ user_id: user.id, model: 'Redmi' }).execute();
      const guardian = await trx
        .insertInto('guardians')
        .values({ user_id: user.id, name: 'Maa', phone: '+919800000001' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const journey = await trx
        .insertInto('journeys')
        .values({ user_id: user.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      const sos = await addSos(trx, user.id);
      await trx
        .updateTable('sos_events')
        .set({ journey_id: journey.id })
        .where('id', '=', sos.id)
        .execute();
      await trx
        .insertInto('location_points')
        .values([
          {
            user_id: user.id,
            sos_event_id: sos.id,
            location: NOIDA_SECTOR_18,
            recorded_at: new Date(),
          },
          {
            user_id: user.id,
            journey_id: journey.id,
            location: NOIDA_SECTOR_18,
            recorded_at: new Date(),
          },
        ])
        .execute();
      await trx
        .insertInto('checkins')
        .values({ journey_id: journey.id, reason: 'stopped' })
        .execute();
      await trx
        .insertInto('guardian_links')
        .values({
          guardian_id: guardian.id,
          sos_event_id: sos.id,
          token_hash: randomUUID(),
          expires_at: new Date(),
        })
        .execute();
      await trx
        .insertInto('media_clips')
        .values({
          user_id: user.id,
          sos_event_id: sos.id,
          storage_key: 'audio/clip-1.enc',
          delete_after: new Date(),
        })
        .execute();
      await trx
        .insertInto('support_tickets')
        .values({ user_id: user.id, category: 'sms', message: 'My mother got no SMS' })
        .execute();
      await trx
        .insertInto('alerts')
        .values([
          { sos_event_id: sos.id, guardian_id: guardian.id, channel: 'sms', type: 'sos' },
          {
            journey_id: journey.id,
            guardian_id: guardian.id,
            channel: 'push',
            type: 'checkin_no_reply',
          },
        ])
        .execute();

      const result = await deleteUserData(trx, user.id);
      expect(result).toEqual({ deleted: true, mediaStorageKeys: ['audio/clip-1.enc'] });

      // Personal rows are gone.
      const count = async (table: keyof Database, column: string, value: string) => {
        const { rows } = await sql<{ n: string }>`
          SELECT count(*) AS n FROM ${sql.table(table)} WHERE ${sql.ref(column)} = ${value}
        `.execute(trx);
        return Number(rows[0].n);
      };
      expect(await count('users', 'id', user.id)).toBe(0);
      for (const table of [
        'devices',
        'guardians',
        'journeys',
        'location_points',
        'media_clips',
        'support_tickets',
      ] as const) {
        expect(await count(table, 'user_id', user.id)).toBe(0);
      }
      expect(await count('checkins', 'journey_id', journey.id)).toBe(0);
      expect(await count('guardian_links', 'guardian_id', guardian.id)).toBe(0);

      // The SOS and its alerts are kept, with no link back to the person.
      const keptSos = await trx
        .selectFrom('sos_events')
        .selectAll()
        .where('id', '=', sos.id)
        .executeTakeFirstOrThrow();
      expect(keptSos).toMatchObject({ user_id: null, journey_id: null, trigger: 'button' });
      const keptAlerts = await trx
        .selectFrom('alerts')
        .select(['sos_event_id', 'journey_id', 'guardian_id', 'type'])
        .where('type', 'in', ['sos', 'checkin_no_reply'])
        .orderBy('type')
        .execute();
      expect(keptAlerts).toEqual([
        { type: 'checkin_no_reply', sos_event_id: null, journey_id: null, guardian_id: null },
        { type: 'sos', sos_event_id: sos.id, journey_id: null, guardian_id: null },
      ]);

      // Other users are untouched.
      expect(await count('users', 'id', keepUser.id)).toBe(1);
      expect(await count('sos_events', 'user_id', keepUser.id)).toBe(1);
      expect(keepSos.id).toBeDefined();
    }));

  it('reports nothing deleted for an unknown user', () =>
    inRollback(async (trx) => {
      expect(await deleteUserData(trx, randomUUID())).toEqual({
        deleted: false,
        mediaStorageKeys: [],
      });
    }));
});
