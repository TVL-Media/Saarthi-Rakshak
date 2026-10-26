import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM. The stored text is `v1.<iv>.<tag>.<ciphertext>` (base64 parts).
// `context` (for example the admin id) is bound to the ciphertext, so a secret copied
// to another admin's row will not decrypt.

export function encrypt(key: Buffer, plaintext: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ciphertext].map((p) => p.toString('base64')).join('.');
}

/** Throws if the text was changed, the key is wrong or the context does not match. */
export function decrypt(key: Buffer, stored: string, context: string): Buffer {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unknown encrypted format');
  const [iv, tag, ciphertext] = parts.slice(1).map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
