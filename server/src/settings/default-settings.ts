/**
 * Phase 1 safety rules that a Super Admin can change in Settings, with their defaults (see
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
