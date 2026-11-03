import { isUnreachable } from './app-exception.filter';

describe('isUnreachable (503 instead of "Something went wrong")', () => {
  it('finds network errors from storage, database and Redis', () => {
    expect(
      isUnreachable(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8333'), { code: 'ECONNREFUSED' }),
      ),
    ).toBe(true);
    expect(isUnreachable(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    // Node puts several attempts (IPv4 + IPv6) in an AggregateError.
    expect(
      isUnreachable(
        new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' })], 'all failed'),
      ),
    ).toBe(true);
    // Wrapped by a library.
    expect(
      isUnreachable(
        new Error('upload failed', { cause: Object.assign(new Error('b'), { code: 'ENOTFOUND' }) }),
      ),
    ).toBe(true);
  });

  it('leaves real bugs as 500', () => {
    expect(isUnreachable(new TypeError('x is undefined'))).toBe(false);
    expect(isUnreachable('text')).toBe(false);
    expect(isUnreachable(null)).toBe(false);
  });
});
