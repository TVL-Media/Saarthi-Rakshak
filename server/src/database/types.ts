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
  created_at: CreatedAt;
  updated_at: Timestamp;
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
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface SosEventsTable {
  /** Made on the phone. */
  id: string;
  /** NULL after the user deleted their account. */
  user_id: string | null;
  journey_id: string | null;
  trigger: 'button' | 'widget' | 'tile' | 'checkin' | 'journey';
  is_test: Generated<boolean>;
  status: Generated<'active' | 'ended' | 'cancelled'>;
  started_at: Date | string;
  ended_at: Date | null;
  end_reason: string | null;
  guardian_link_expires_at: Date | null;
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
  delete_after: Date | null;
  created_at: CreatedAt;
}

export interface CheckinsTable {
  id: Generated<string>;
  journey_id: string;
  reason: 'off_route' | 'stopped' | 'late';
  status: Generated<'pending' | 'fine' | 'traffic_pause' | 'sos' | 'no_reply'>;
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
  type: 'sos' | 'resend' | 'lost_contact' | 'checkin_no_reply' | 'safe' | 'cancelled';
  status: Generated<'queued' | 'sent' | 'delivered' | 'failed'>;
  attempt: Generated<number>;
  error: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
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
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  devices: DevicesTable;
  guardians: GuardiansTable;
  admins: AdminsTable;
  admin_sessions: AdminSessionsTable;
  admin_backup_codes: AdminBackupCodesTable;
  user_sessions: UserSessionsTable;
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
}
