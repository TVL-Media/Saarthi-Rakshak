import { maskPhone, normaliseIndianMobile } from './phone';

describe('normaliseIndianMobile', () => {
  it.each([
    '9812344521',
    '98123 44521',
    '098123-44521',
    '+91 98123 44521',
    '+919812344521',
    '919812344521',
    '0091 9812344521',
  ])('reads %p as +919812344521', (input) => {
    expect(normaliseIndianMobile(input)).toBe('+919812344521');
  });

  it.each(['4521', '98123', '981234452', '98123445211', '1812344521', 'abcdefghij', ''])(
    'refuses %p (not a full 10-digit mobile number)',
    (input) => {
      expect(normaliseIndianMobile(input)).toBeNull();
    },
  );
});

describe('maskPhone', () => {
  it('masks an Indian number like the design', () => {
    expect(maskPhone('+919812344521')).toBe('+91 98•• ••4521');
  });

  it('never shows more than the first 2 and last 4 digits', () => {
    const masked = maskPhone('+447700900123')!;
    expect(masked.replace(/\D/g, '')).toHaveLength(6);
  });

  it('keeps an empty phone empty (a declined guardian has none)', () => {
    expect(maskPhone(null)).toBeNull();
  });
});
