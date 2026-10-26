import { createHmac, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './base32';

// RFC 6238 TOTP: HMAC-SHA1, 30-second steps, 6 digits (what authenticator apps use by default).
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the code for the previous, current and next step (clock drift of ±30 seconds). */
const DRIFT_STEPS = 1;

export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for one time step (RFC 4226 HOTP with the step as the counter). */
export function totpCode(secret: Buffer, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks a code. Returns the matching time step, or null.
 * Steps at or before lastUsedStep are refused, so a code can never be used twice.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const current = timeStep(nowMs);
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), given)) return step;
  }
  return null;
}

/** The link an authenticator app reads (the admin panel shows it as a QR code). */
export function otpauthUrl(secret: Buffer, accountEmail: string): string {
  const issuer = 'Sarthi Rakshak';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
