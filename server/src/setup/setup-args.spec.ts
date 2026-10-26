import { parseSetupArgs } from './setup-args';

describe('parseSetupArgs', () => {
  it('with no options: settings only', () => {
    expect(parseSetupArgs([])).toEqual({ mode: 'settings', test: false });
  });

  it('with --name and --email: create the first Super Admin', () => {
    expect(parseSetupArgs(['--name', 'A B', '--email', 'a@b.in', '--test'])).toEqual({
      mode: 'create',
      name: 'A B',
      email: 'a@b.in',
      test: true,
    });
  });

  it('with --reissue and --email: reissue', () => {
    expect(parseSetupArgs(['--reissue', '--email', 'a@b.in'])).toEqual({
      mode: 'reissue',
      email: 'a@b.in',
      test: false,
    });
  });

  it.each([
    [['--name', 'A B'], /both --name and --email/],
    [['--email', 'a@b.in'], /both --name and --email/],
    [['--reissue'], /--reissue needs --email/],
    [['--reissue', '--email', 'a@b.in', '--name', 'A'], /--reissue does not take --name/],
    [['--password', 'x'], /Unknown option/],
  ])('refuses %j with a clear message', (argv, message) => {
    expect(() => parseSetupArgs(argv)).toThrow(message);
  });
});
