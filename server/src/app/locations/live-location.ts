/** Redis names for live data. Part B (timers) and the live pages read the same names. */
export const liveKeys = {
  /** Newest point of an SOS or journey (hash). */
  latest: (kind: 'sos' | 'journey', id: string) => `loc:last:${kind}:${id}`,
  /** Pub/sub channel: every new point of an SOS or journey (JSON LivePoint). */
  channel: (kind: 'sos' | 'journey', id: string) => `${kind}:${id}:location`,
  /** Sorted set: user id → time of the last heartbeat (ms). Read by the lost-contact check. */
  heartbeats: 'heartbeats',
  /** Hash per user: battery, network and time of the last heartbeat. */
  heartbeat: (userId: string) => `hb:${userId}`,
};

/** What the live pages receive for each point (no names or phone numbers). */
export interface LivePoint {
  sosId: string | null;
  journeyId: string | null;
  lat: number;
  lng: number;
  accuracyM: number | null;
  batteryPct: number | null;
  network: string | null;
  recordedAt: string;
}

/** Latest points are kept this long after the last update. */
export const LATEST_TTL_SECONDS = 24 * 3600;
