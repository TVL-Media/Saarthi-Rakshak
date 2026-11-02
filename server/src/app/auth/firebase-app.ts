import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import type { Env } from '../../config/env.schema';

/**
 * The Firebase connection (login check and push), or null when FIREBASE_PROJECT_ID is not set.
 * The key file comes from GOOGLE_APPLICATION_CREDENTIALS (outside the project, never committed).
 */
export function firebaseApp(env: Env): App | null {
  if (!env.FIREBASE_PROJECT_ID) return null;
  return (
    getApps().find((a) => a.name === 'sarthi') ??
    initializeApp(
      { credential: applicationDefault(), projectId: env.FIREBASE_PROJECT_ID },
      'sarthi',
    )
  );
}
