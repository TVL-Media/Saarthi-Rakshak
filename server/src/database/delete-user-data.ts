import type { Transaction } from 'kysely';
import type { Database } from './types';

export interface DeleteUserDataResult {
  deleted: boolean;
  /** Audio files to remove from storage (Spaces) once the transaction has committed. */
  mediaStorageKeys: string[];
}

/**
 * "Delete my account": removes everything personal about a user, step by step.
 * SOS events and alerts are kept but anonymised, so pilot reports still add up.
 * Must run inside a transaction, so it either fully happens or not at all.
 */
export async function deleteUserData(
  trx: Transaction<Database>,
  userId: string,
): Promise<DeleteUserDataResult> {
  const journeyIds = trx.selectFrom('journeys').select('id').where('user_id', '=', userId);
  const guardianIds = trx.selectFrom('guardians').select('id').where('user_id', '=', userId);

  const clips = await trx
    .selectFrom('media_clips')
    .select('storage_key')
    .where('user_id', '=', userId)
    .execute();

  // Phase 2 files: SOS photos, encrypted evidence and Rakshak documents. The rows go with the
  // user (ON DELETE CASCADE); the files are deleted by the caller after the commit.
  const photos = await trx
    .selectFrom('sos_photos')
    .select('storage_key')
    .where('user_id', '=', userId)
    .execute();
  const evidence = await trx
    .selectFrom('evidence_items')
    .select('storage_key')
    .where('user_id', '=', userId)
    .where('storage_key', 'is not', null)
    .execute();
  const rakshak = await trx
    .selectFrom('rakshak_applications')
    .select('documents')
    .where('user_id', '=', userId)
    .execute();
  const rakshakKeys = rakshak.flatMap((r) =>
    Object.values((r.documents ?? {}) as Record<string, string>),
  );

  // 1. Personal event data.
  await trx.deleteFrom('sos_photos').where('user_id', '=', userId).execute();
  await trx.deleteFrom('location_points').where('user_id', '=', userId).execute();
  await trx.deleteFrom('checkins').where('journey_id', 'in', journeyIds).execute();
  await trx.deleteFrom('guardian_links').where('guardian_id', 'in', guardianIds).execute();
  await trx.deleteFrom('media_clips').where('user_id', '=', userId).execute();
  await trx.deleteFrom('support_tickets').where('user_id', '=', userId).execute();

  // 2. Keep alerts and SOS events, but cut every link back to the person.
  await trx
    .updateTable('alerts')
    .set({ guardian_id: null })
    .where('guardian_id', 'in', guardianIds)
    .execute();
  await trx
    .updateTable('alerts')
    .set({ journey_id: null })
    .where('journey_id', 'in', journeyIds)
    .execute();
  await trx
    .updateTable('sos_events')
    .set({ user_id: null, journey_id: null })
    .where('user_id', '=', userId)
    .execute();

  // 3. The person themselves.
  await trx.deleteFrom('journeys').where('user_id', '=', userId).execute();
  await trx.deleteFrom('guardians').where('user_id', '=', userId).execute();
  await trx.deleteFrom('devices').where('user_id', '=', userId).execute();
  const result = await trx.deleteFrom('users').where('id', '=', userId).executeTakeFirst();

  return {
    deleted: result.numDeletedRows > 0n,
    mediaStorageKeys: [
      ...clips.map((c) => c.storage_key),
      ...photos.map((p) => p.storage_key),
      ...evidence.map((e) => e.storage_key!),
      ...rakshakKeys,
    ],
  };
}
