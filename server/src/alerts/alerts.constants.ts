/**
 * How many times one SMS to one guardian is tried (first send + retries) before it counts as
 * "all tries failed". The one place for this number: the Alert Log reads it now, and the worker
 * that sends and retries SMS must use it too.
 */
export const MAX_SMS_ATTEMPTS = 3;
