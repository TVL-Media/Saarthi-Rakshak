import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { Env } from '../../config/env.schema';
import type { Database } from '../../database/types';

/**
 * Live-link codes are derived from the link's id with GUARDIAN_LINK_KEY, so the server can put the
 * same link in later messages (reminder, lost contact) while storing only a hash of the code.
 */
export function guardianLinkCode(env: Env, linkId: string): string {
  return createHmac('sha256', Buffer.from(env.GUARDIAN_LINK_KEY, 'base64'))
    .update(`guardian-link:${linkId}`)
    .digest('base64url');
}

export const hashLinkCode = (code: string) => createHash('sha256').update(code).digest('hex');

export const liveLinkUrl = (env: Env, linkId: string) =>
  `${env.GUARDIAN_WEB_URL}/l/${guardianLinkCode(env, linkId)}`;

/** A new link id with its code and stored hash. */
export function newGuardianLink(env: Env): { id: string; code: string; tokenHash: string } {
  const id = randomUUID();
  const code = guardianLinkCode(env, id);
  return { id, code, tokenHash: hashLinkCode(code) };
}

export interface LinkedGuardian {
  linkId: string;
  guardianId: string;
  phone: string;
  name: string;
  inviteStatus: 'pending' | 'accepted' | 'declined';
}

/** Guardians with a live link for this SOS or journey who still have a phone number. */
export async function linkedGuardians(
  db: Kysely<Database> | Transaction<Database>,
  column: 'sos_event_id' | 'journey_id',
  id: string,
): Promise<LinkedGuardian[]> {
  const rows = await db
    .selectFrom('guardian_links as l')
    .innerJoin('guardians as g', 'g.id', 'l.guardian_id')
    .select(['l.id as linkId', 'g.id as guardianId', 'g.phone', 'g.name', 'g.invite_status'])
    .where(`l.${column}`, '=', id)
    .where('g.phone', 'is not', null)
    .orderBy('l.created_at')
    .execute();
  return rows.map((r) => ({
    linkId: r.linkId,
    guardianId: r.guardianId,
    phone: r.phone!,
    name: r.name,
    inviteStatus: r.invite_status,
  }));
}

/** The user's name for messages to guardians. */
export async function userDisplayName(db: Kysely<Database>, userId: string): Promise<string> {
  const user = await db
    .selectFrom('users')
    .select('name')
    .where('id', '=', userId)
    .executeTakeFirst();
  return user?.name?.trim() || 'Someone who added you as a guardian';
}
