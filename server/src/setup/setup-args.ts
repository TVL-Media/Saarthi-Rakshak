import { parseArgs } from 'node:util';
import { SetupError } from './setup';

export const USAGE = [
  'Usage:',
  '  pnpm app:setup                                   default settings only',
  '  pnpm app:setup --name "<name>" --email "<email>"  default settings + first Super Admin',
  '  pnpm app:setup --reissue --email "<email>"        new temporary password for an existing Super Admin',
  'Add --test to run against the test database.',
].join('\n');

export type SetupArgs =
  | { mode: 'settings'; test: boolean }
  | { mode: 'create'; name: string; email: string; test: boolean }
  | { mode: 'reissue'; email: string; test: boolean };

export function parseSetupArgs(argv: string[]): SetupArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        name: { type: 'string' },
        email: { type: 'string' },
        reissue: { type: 'boolean', default: false },
        test: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new SetupError(`${(err as Error).message}\n${USAGE}`);
  }
  const { name, email, reissue, test } = values;

  if (reissue) {
    if (name !== undefined) throw new SetupError(`--reissue does not take --name.\n${USAGE}`);
    if (!email) throw new SetupError(`--reissue needs --email.\n${USAGE}`);
    return { mode: 'reissue', email, test };
  }
  if (name === undefined && email === undefined) return { mode: 'settings', test };
  if (!name || !email) throw new SetupError(`Give both --name and --email.\n${USAGE}`);
  return { mode: 'create', name, email, test };
}
