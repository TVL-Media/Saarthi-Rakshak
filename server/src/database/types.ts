import type { ColumnType, Generated } from 'kysely';

// TypeScript view of the tables created by the migrations. Keep in step with migrations/.

/** Set by the database on insert; can be changed later. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
/** PostGIS geography(Point, 4326). Write with sql`ST_MakePoint(lng, lat)::geography`. */
type Geography = string;

export interface UsersTable {
  id: Generated<string>;
  phone: string;
  name: string | null;
  photo_key: string | null;
  blood_group: 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-' | null;
  gender: 'female' | 'male' | 'other' | null;
  /** A date only. Written as "YYYY-MM-DD"; read it with to_char (pg turns a date into a local Date). */
  date_of_birth: string | null;
  email: string | null;
  home_address: string | null;
  medical_notes: string | null;
  status: Generated<'active' | 'blocked'>;
  consent_at: Date | null;
  consent_version: string | null;
  last_seen_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface DevicesTable {
  id: Generated<string>;
  user_id: string;
  model: string | null;
  android_version: string | null;
  app_version: string | null;
  push_token: string | null;
  permissions: Generated<Record<string, unknown>>;
  battery_optimisation_off: boolean | null;
  last_seen_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface GuardiansTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  /** Always NULL once the invite is declined (enforced by the database). */
  phone: string | null;
  /** How they are related, if the user says (e.g. "brother"). */
  relation: string | null;
  invite_status: Generated<'pending' | 'accepted' | 'declined'>;
  invited_at: Timestamp;
  responded_at: Date | null;
  /** SHA-256 of the invite link code; the code itself is never stored. */
  invite_token_hash: string | null;
  invite_expires_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface GuardianInviteBlocklistTable {
  user_id: string;
  /** HMAC-SHA256 of the declined number with PHONE_HASH_KEY. */
  phone_hash: string;
  created_at: CreatedAt;
}

export interface AdminsTable {
  id: Generated<string>;
  email: string;
  name: string;
  role: 'super_admin' | 'support_admin';
  password_hash: string;
  totp_secret_encrypted: string | null;
  status: Generated<'active' | 'disabled'>;
  must_change_password: Generated<boolean>;
  password_expires_at: Date | null;
  failed_login_count: Generated<number>;
  locked_until: Date | null;
  totp_enabled_at: Date | null;
  /** bigint, returned as a string by pg. */
  totp_last_step: string | number | null;
  password_changed_at: Date | null;
  last_login_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface SettingsTable {
  key: string;
  value: unknown;
  updated_by: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface JourneysTable {
  id: Generated<string>;
  user_id: string;
  destination: Geography | null;
  destination_label: string | null;
  expected_arrival_at: Date | null;
  status: Generated<'active' | 'arrived' | 'ended' | 'lost_contact'>;
  started_at: Timestamp;
  ended_at: Date | null;
  /** Safety rules (Settings) when the journey started. */
  rules: Record<string, number> | null;
  /** Encoded polyline from Google Directions, if sent. */
  route_polyline: string | null;
  checkins_paused_until: Date | null;
  /** Guardians were told the phone went silent; cleared when it is back. */
  lost_contact_at: Date | null;
  mode: 'walk' | 'cab' | 'auto' | 'bus' | 'own_vehicle' | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface SosEventsTable {
  /** Made on the phone. */
  id: string;
  /** NULL after the user deleted their account. */
  user_id: string | null;
  journey_id: string | null;
  trigger: SosTriggerValue;
  is_test: Generated<boolean>;
  status: Generated<'active' | 'ended' | 'cancelled'>;
  started_at: Date | string;
  ended_at: Date | null;
  end_reason: string | null;
  guardian_link_expires_at: Date | null;
  /** Safety rules (Settings) when the SOS started; see AppSettings.snapshot(). */
  rules: Record<string, number> | null;
  /** The "no guardian responded" reminder was sent at this time. */
  no_response_alerted_at: Date | null;
  /** Guardians were told the phone went silent; cleared when it is back. */
  lost_contact_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface LocationPointsTable {
  /** bigint, returned as a string by pg. */
  id: Generated<string>;
  user_id: string;
  sos_event_id: string | null;
  journey_id: string | null;
  location: Geography;
  accuracy_m: number | null;
  battery_pct: number | null;
  network: string | null;
  recorded_at: Date | string;
  /** Made on the phone; unique per user, so a point sent twice is saved once. */
  client_point_id: string | null;
  /** Set by the database from sos_event_id / journey_id when not given. */
  kind: ColumnType<'sos' | 'journey' | 'daily', 'sos' | 'journey' | 'daily' | undefined, never>;
  delete_after: Date | null;
  created_at: CreatedAt;
}

export interface CheckinsTable {
  id: Generated<string>;
  journey_id: string;
  reason: 'off_route' | 'stopped' | 'late';
  status: Generated<'pending' | 'fine' | 'traffic_pause' | 'sos' | 'no_reply'>;
  source: Generated<'phone' | 'server'>;
  asked_at: Timestamp;
  answered_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface AlertsTable {
  id: Generated<string>;
  sos_event_id: string | null;
  journey_id: string | null;
  guardian_id: string | null;
  channel: 'push' | 'sms' | 'sim_sms';
  provider: 'main' | 'backup' | null;
  type:
    | 'sos'
    | 'sos_link'
    | 'resend'
    | 'lost_contact'
    | 'back_online'
    | 'checkin_no_reply'
    | 'safe'
    | 'cancelled'
    | 'invite'
    | 'test'
    | 'journey_started'
    | 'journey_arrived'
    | 'journey_ended';
  status: Generated<'queued' | 'sent' | 'delivered' | 'failed'>;
  attempt: Generated<number>;
  error: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  /** The SMS provider's id for the message (delivery reports). */
  provider_message_id: string | null;
  /** SMS text while waiting to be sent; NULL once sent or finally failed. */
  body: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface GuardianLinksTable {
  id: Generated<string>;
  guardian_id: string;
  sos_event_id: string | null;
  journey_id: string | null;
  token_hash: string;
  opened_at: Date | null;
  responding_at: Date | null;
  expires_at: Date | string;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface MediaClipsTable {
  id: Generated<string>;
  user_id: string;
  sos_event_id: string;
  storage_key: string;
  duration_s: number | null;
  /** bigint, returned as a string by pg. */
  size_bytes: string | number | null;
  keep: Generated<boolean>;
  delete_after: Date | string;
  /** When the phone recorded it; NULL for clips saved before migration 0016. */
  recorded_at: Date | null;
  deleted_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface AuditLogTable {
  /** bigint, returned as a string by pg. */
  id: Generated<string>;
  /** NULL means the system itself. */
  admin_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  session_id: string | null;
  status_code: number | null;
  /** jsonb: before/after values of a change (names and values only, never personal details). */
  details: ColumnType<unknown, string | null | undefined, never>;
  created_at: CreatedAt;
}

export type SessionStage = 'change_password' | 'setup_2fa' | 'verify_2fa' | 'full';

export interface AdminSessionsTable {
  id: Generated<string>;
  admin_id: string;
  token_hash: string;
  stage: SessionStage;
  ip: string | null;
  user_agent: string | null;
  created_at: CreatedAt;
  last_seen_at: Timestamp;
  expires_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
}

export interface UserSessionsTable {
  id: Generated<string>;
  user_id: string;
  device_id: string | null;
  token_hash: string;
  created_at: CreatedAt;
  last_seen_at: Timestamp;
  expires_at: Date;
  ended_at: Date | null;
  end_reason: 'logout' | 'new_login' | 'account_deleted' | null;
}

export interface AdminBackupCodesTable {
  id: Generated<string>;
  admin_id: string;
  code_hash: string;
  used_at: Date | null;
  created_at: CreatedAt;
}

export interface SupportTicketsTable {
  id: Generated<string>;
  user_id: string;
  category: string;
  message: string;
  status: Generated<'open' | 'in_progress' | 'closed'>;
  assigned_admin_id: string | null;
  closed_at: Date | null;
  app_version: string | null;
  device_model: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface SavedPlacesTable {
  id: Generated<string>;
  user_id: string;
  label: 'home' | 'work' | 'other';
  name: string;
  address: string | null;
  location: Geography;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export type SosTriggerValue =
  | 'button'
  | 'widget'
  | 'tile'
  | 'checkin'
  | 'journey'
  | 'shake'
  | 'voice'
  | 'crash'
  | 'fall'
  | 'discreet';

export interface SosFalseAlarmsTable {
  id: string;
  user_id: string | null;
  trigger: string;
  created_at: CreatedAt;
}

export interface SosTriggerSettingsTable {
  user_id: string;
  shake_mode: Generated<'off' | 'journey' | 'always'>;
  voice_on: Generated<boolean>;
  drive_mode: Generated<boolean>;
  fall_on: Generated<boolean>;
  quiet_countdown: Generated<boolean>;
  journey_sos_button: Generated<boolean>;
  updated_at: Timestamp;
}

export interface SosPhotosTable {
  id: string;
  user_id: string;
  sos_event_id: string;
  camera: 'front' | 'back';
  storage_key: string;
  size_bytes: number;
  taken_at: Date | string;
  keep: Generated<boolean>;
  delete_after: Date | string;
  created_at: CreatedAt;
}

export interface DailyTrackingSettingsTable {
  user_id: string;
  enabled: Generated<boolean>;
  paused_until: Date | null;
  retention_days: Generated<number>;
  consent_version: string | null;
  consent_at: Date | null;
  updated_at: Timestamp;
}

export interface VaultKeysTable {
  user_id: string;
  locked_key: string;
  kdf: ColumnType<unknown, string, string>;
  check_value: string;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface EvidenceIncidentsTable {
  id: string;
  user_id: string;
  kind: 'blackmail' | 'harassment' | 'physical' | 'sos' | 'other';
  locked_details: string;
  sos_event_id: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
  deleted_at: Date | null;
}

export interface EvidenceItemsTable {
  id: string;
  user_id: string;
  incident_id: string | null;
  kind: 'audio' | 'video' | 'photo' | 'file' | 'detail' | 'report';
  storage_key: string | null;
  /** bigint, returned as a string by pg. */
  size_bytes: ColumnType<string, number, number>;
  locked_file_key: string;
  locked_details: string;
  sha256: string;
  captured_at: Date | string;
  received_at: CreatedAt;
  delete_locked_until: Date | string;
  hidden: Generated<boolean>;
  uploaded: Generated<boolean>;
  /** Set when the vault was reset while this item was still protected: it can never be opened again, is hidden, and is deleted once the protection ends. */
  orphaned_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface EvidenceAccessLogTable {
  id: Generated<string>;
  user_id: string;
  item_id: string | null;
  incident_id: string | null;
  action: string;
  device: string | null;
  at: CreatedAt;
}

export interface CommunityPostsTable {
  id: string;
  author_user_id: string | null;
  author_admin_id: string | null;
  category: 'lighting' | 'unsafe_spot' | 'harassment_area' | 'road' | 'other';
  area: string;
  body: string;
  photo_key: string | null;
  status: Generated<'pending' | 'published' | 'rejected' | 'removed'>;
  reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  flags_count: Generated<number>;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface CommunityFlagsTable {
  post_id: string;
  user_id: string;
  reason: string;
  created_at: CreatedAt;
}

export interface RakshakApplicationsTable {
  id: Generated<string>;
  user_id: string | null;
  locked_details: string;
  /** The main area (always areas[1]). */
  area: string;
  /** Every area where the Rakshak helps, 1 to 5 (migration 0022); filled from `area` if left out. */
  areas: Generated<string[]>;
  id_type: 'aadhaar' | 'pan' | 'driving_licence' | 'voter_id' | 'passport';
  id_last4: string;
  documents: ColumnType<unknown, string | undefined, string>;
  consent_at: Date;
  status: Generated<'under_review' | 'approved' | 'rejected' | 'withdrawn'>;
  reason: string | null;
  reviewed_by: string | null;
  decided_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface PlansTable {
  id: 'basic' | 'silver' | 'gold';
  name: string;
  monthly_price_inr: number | null;
  yearly_price_inr: number | null;
  monthly_product_id: string | null;
  yearly_product_id: string | null;
  features: ColumnType<unknown, string, string>;
  evidence_storage_mb: number;
  location_history_days: number;
  on_sale: boolean;
  sort_order: number;
  updated_by: string | null;
  updated_at: Timestamp;
}

export interface SubscriptionsTable {
  id: Generated<string>;
  user_id: string | null;
  plan_id: string;
  product_id: string;
  purchase_token_hash: string;
  status: 'active' | 'pending' | 'cancelled' | 'expired' | 'refunded';
  renews_at: Date | null;
  cancelled_at: Date | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export type BookingStatus =
  | 'requested'
  | 'quoted'
  | 'confirmed'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export interface BookingServicesTable {
  id: string;
  name: string;
  description: string;
  position: number;
  active: Generated<boolean>;
}

export interface BookingsTable {
  /** Made on the phone, so repeating the request returns the same booking. */
  id: string;
  user_id: string;
  service_type: string;
  window_start: Date | string;
  window_end: Date | string;
  place: Geography;
  place_label: string | null;
  notes: string | null;
  status: Generated<BookingStatus>;
  quote_amount_paise: number | null;
  quote_note: string | null;
  quote_expires_at: Date | null;
  rakshak_user_id: string | null;
  cancel_reason: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface BookingEventsTable {
  id: Generated<string>;
  booking_id: string;
  status: string;
  actor: 'user' | 'rakshak' | 'admin' | 'system';
  admin_id: string | null;
  note: string | null;
  created_at: CreatedAt;
}

export interface RakshakPresenceTable {
  user_id: string;
  location: Geography;
  accuracy_m: number | null;
  online: Generated<boolean>;
  updated_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  devices: DevicesTable;
  guardians: GuardiansTable;
  guardian_invite_blocklist: GuardianInviteBlocklistTable;
  admins: AdminsTable;
  admin_sessions: AdminSessionsTable;
  admin_backup_codes: AdminBackupCodesTable;
  user_sessions: UserSessionsTable;
  saved_places: SavedPlacesTable;
  settings: SettingsTable;
  journeys: JourneysTable;
  sos_events: SosEventsTable;
  location_points: LocationPointsTable;
  checkins: CheckinsTable;
  alerts: AlertsTable;
  guardian_links: GuardianLinksTable;
  media_clips: MediaClipsTable;
  audit_log: AuditLogTable;
  support_tickets: SupportTicketsTable;
  sos_false_alarms: SosFalseAlarmsTable;
  sos_trigger_settings: SosTriggerSettingsTable;
  sos_photos: SosPhotosTable;
  daily_tracking_settings: DailyTrackingSettingsTable;
  vault_keys: VaultKeysTable;
  evidence_incidents: EvidenceIncidentsTable;
  evidence_items: EvidenceItemsTable;
  evidence_access_log: EvidenceAccessLogTable;
  community_posts: CommunityPostsTable;
  community_flags: CommunityFlagsTable;
  rakshak_applications: RakshakApplicationsTable;
  plans: PlansTable;
  subscriptions: SubscriptionsTable;
  booking_services: BookingServicesTable;
  bookings: BookingsTable;
  booking_events: BookingEventsTable;
  rakshak_presence: RakshakPresenceTable;
}
