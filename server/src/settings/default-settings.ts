/**
 * Safety rules (Phase 1 and 2) that a Super Admin can change in Settings, with their defaults (see
 * CLAUDE.md) and allowed ranges. Whole numbers only. The setup command inserts any that are
 * missing; it never overwrites a value changed in Settings.
 */
export interface SettingDefinition {
  value: number;
  description: string;
  min: number;
  max: number;
}

export const DEFAULT_SETTINGS = {
  'sos.countdown_seconds': {
    value: 5,
    description: 'SOS countdown before alerts go out (seconds)',
    min: 3,
    max: 10,
  },
  'checkin.stopped_minutes': {
    value: 3,
    description: 'Check-in when stopped for this long during a journey (minutes)',
    min: 2,
    max: 15,
  },
  'checkin.off_route_metres': {
    value: 500,
    description: 'Check-in when this far off the route (metres)',
    min: 200,
    max: 2000,
  },
  'checkin.late_minutes': {
    value: 15,
    description: 'Check-in when this late for the expected arrival (minutes)',
    min: 5,
    max: 60,
  },
  'checkin.reply_wait_minutes': {
    value: 2,
    description: 'Wait for a check-in reply, then alert guardians (minutes; not a full SOS)',
    min: 1,
    max: 5,
  },
  'checkin.traffic_pause_minutes': {
    value: 10,
    description: '"Stuck in traffic" pauses check-ins for this long (minutes)',
    min: 5,
    max: 30,
  },
  'journey.lost_contact_minutes': {
    value: 5,
    description: 'Phone silent for this long: "Lost contact" alert to guardians (minutes)',
    min: 3,
    max: 15,
  },
  'sos.no_response_minutes': {
    value: 5,
    description:
      'No guardian responds to an SOS: re-send alerts and help the user call 112 (minutes)',
    min: 2,
    max: 10,
  },
  'guardian.link_live_after_end_minutes': {
    value: 15,
    description: 'Guardian live link stays open after the SOS ends (minutes)',
    min: 5,
    max: 60,
  },
  'audio.auto_delete_days': {
    value: 30,
    description: 'SOS audio is deleted after this many days unless the user keeps it',
    min: 7,
    max: 90,
  },
  'guardian.max_count': {
    value: 5,
    description: 'Maximum guardians per user',
    min: 1,
    max: 5,
  },
  // ---- Phase 2 ----
  'sos.photo_pairs_max': {
    value: 3,
    description: 'Front + back photo pairs the phone may take during one SOS',
    min: 1,
    max: 5,
  },
  'detection.shake_g_x10': {
    value: 25,
    description: 'Shake SOS: strength of each of the 3 shakes (tenths of g, 25 = 2.5 g)',
    min: 15,
    max: 40,
  },
  'detection.crash_g_x10': {
    value: 40,
    description: 'Crash detection: impact strength (tenths of g, 40 = 4 g)',
    min: 25,
    max: 80,
  },
  'detection.fall_g_x10': {
    value: 30,
    description: 'Fall detection: impact strength after a free fall (tenths of g, 30 = 3 g)',
    min: 20,
    max: 60,
  },
  'detection.countdown_seconds': {
    value: 10,
    description: 'Crash and fall: loud countdown before the SOS (seconds)',
    min: 5,
    max: 30,
  },
  'daily.battery_pause_pct': {
    value: 20,
    description: 'Full-day location pauses below this battery level until charging (%)',
    min: 10,
    max: 50,
  },
  'evidence.delete_lock_days': {
    value: 90,
    description:
      'Evidence cannot be deleted for this many days after capture (account deletion still works)',
    min: 0,
    max: 365,
  },
  'community.reports_per_day': {
    value: 5,
    description: 'Community reports one user may send per day',
    min: 1,
    max: 20,
  },
  'feature.shake': {
    value: 1,
    description: 'Shake SOS: 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.voice': {
    value: 1,
    description: 'Voice SOS: 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.photos': {
    value: 1,
    description: 'Photos at SOS start: 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.crash': {
    value: 1,
    description: 'Crash detection (beta): 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.fall': {
    value: 1,
    description: 'Fall detection (beta): 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.daily_location': {
    value: 1,
    description: 'Full-day location: 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.vault': {
    value: 1,
    description: 'Evidence vault: 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.community': {
    value: 1,
    description: 'Community feed: 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.rakshak': {
    value: 1,
    description: 'Rakshak sign-up: 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.plans': {
    value: 1,
    description: 'Plans and payments: 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  // ---- Phase 3 (customer side) ----
  'feature.nearby': {
    value: 0,
    description: 'Rakshaks Near Me: 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.bookings': {
    value: 0,
    description: 'Book a Rakshak and My Bookings: 1 = on, 0 = off for everyone (staged release switch)',
    min: 0,
    max: 1,
  },
  // ---- Phase 4 (staged release switches: 1 = on for everyone, 0 = off) ----
  'feature.night_mode': {
    value: 0,
    description: 'Night Mode and Essential Safety Tools: 1 = on, 0 = off (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.safe_places': {
    value: 0,
    description: 'Nearby Safe Place Finder: 1 = on, 0 = off (staged release switch)',
    min: 0,
    max: 1,
  },
  'feature.women_safety': {
    value: 0,
    description: 'Women Safety home, harassment reports, support network and guidance: 1 = on, 0 = off',
    min: 0,
    max: 1,
  },
  'feature.legal_support': {
    value: 0,
    description: "Men's Safety and Legal Support (workplace and disputed-allegation reports, lawyers): 1 = on, 0 = off",
    min: 0,
    max: 1,
  },
  'feature.child_safety': {
    value: 0,
    description: 'Child Safety (family link, zones, route alerts): 1 = on, 0 = off (staged release switch)',
    min: 0,
    max: 1,
  },
  // Starting values; admins can change them in Settings.
  'safe_places.cache_minutes': {
    value: 60,
    description: 'How long a nearby-places search from the map provider is kept before asking again',
    min: 5,
    max: 1440,
  },
  'child.max_accuracy_m': {
    value: 100,
    description: 'A child location less accurate than this never raises a definite zone or route alert',
    min: 20,
    max: 500,
  },
  'child.deviation_m': {
    value: 150,
    description: 'How far from the set route counts as off route for a child',
    min: 50,
    max: 1000,
  },
  'child.deviation_seconds': {
    value: 120,
    description: 'How long a child must stay off route before one alert is raised',
    min: 30,
    max: 1800,
  },
  'child.stale_gps_minutes': {
    value: 15,
    description: 'After this long without a child location the parent sees a "GPS is stale" warning',
    min: 5,
    max: 240,
  },
  // ---- Phase 4, second group (staged release switches, default off) ----
  'feature.chhupa_rakshak': {
    value: 0,
    description: 'Chhupa Rakshak (consented one-way child check): 1 = on, 0 = off',
    min: 0,
    max: 1,
  },
  'feature.school': {
    value: 0,
    description: 'School Monitoring (attendance events sent by verified schools): 1 = on, 0 = off',
    min: 0,
    max: 1,
  },
  'feature.cyber_safety': {
    value: 0,
    description: 'Cyberbullying Detection on content a family chooses to share: 1 = on, 0 = off',
    min: 0,
    max: 1,
  },
  'feature.smart_glasses': {
    value: 0,
    description: 'Smart Glasses device registry and capture queue: 1 = on, 0 = off',
    min: 0,
    max: 1,
  },
  'feature.safe_route': {
    value: 0,
    description: 'AI Safety Scoring and Safer Route: 1 = on, 0 = off',
    min: 0,
    max: 1,
  },
  'feature.police_handoff': {
    value: 0,
    description: 'Police / ERSS handoff status on SOS (only when an endpoint is approved and enabled): 1 = on, 0 = off',
    min: 0,
    max: 1,
  },
  'monitor.expiry_minutes': {
    value: 15,
    description: 'A Chhupa Rakshak session stops by itself after this many minutes',
    min: 1,
    max: 120,
  },
  'monitor.retention_days': {
    value: 7,
    description: 'Chhupa Rakshak location samples are deleted after this many days',
    min: 1,
    max: 90,
  },
  'school.stale_feed_hours': {
    value: 48,
    description: 'A school that has sent nothing for this long shows a stale-feed warning',
    min: 1,
    max: 720,
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(DEFAULT_SETTINGS, key);
}

/**
 * Fixed rules: decided once, not settings, so they can never be changed through the API.
 * The SOS countdown is always cancelled without a PIN (speed matters more than a PIN).
 */
export const FIXED_RULES = {
  sosCountdownCancelNeedsPin: false,
} as const;
