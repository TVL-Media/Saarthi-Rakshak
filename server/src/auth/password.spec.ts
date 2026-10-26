import {
  SCRYPT_SETTINGS,
  TEMP_PASSWORD_LENGTH,
  generateTemporaryPassword,
  hashPassword,
  verifyPassword,
} from './password';

describe('hashPassword / verifyPassword', () => {
  it('works with the chosen scrypt settings (N=2^16, r=8, p=2) and stores them in the hash', async () => {
    expect(SCRYPT_SETTINGS).toEqual({ N: 65536, r: 8, p: 2 });
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^scrypt\$65536\$8\$2\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse');
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
  });

  it('never contains the password itself', async () => {
    expect(await hashPassword('PlainTextSecret')).not.toContain('PlainTextSecret');
  });

  it('gives different hashes for the same password (random salt)', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('reads the scrypt settings from the stored hash, not from the code', async () => {
    const hash = await hashPassword('pw');
    const lighter = hash.replace('scrypt$65536$8$2$', 'scrypt$16384$8$1$');
    // Same salt and key, other settings: the stored settings are used, so it no longer matches.
    expect(await verifyPassword('pw', lighter)).toBe(false);
  });

  it.each([
    '',
    'nonsense',
    'bcrypt$1$2$3$4$5',
    'scrypt$x$8$2$abc$def',
    'scrypt$65536$8$2$abc$short',
  ])('treats a malformed stored hash (%p) as no match', async (stored) => {
    expect(await verifyPassword('pw', stored)).toBe(false);
  });
});

describe('generateTemporaryPassword', () => {
  it('has the right length and no look-alike characters', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateTemporaryPassword();
      expect(pw).toHaveLength(TEMP_PASSWORD_LENGTH);
      expect(pw).toMatch(/^[A-HJKMNP-Za-hjkmnp-z2-9]+$/);
    }
  });

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 100 }, generateTemporaryPassword));
    expect(seen.size).toBe(100);
  });
});
