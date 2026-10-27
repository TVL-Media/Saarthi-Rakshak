/** Always India time (Asia/Kolkata), whatever time zone the computer uses. */
export const INDIA_TIME_ZONE = 'Asia/Kolkata';

/** e.g. "27 Oct 2026, 10:20". A dash if there is no time. */
export function formatTime(value: string | Date | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', {
    timeZone: INDIA_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** e.g. "27 Oct 2026, 10:20:05" (with seconds, for the audit log). */
export function formatTimeExact(value: string | Date): string {
  return new Date(value).toLocaleString('en-GB', {
    timeZone: INDIA_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Short time for busy tables: "14:19:18" today (India), otherwise "26 Oct, 14:19". */
export function formatTimeShort(value: string | Date): string {
  const date = new Date(value);
  const day = (d: Date) => d.toLocaleDateString('en-GB', { timeZone: INDIA_TIME_ZONE });
  if (day(date) === day(new Date())) {
    return date.toLocaleTimeString('en-GB', { timeZone: INDIA_TIME_ZONE, hour12: false });
  }
  return date.toLocaleString('en-GB', {
    timeZone: INDIA_TIME_ZONE,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
