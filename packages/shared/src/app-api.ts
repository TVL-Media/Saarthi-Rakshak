/**
 * The user app API (`/app/...`) and the guardian invite API (`/g/invite/...`).
 *
 * One source of truth: the server checks every request body with these schemas, and the web apps
 * use the types. The Flutter app follows the same list, written out in docs/app-api.md.
 * Change a schema here and in docs/app-api.md together.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

/** Ids made on the phone (SOS, journey, check-in, location point, device). */
export const Id = z.uuid({ error: 'Must be a UUID' });

/** Date and time with a time zone, e.g. "2026-10-27T18:30:00+05:30" or "...Z". */
export const DateTime = z.iso.datetime({ offset: true, error: 'Must be an ISO date-time' });

export const BloodGroup = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);

/** A person's name as typed: trimmed, 1–60 characters. */
export const PersonName = z.string().trim().min(1).max(60);

export const Latitude = z.number().min(-90).max(90);
export const Longitude = z.number().min(-180).max(180);

export const Place = z.object({
  lat: Latitude,
  lng: Longitude,
  /** Accuracy radius in metres, if the phone knows it. */
  accuracyM: z.number().min(0).max(100_000).optional(),
});

export const Network = z.enum(['wifi', 'mobile', 'none', 'unknown']);
export const BatteryPct = z.number().int().min(0).max(100);

/** Every error from /app and /g routes has this shape. */
export const ErrorReply = z.object({
  /** Stable code the app can switch on, e.g. "account_blocked". */
  error: z.string(),
  /** Plain-language text that can be shown to the user. */
  message: z.string(),
});

/** Error codes the app should handle (others: show `message`). */
export const ERROR_CODES = [
  'invalid_input', // 400: a field is missing or wrong
  'not_logged_in', // 401: no token, or the session has ended
  'consent_required', // 403: the user has not accepted the terms yet
  'account_blocked', // 403: blocked by the support team (SOS still works if already logged in)
  'not_found', // 404
  'conflict', // 409: e.g. an SOS or journey is already active
  'limit_reached', // 409: e.g. maximum guardians, daily invite limit
  'too_many_requests', // 429
  'link_expired', // 410: guardian invite link no longer valid
  'service_unavailable', // 503: a needed service is not set up or not reachable
  'server_error', // 500: unexpected; try again
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------------------------
// A1 — Login
// ---------------------------------------------------------------------------------------------

/** POST /app/auth/login (no login needed) */
export const LoginRequest = z.object({
  /** From Firebase phone sign-in on the phone. */
  firebaseIdToken: z.string().min(10).max(8192),
});

export const Me = z.object({
  id: Id,
  name: z.string().nullable(),
  /** The user's own number, E.164 (e.g. "+919812344521"). */
  phone: z.string(),
  bloodGroup: BloodGroup.nullable(),
  consentGiven: z.boolean(),
  guardiansCount: z.number().int(),
});

export const LoginReply = z.object({
  /** Send as `Authorization: Bearer <token>` on every other call. Keep it in secure storage. */
  token: z.string(),
  user: Me,
  isNewUser: z.boolean(),
});

/** POST /app/me/consent */
export const ConsentRequest = z.object({
  /** Version of the terms and privacy text the user accepted, e.g. "2026-10". */
  version: z.string().trim().min(1).max(20),
});

// ---------------------------------------------------------------------------------------------
// A2 — Profile and phone details
// ---------------------------------------------------------------------------------------------

export const Profile = z.object({
  name: z.string().nullable(),
  bloodGroup: BloodGroup.nullable(),
  /** Short-lived link to show the photo, or null. */
  photoUrl: z.string().nullable(),
});

/** PATCH /app/profile — send only what changes; `bloodGroup: null` clears it. */
export const UpdateProfileRequest = z
  .object({
    name: PersonName.optional(),
    bloodGroup: BloodGroup.nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.bloodGroup !== undefined, {
    error: 'Send at least one field',
  });

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** POST /app/profile/photo-upload */
export const PhotoUploadRequest = z.object({
  /** Exact size of the JPEG the phone will upload. */
  sizeBytes: z.number().int().min(1).max(MAX_PHOTO_BYTES),
});

export const UploadLink = z.object({
  /** Storage key; send it back after uploading. */
  key: z.string(),
  /** HTTP PUT the file here with exactly the headers below. */
  uploadUrl: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresAt: DateTime,
});

/** POST /app/profile/photo */
export const SavePhotoRequest = z.object({ key: z.string().min(1).max(200) });

/** Permission keys the admin panel's "Setup complete" check reads. Keep in step with the app. */
export const Permissions = z.object({
  location: z.boolean(),
  notifications: z.boolean(),
  sms: z.boolean(),
  microphone: z.boolean(),
});

/** PUT /app/device */
export const DeviceRequest = z.object({
  /** Made by the app once per install. */
  deviceId: Id,
  model: z.string().trim().min(1).max(100),
  androidVersion: z.string().trim().min(1).max(20),
  appVersion: z.string().trim().min(1).max(20),
  /** Firebase Cloud Messaging token, or null if notifications are off. */
  pushToken: z.string().min(1).max(4096).nullable(),
  permissions: Permissions,
  batteryOptimisationOff: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// A3 — Guardians and invites
// ---------------------------------------------------------------------------------------------

export const GuardianStatus = z.enum(['pending', 'accepted', 'declined']);

export const Guardian = z.object({
  id: Id,
  name: z.string(),
  relation: z.string().nullable(),
  /** e.g. "+91 98•• ••4521"; null once declined (the number is deleted). */
  phoneMasked: z.string().nullable(),
  status: GuardianStatus,
});

/** POST /app/guardians */
export const AddGuardianRequest = z.object({
  name: PersonName,
  /** Indian mobile in any common form: "98123 44521", "+91 98123 44521", "098123 44521". */
  phone: z.string().trim().min(10).max(20),
  /** e.g. "brother", optional. */
  relation: z.string().trim().min(1).max(40).optional(),
});

/** GET /g/invite/:code (guardian, no login) */
export const InviteInfo = z.object({
  /** First name of the person who invited them. */
  inviterFirstName: z.string(),
  guardianName: z.string(),
  status: GuardianStatus,
  expiresAt: DateTime,
});

// ---------------------------------------------------------------------------------------------
// A4 — SOS
// ---------------------------------------------------------------------------------------------

export const SosTrigger = z.enum(['button', 'widget', 'tile', 'checkin', 'journey']);
export const SosStatus = z.enum(['active', 'ended', 'cancelled']);

/** POST /app/sos — sending the same `id` again returns the same SOS. */
export const StartSosRequest = z.object({
  id: Id,
  trigger: SosTrigger,
  isTest: z.boolean(),
  /** Phone time when the countdown finished. */
  startedAt: DateTime,
  journeyId: Id.optional(),
  location: Place.optional(),
});

export const SosGuardian = z.object({
  guardianId: Id,
  name: z.string(),
  relation: z.string().nullable(),
  alertedAt: DateTime.nullable(),
  openedAt: DateTime.nullable(),
  respondingAt: DateTime.nullable(),
});

export const Sos = z.object({
  id: Id,
  trigger: SosTrigger,
  isTest: z.boolean(),
  status: SosStatus,
  startedAt: DateTime,
  endedAt: DateTime.nullable(),
  guardians: z.array(SosGuardian),
});

/** POST /app/sos/:id/end */
export const EndSosRequest = z.object({ reason: z.literal('safe') });

/** POST /app/sos/cancelled — an SOS cancelled during the countdown (report only, no alerts). */
export const CancelledSosRequest = z.object({
  id: Id,
  trigger: SosTrigger,
  isTest: z.boolean(),
  startedAt: DateTime,
  cancelledAt: DateTime,
});

// ---------------------------------------------------------------------------------------------
// A5 — Live location and heartbeat
// ---------------------------------------------------------------------------------------------

export const LocationPoint = z
  .object({
    /** Made on the phone; a point sent twice is saved once. */
    clientPointId: Id,
    sosId: Id.optional(),
    journeyId: Id.optional(),
    lat: Latitude,
    lng: Longitude,
    accuracyM: z.number().min(0).max(100_000).optional(),
    batteryPct: BatteryPct.optional(),
    network: Network.optional(),
    recordedAt: DateTime,
  })
  .refine((p) => p.sosId !== undefined || p.journeyId !== undefined, {
    error: 'Each point needs sosId or journeyId',
  });

/** POST /app/locations */
export const LocationsRequest = z.object({ points: z.array(LocationPoint).min(1).max(50) });

export const LocationsReply = z.object({
  saved: z.number().int(),
  /** Already saved before (sent again). */
  duplicates: z.number().int(),
});

/** POST /app/heartbeat — every 30–60 seconds while an SOS or journey is active. */
export const HeartbeatRequest = z.object({
  batteryPct: BatteryPct.optional(),
  network: Network.optional(),
  sosId: Id.optional(),
  journeyId: Id.optional(),
});

// ---------------------------------------------------------------------------------------------
// A6 — Journeys and check-ins
// ---------------------------------------------------------------------------------------------

export const JourneyStatus = z.enum(['active', 'arrived', 'ended', 'lost_contact']);
export const CheckinReason = z.enum(['off_route', 'stopped', 'late']);
export const CheckinStatus = z.enum(['pending', 'fine', 'traffic_pause', 'sos', 'no_reply']);

/** POST /app/journeys — sending the same `id` again returns the same journey. */
export const StartJourneyRequest = z.object({
  id: Id,
  destination: z.object({
    lat: Latitude,
    lng: Longitude,
    label: z.string().trim().min(1).max(200),
  }),
  expectedArrivalAt: DateTime,
  /** Route as a Google encoded polyline, optional. */
  route: z.string().min(1).max(20_000).optional(),
});

export const Checkin = z.object({
  id: Id,
  reason: CheckinReason,
  source: z.enum(['phone', 'server']),
  status: CheckinStatus,
  askedAt: DateTime,
});

export const Journey = z.object({
  id: Id,
  status: JourneyStatus,
  destination: z.object({ lat: Latitude, lng: Longitude, label: z.string() }),
  expectedArrivalAt: DateTime,
  startedAt: DateTime,
  endedAt: DateTime.nullable(),
  openCheckin: Checkin.nullable(),
  /** "Stuck in traffic": no new check-ins until then. */
  checkinsPausedUntil: DateTime.nullable(),
});

/** POST /app/journeys/:id/checkins — the phone noticed a problem. */
export const RaiseCheckinRequest = z.object({
  id: Id,
  reason: z.enum(['off_route', 'stopped']),
});

/** POST /app/checkins/:id/answer */
export const AnswerCheckinRequest = z.object({
  answer: z.enum(['fine', 'traffic', 'sos']),
});

// ---------------------------------------------------------------------------------------------
// A7 — History, delete account, support
// ---------------------------------------------------------------------------------------------

export const HistoryItem = z.object({
  type: z.enum(['sos', 'journey']),
  id: Id,
  status: z.string(),
  isTest: z.boolean(),
  startedAt: DateTime,
  endedAt: DateTime.nullable(),
});

/** GET /app/history?before=<DateTime> — 20 per page, newest first. */
export const HistoryPage = z.object({
  items: z.array(HistoryItem),
  /** Pass as `before` to get the next page; null when there are no more. */
  nextBefore: DateTime.nullable(),
});

export const TimelineEntry = z.object({
  at: DateTime,
  /** e.g. "sos_started", "guardian_alerted", "guardian_responding", "checkin", "sos_ended". */
  kind: z.string(),
  text: z.string(),
});

/** GET /app/history/sos/:id and GET /app/history/journeys/:id */
export const HistoryDetail = z.object({
  item: HistoryItem,
  timeline: z.array(TimelineEntry),
});

/** POST /app/support */
export const SupportRequest = z.object({
  category: z.enum(['otp', 'guardian_sms', 'app_stopped', 'other']),
  message: z.string().trim().min(10).max(2000),
});

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type ErrorReply = z.infer<typeof ErrorReply>;
export type LoginRequest = z.infer<typeof LoginRequest>;
export type LoginReply = z.infer<typeof LoginReply>;
export type Me = z.infer<typeof Me>;
export type ConsentRequest = z.infer<typeof ConsentRequest>;
export type Profile = z.infer<typeof Profile>;
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;
export type PhotoUploadRequest = z.infer<typeof PhotoUploadRequest>;
export type UploadLink = z.infer<typeof UploadLink>;
export type SavePhotoRequest = z.infer<typeof SavePhotoRequest>;
export type Permissions = z.infer<typeof Permissions>;
export type DeviceRequest = z.infer<typeof DeviceRequest>;
export type Guardian = z.infer<typeof Guardian>;
export type AddGuardianRequest = z.infer<typeof AddGuardianRequest>;
export type InviteInfo = z.infer<typeof InviteInfo>;
export type StartSosRequest = z.infer<typeof StartSosRequest>;
export type SosGuardian = z.infer<typeof SosGuardian>;
export type Sos = z.infer<typeof Sos>;
export type EndSosRequest = z.infer<typeof EndSosRequest>;
export type CancelledSosRequest = z.infer<typeof CancelledSosRequest>;
export type LocationPoint = z.infer<typeof LocationPoint>;
export type LocationsRequest = z.infer<typeof LocationsRequest>;
export type LocationsReply = z.infer<typeof LocationsReply>;
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;
export type StartJourneyRequest = z.infer<typeof StartJourneyRequest>;
export type Checkin = z.infer<typeof Checkin>;
export type Journey = z.infer<typeof Journey>;
export type RaiseCheckinRequest = z.infer<typeof RaiseCheckinRequest>;
export type AnswerCheckinRequest = z.infer<typeof AnswerCheckinRequest>;
export type HistoryItem = z.infer<typeof HistoryItem>;
export type HistoryPage = z.infer<typeof HistoryPage>;
export type TimelineEntry = z.infer<typeof TimelineEntry>;
export type HistoryDetail = z.infer<typeof HistoryDetail>;
export type SupportRequest = z.infer<typeof SupportRequest>;
