import { Logger } from '@nestjs/common';
import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { Env } from '../../config/env.schema';
import { appError } from '../common/app-http';

/**
 * Turns the token the app got from Firebase phone sign-in into a checked phone number.
 * Tests use FakePhoneTokenVerifier instead (NODE_ENV=test only).
 */
export abstract class PhoneTokenVerifier {
  /** The phone number (E.164) the token proves. Throws `not_logged_in` for a bad token. */
  abstract verify(token: string): Promise<string>;
}

export class FirebasePhoneTokenVerifier extends PhoneTokenVerifier {
  private readonly logger = new Logger('FirebaseLogin');
  private readonly app: App | null;

  constructor(env: Env) {
    super();
    if (!env.FIREBASE_PROJECT_ID) {
      this.logger.warn('FIREBASE_PROJECT_ID is not set: app login is off (see SETUP.md).');
      this.app = null;
      return;
    }
    // The key file comes from GOOGLE_APPLICATION_CREDENTIALS (outside the project, never committed).
    this.app =
      getApps().find((a) => a.name === 'sarthi') ??
      initializeApp(
        { credential: applicationDefault(), projectId: env.FIREBASE_PROJECT_ID },
        'sarthi',
      );
  }

  async verify(token: string): Promise<string> {
    if (!this.app) {
      throw appError.serviceUnavailable('Login is not set up on this server yet.');
    }
    let decoded: { phone_number?: string; firebase?: { sign_in_provider?: string } };
    try {
      decoded = await getAuth(this.app).verifyIdToken(token);
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      // A wrong or expired token is the user's problem; anything else is ours.
      if (code.startsWith('auth/')) throw appError.notLoggedIn();
      this.logger.error(`Firebase check failed: ${(err as Error).message}`);
      throw appError.serviceUnavailable('Login is not available right now. Please try again.');
    }
    if (decoded.firebase?.sign_in_provider !== 'phone' || !decoded.phone_number) {
      throw appError.notLoggedIn();
    }
    return decoded.phone_number;
  }
}

/**
 * For automated tests only: accepts tokens written as "test-phone:<number>", e.g.
 * "test-phone:+919812344521". Anything else is refused like a bad Firebase token.
 */
export class FakePhoneTokenVerifier extends PhoneTokenVerifier {
  static token(phone: string): string {
    return `test-phone:${phone}`;
  }

  verify(token: string): Promise<string> {
    const match = /^test-phone:(\+\d{8,15})$/.exec(token);
    if (!match) return Promise.reject(appError.notLoggedIn());
    return Promise.resolve(match[1]);
  }
}

export function phoneTokenVerifierFor(env: Env): PhoneTokenVerifier {
  return env.NODE_ENV === 'test'
    ? new FakePhoneTokenVerifier()
    : new FirebasePhoneTokenVerifier(env);
}
