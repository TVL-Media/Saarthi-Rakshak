// Phone numbers in the admin panel: searched by the exact full number only, and always shown
// masked (rule 7). Full numbers never leave the server.

/**
 * The number an admin typed, as stored (E.164, India): "98123 44521", "098123 44521" and
 * "+91 98123 44521" all become "+919812344521". Returns null if it is not a 10-digit Indian
 * mobile number (no partial numbers).
 */
export function normaliseIndianMobile(input: string): string | null {
  let digits = input.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/** "+919812344521" → "+91 98•• ••4521". Other formats keep only the first 2 and last 4 digits. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const india = /^\+91(\d{10})$/.exec(phone);
  if (india) {
    const d = india[1];
    return `+91 ${d.slice(0, 2)}•• ••${d.slice(6)}`;
  }
  const digits = phone.replace(/\D/g, '');
  return `+${digits.slice(0, 2)}•• ••${digits.slice(-4)}`;
}
