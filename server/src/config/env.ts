import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** The one .env file at the project root (same path from src/config and dist/config). */
export const ROOT_ENV_FILE = resolve(__dirname, '..', '..', '..', '.env');

/**
 * Loads .env into process.env if the file exists. Real environment variables win over
 * the file, and with no file (as on DigitalOcean) only real environment variables are used.
 */
export function loadEnvFile(path = ROOT_ENV_FILE): void {
  if (!existsSync(path)) return;
  // Copied in by hand (not process.loadEnvFile) so it also reaches Jest's sandboxed process.env.
  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    process.env[key] ??= value;
  }
}
