import { Logger } from '@nestjs/common';
import type { App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { Env } from '../../config/env.schema';
import { appError } from '../common/app-http';
import { firebaseApp } from './firebase-app';

/**
 * Turns the token the app got from Firebase phone sign-in into a checked phone number.
 * Tests use FakePhoneTokenVerifier instead (NODE_ENV=test only).
 */
export interface PhoneLogin {
  /** The phone number (E.164) the token proves. */
  phone: string;
  /** Firebase's id for this login (used to delete it with the account). */
  uid: string;
  /** When the user last typed the OTP. */
  authTime: Date;
}

export abstract class PhoneTokenVerifier {
  /** Checks the token. Throws `not_logged_in` for a bad token. */
  abstract check(token: string): Promise<PhoneLogin>;

  /** Deletes the Firebase login (delete account). A login that is already gone is fine. */
  abstract deleteLogin(uid: string): Promise<void>;

  /** The phone number (E.164) the token proves. Throws `not_logged_in` for a bad token. */
  async verify(token: string): Promise<string> {
    return (await this.check(token)).phone;
  }
}

export class FirebasePhoneTokenVerifier extends PhoneTokenVerifier {
  private readonly logger = new Logger('FirebaseLogin');
  private readonly app: App | null;

  constructor(env: Env) {
    super();
    this.app = firebaseApp(env);
    if (!this.app) {
      this.logger.warn('FIREBASE_PROJECT_ID is not set: app login is off (see SETUP.md).');
    }
  }

  async check(token: string): Promise<PhoneLogin> {
    if (!this.app) {
      throw appError.serviceUnavailable('Login is not set up on this server yet.');
    }
    let decoded: {
      uid: string;
      auth_time: number;
      phone_number?: string;
      firebase?: { sign_in_provider?: string };
    };
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
    return {
      phone: decoded.phone_number,
      uid: decoded.uid,
      authTime: new Date(decoded.auth_time * 1000),
    };
  }

  async deleteLogin(uid: string): Promise<void> {
    if (!this.app) return;
    try {
      await getAuth(this.app).deleteUser(uid);
    } catch (err) {
      if ((err as { code?: string }).code === 'auth/user-not-found') return;
      throw err;
    }
  }
}

/**
 * For automated tests only: accepts tokens written as "test-phone:<number>", e.g.
 * "test-phone:+919812344521", optionally with "@<OTP time in Unix seconds>" (default: now).
 * Anything else is refused like a bad Firebase token.
 */
export class FakePhoneTokenVerifier extends PhoneTokenVerifier {
  /** uids of logins deleted through deleteLogin(), for tests to check. */
  readonly deleted: string[] = [];

  static token(phone: string, authTime?: Date): string {
    const at = authTime ? `@${Math.floor(authTime.getTime() / 1000)}` : '';
    return `test-phone:${phone}${at}`;
  }

  static uid(phone: string): string {
    return `test-uid-${phone.replace(/\D/g, '')}`;
  }

  check(token: string): Promise<PhoneLogin> {
    const match = /^test-phone:(\+\d{8,15})(?:@(\d{1,12}))?$/.exec(token);
    if (!match) return Promise.reject(appError.notLoggedIn());
    return Promise.resolve({
      phone: match[1],
      uid: FakePhoneTokenVerifier.uid(match[1]),
      authTime: match[2] ? new Date(Number(match[2]) * 1000) : new Date(),
    });
  }

  deleteLogin(uid: string): Promise<void> {
    this.deleted.push(uid);
    return Promise.resolve();
  }
}

export function phoneTokenVerifierFor(env: Env): PhoneTokenVerifier {
  return env.NODE_ENV === 'test'
    ? new FakePhoneTokenVerifier()
    : new FirebasePhoneTokenVerifier(env);
}
