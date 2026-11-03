import { sql } from 'kysely';
import { maskPhone } from '../users/phone';

/**
 * SQL: a guardian's number for their user ("Guardian 1" = the first guardian they added).
 * Use with `guardians g`. The same numbering everywhere (Alert Log, History timeline).
 */
export const GUARDIAN_NUMBER = sql<number>`(
  SELECT count(*) FROM guardians g2
  WHERE g2.user_id = g.user_id AND (g2.created_at, g2.id) <= (g.created_at, g.id)
)::int`;

/** "Guardian 1 (brother) +91 98•• ••0001". Never the name or the full number. */
export function guardianLabel(
  guardian: { number: number; relation: string | null; phone: string | null } | null,
): string {
  if (!guardian) return 'a guardian (no longer listed)';
  const relation = guardian.relation ? ` (${guardian.relation})` : '';
  const phone = guardian.phone ? ` ${maskPhone(guardian.phone)}` : '';
  return `Guardian ${guardian.number}${relation}${phone}`;
}
