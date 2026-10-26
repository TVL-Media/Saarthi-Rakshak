import { createHmac, randomBytes } from 'node:crypto';
import { deriveAuthKeys } from './auth-keys';
import {
  findBackupCode,
  generateBackupCodes,
  hashBackupCode,
  normaliseBackupCode,
} from './backup-codes';
import { base32Decode, base32Encode } from './base32';
import { clearedSessionCookie, readCookie, sessionCookie } from './cookies';
import { decrypt, encrypt } from './crypto-box';
import { passwordProblem } from './password-rules';
import { otpauthUrl, timeStep, totpCode, verifyTotp } from './totp';

describe('base32', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('matches the RFC 4648 example %p', (text, encoded) => {
    expect(base32Encode(Buffer.from(text))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(text);
  });

  it('round-trips random secrets', () => {
    const secret = randomBytes(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });
});

describe('TOTP (RFC 6238)', () => {
  // Official test secret and 8-digit SHA-1 values from RFC 6238, Appendix B.
  const rfcSecret = Buffer.from('12345678901234567890');
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC test value at T=%i', (seconds, expected) => {
    expect(totpCode(rfcSecret, timeStep(seconds * 1000), 8)).toBe(expected);
  });

  const secret = randomBytes(20);
  const now = Date.UTC(2026, 9, 26, 12, 0, 15);
  const step = timeStep(now);

  it('accepts the current code and returns its step', () => {
    expect(verifyTotp(secret, totpCode(secret, step), now, null)).toBe(step);
  });

  it('accepts one step of clock drift either side, but not two', () => {
    expect(verifyTotp(secret, totpCode(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step + 2), now, null)).toBeNull();
  });

  it('refuses a code from a step already used (no replay)', () => {
    const code = totpCode(secret, step);
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step + 1), now, step)).toBe(step + 1);
  });

  it.each(['', '12345', '1234567', 'abcdef', '12 345'])('refuses a malformed code %p', (code) => {
    expect(verifyTotp(secret, code, now, null)).toBeNull();
  });

  it('builds an authenticator link with the secret in base32', () => {
    const url = new URL(otpauthUrl(secret, 'a@b.in'));
    expect(url.protocol).toBe('otpauth:');
    expect(url.searchParams.get('secret')).toBe(base32Encode(secret));
    expect(url.searchParams.get('issuer')).toBe('Sarthi Rakshak');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/Sarthi Rakshak:a@b.in');
  });
});

describe('deriveAuthKeys (HKDF)', () => {
  const master = Buffer.alloc(32, 1).toString('base64');
  const keys = deriveAuthKeys(master);

  it('derives two different 32-byte keys, neither equal to the setting', () => {
    expect(keys.totpSecretKey).toHaveLength(32);
    expect(keys.backupCodeKey).toHaveLength(32);
    expect(keys.totpSecretKey.equals(keys.backupCodeKey)).toBe(false);
    expect(keys.totpSecretKey.equals(Buffer.from(master, 'base64'))).toBe(false);
    expect(keys.backupCodeKey.equals(Buffer.from(master, 'base64'))).toBe(false);
  });

  it('gives the same keys for the same setting, and different keys for another', () => {
    expect(deriveAuthKeys(master)).toEqual(keys);
    const other = deriveAuthKeys(Buffer.alloc(32, 2).toString('base64'));
    expect(other.totpSecretKey.equals(keys.totpSecretKey)).toBe(false);
  });

  it('TOTP key encrypts secrets; the backup-code key cannot decrypt them', () => {
    const secret = randomBytes(20);
    const stored = encrypt(keys.totpSecretKey, secret, 'admin-1');
    expect(decrypt(keys.totpSecretKey, stored, 'admin-1').equals(secret)).toBe(true);
    expect(() => decrypt(keys.backupCodeKey, stored, 'admin-1')).toThrow();
  });

  it('backup-code key hashes codes; the TOTP key gives a different hash', () => {
    const [code] = generateBackupCodes(1);
    const hash = hashBackupCode(keys.backupCodeKey, code);
    expect(hash).toBe(
      createHmac('sha256', keys.backupCodeKey).update(normaliseBackupCode(code)).digest('hex'),
    );
    expect(hashBackupCode(keys.totpSecretKey, code)).not.toBe(hash);
    expect(findBackupCode(keys.totpSecretKey, code, [hash])).toBe(-1);
  });
});

describe('crypto-box (AES-256-GCM)', () => {
  const key = randomBytes(32);
  const secret = randomBytes(20);

  it('round-trips, with a different result each time', () => {
    const a = encrypt(key, secret, 'admin-1');
    expect(a).not.toBe(encrypt(key, secret, 'admin-1'));
    expect(decrypt(key, a, 'admin-1').equals(secret)).toBe(true);
    expect(a).not.toContain(secret.toString('base64'));
  });

  it('detects changed data', () => {
    const [v, iv, tag, ct] = encrypt(key, secret, 'admin-1').split('.');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() =>
      decrypt(key, [v, iv, tag, flipped.toString('base64')].join('.'), 'admin-1'),
    ).toThrow();
  });

  it('refuses a secret moved to another admin (context mismatch)', () => {
    expect(() => decrypt(key, encrypt(key, secret, 'admin-1'), 'admin-2')).toThrow();
  });
});

describe('backup codes', () => {
  const key = randomBytes(32);

  it('makes 10 different codes in the XXXXX-XXXXX-XXXX format', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{4}$/);
    }
  });

  it('finds a code however it is typed, and never stores it in plain form', () => {
    const codes = generateBackupCodes(3);
    const hashes = codes.map((c) => hashBackupCode(key, c));
    expect(hashes.join()).not.toContain(normaliseBackupCode(codes[1]));
    const typed = ` ${codes[1].toLowerCase().replace(/-/g, ' ')} `;
    expect(findBackupCode(key, typed, hashes)).toBe(1);
    expect(findBackupCode(key, 'AAAAA-AAAAA-AAAA', hashes)).toBe(-1);
  });
});

describe('passwordProblem', () => {
  it.each([
    ['short', /at least 12/],
    ['x'.repeat(129), /at most 128/],
    ['my-anjali.gupta-pw', /email name/],
  ])('refuses %p', (password, message) => {
    expect(passwordProblem(password, 'Anjali.Gupta@tvlmedia.in')).toMatch(message);
  });

  it('accepts a good password', () => {
    expect(passwordProblem('river-mango-lantern-42', 'anjali@tvlmedia.in')).toBeNull();
  });
});

describe('cookies', () => {
  it('reads one cookie from the header', () => {
    expect(readCookie('a=1; __Host-sr_admin=tok=en; b=2', '__Host-sr_admin')).toBe('tok=en');
    expect(readCookie(undefined, 'a')).toBeUndefined();
    expect(readCookie('xa=1', 'a')).toBeUndefined();
  });

  it('sets the session cookie with HttpOnly, Secure and SameSite=Strict', () => {
    expect(sessionCookie('abc', 600)).toBe(
      '__Host-sr_admin=abc; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600',
    );
    expect(clearedSessionCookie()).toMatch(/^__Host-sr_admin=; .*Max-Age=0$/);
  });
});
