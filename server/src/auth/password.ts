import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * scrypt settings (an OWASP-listed setting: N=2^16, r=8, p=2, about 64 MB per hash).
 * They are stored inside each hash, so they can be raised later without breaking old passwords.
 */
export const SCRYPT_SETTINGS = { N: 2 ** 16, r: 8, p: 2 } as const;
// Node's default scrypt memory limit is 32 MB, too low for these settings.
const MAX_MEMORY = 128 * 1024 * 1024;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** No look-alike characters (0/O, 1/l/I). 55 characters × 20 ≈ 115 bits. */
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export const TEMP_PASSWORD_LENGTH = 20;

function deriveKey(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...options, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Returns `scrypt$N$r$p$salt$hash` (salt and hash in base64). */
export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = SCRYPT_SETTINGS;
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** True only if the password matches. A malformed stored hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;

  const expected = Buffer.from(parts[5], 'base64');
  if (expected.length !== KEY_LENGTH) return false;
  const key = await deriveKey(password, Buffer.from(parts[4], 'base64'), { N, r, p });
  return timingSafeEqual(key, expected);
}

/** A one-time password, shown once and never stored in plain form. */
export function generateTemporaryPassword(): string {
  let password = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    password += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
  }
  return password;
}
