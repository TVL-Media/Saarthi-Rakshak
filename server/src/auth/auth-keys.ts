import { hkdfSync } from 'node:crypto';

export interface AuthKeys {
  /** AES-256-GCM key for authenticator secrets. */
  totpSecretKey: Buffer;
  /** HMAC-SHA256 key for backup codes. */
  backupCodeKey: Buffer;
}

export const AUTH_KEYS = Symbol('AUTH_KEYS');

/**
 * Derives two separate keys from the one ADMIN_TOTP_ENCRYPTION_KEY setting (HKDF-SHA256),
 * so the same key bytes are never used for two different jobs.
 */
export function deriveAuthKeys(base64Key: string): AuthKeys {
  const master = Buffer.from(base64Key, 'base64');
  const derive = (info: string) =>
    Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  return {
    totpSecretKey: derive('sarthi-rakshak admin totp-secret aes-256-gcm v1'),
    backupCodeKey: derive('sarthi-rakshak admin backup-code hmac-sha256 v1'),
  };
}
