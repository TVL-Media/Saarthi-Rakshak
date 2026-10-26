import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { BACKUP_CODE_COUNT } from './auth.constants';

/** Upper case and digits without look-alikes (0/O, 1/I/L). 31 characters × 14 ≈ 69 bits. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = [5, 5, 4];

/** Codes like `K7MPQ-X3RT9-WD4N`, shown to the admin once. */
export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, () =>
    GROUPS.map((size) =>
      Array.from({ length: size }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''),
    ).join('-'),
  );
}

/** Same code however it is typed: case, spaces and dashes do not matter. */
export function normaliseBackupCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/** HMAC-SHA256 with a server-side key (hex). A fast hash is fine: the codes are long and random. */
export function hashBackupCode(key: Buffer, code: string): string {
  return createHmac('sha256', key).update(normaliseBackupCode(code)).digest('hex');
}

/** Index of the stored hash that matches the code, or -1. Every comparison is constant-time. */
export function findBackupCode(key: Buffer, code: string, storedHashes: string[]): number {
  const given = Buffer.from(hashBackupCode(key, code), 'hex');
  let found = -1;
  storedHashes.forEach((stored, index) => {
    const candidate = Buffer.from(stored, 'hex');
    if (candidate.length === given.length && timingSafeEqual(candidate, given) && found === -1) {
      found = index;
    }
  });
  return found;
}
