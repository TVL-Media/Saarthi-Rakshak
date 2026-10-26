/**
 * Phase 1 safety rules and their defaults (see CLAUDE.md). The setup command inserts any that
 * are missing; it never overwrites a value changed in Settings. min/max are for the Settings screen.
 */
export interface SettingDefinition {
  value: number | boolean;
  description: string;
  min?: number;
  max?: number;
}

export const DEFAULT_SETTINGS = {
  'sos.countdown_seconds': {
    value: 5,
    description: 'SOS countdown before alerts go out (seconds)',
    min: 3,
    max: 30,
  },
  'sos.cancel_requires_pin': {
    value: false,
    description: 'Whether cancelling the SOS countdown needs a PIN',
  },
  'sos.no_response_minutes': {
    value: 5,
    description:
      'No guardian responds to an SOS: re-send alerts and help the user call 112 (minutes)',
    min: 1,
    max: 30,
  },
  'checkin.stopped_minutes': {
    value: 3,
    description: 'Check-in when stopped for this long during a journey (minutes)',
    min: 1,
    max: 30,
  },
  'checkin.off_route_metres': {
    value: 500,
    description: 'Check-in when this far off the route (metres)',
    min: 100,
    max: 5000,
  },
  'checkin.late_minutes': {
    value: 15,
    description: 'Check-in when this late for the expected arrival (minutes)',
    min: 5,
    max: 120,
  },
  'checkin.reply_wait_minutes': {
    value: 2,
    description: 'Wait for a check-in reply, then alert guardians (minutes; not a full SOS)',
    min: 1,
    max: 10,
  },
  'checkin.traffic_pause_minutes': {
    value: 10,
    description: '"Stuck in traffic" pauses check-ins for this long (minutes)',
    min: 5,
    max: 60,
  },
  'journey.lost_contact_minutes': {
    value: 5,
    description: 'Phone silent for this long: "Lost contact" alert to guardians (minutes)',
    min: 2,
    max: 30,
  },
  'guardian.link_live_after_end_minutes': {
    value: 15,
    description: 'Guardian live link stays open after the SOS ends (minutes)',
    min: 0,
    max: 60,
  },
  'guardian.max_count': {
    value: 5,
    description: 'Maximum guardians per user',
    min: 1,
    max: 5,
  },
  'audio.auto_delete_days': {
    value: 30,
    description: 'SOS audio is deleted after this many days unless the user keeps it',
    min: 1,
    max: 365,
  },
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
