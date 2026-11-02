/**
 * The user app API (`/v1/...`) and the guardian invite API (`/g/i/...`).
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

/** A guardian's name as typed or picked from contacts: trimmed, 1–60 characters. */
export const PersonName = z.string().trim().min(1).max(60);

/**
 * The user's own name: 2–50 characters; letters in any language (Hindi too), spaces and . ' ’ -.
 * Must start with a letter.
 */
export const ProfileName = z
  .string()
  .trim()
  .min(2, { error: 'Enter your name (at least 2 characters)' })
  .max(50, { error: 'Name can be at most 50 characters' })
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u, {
    error: "Use letters, spaces and . ' - only",
  });

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

/** POST /v1/auth/firebase (no login needed) */
export const LoginRequest = z.object({
  /** From Firebase phone sign-in on the phone. */
  firebaseIdToken: z.string().min(10).max(8192),
});

/**
 * POST /v1/auth/dev-login — development only (never in production): one test number and code set in
 * the server's .env (DEV_LOGIN_*), so the app can be tried without Firebase SMS.
 */
export const DevLoginRequest = z.object({
  phone: z.string().trim().min(10).max(20),
  code: z.string().trim().regex(/^\d{6}$/, { error: 'Enter the 6-digit code' }),
});

/** GET /v1/me, also returned by login, PATCH /v1/me, consent and photo calls. */
export const Me = z.object({
  id: Id,
  name: z.string().nullable(),
  /** The user's own number, E.164 (e.g. "+919812344521"). */
  phone: z.string(),
  bloodGroup: BloodGroup.nullable(),
  /** Short-lived link (1 hour) to show the profile photo, or null. */
  photoUrl: z.string().nullable(),
  consentGiven: z.boolean(),
  /** Guardians who have not declined. */
  guardiansCount: z.number().int(),
  acceptedGuardiansCount: z.number().int(),
  /** Safety rules the app needs (Settings), e.g. "sos.countdown_seconds": 5. */
  rules: z.record(z.string(), z.number()),
});

export const LoginReply = z.object({
  /** Send as `Authorization: Bearer <token>` on every other call. Keep it in secure storage. */
  token: z.string(),
  user: Me,
  isNewUser: z.boolean(),
});

/** POST /v1/me/consent */
export const ConsentRequest = z.object({
  /** Version of the terms and privacy text the user accepted, e.g. "2026-10". */
  version: z.string().trim().min(1).max(20),
});

// ---------------------------------------------------------------------------------------------
// A2 — Profile and phone details
// ---------------------------------------------------------------------------------------------

/** PATCH /v1/me — send only what changes; `bloodGroup: null` clears it. */
export const UpdateProfileRequest = z
  .object({
    name: ProfileName.optional(),
    bloodGroup: BloodGroup.nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.bloodGroup !== undefined, {
    error: 'Send at least one field',
  });

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** POST /v1/me/photo-upload */
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

/** POST /v1/me/photo — after uploading with the link */
export const SavePhotoRequest = z.object({ key: z.string().min(1).max(200) });

/** Permission keys the admin panel's "Setup complete" check reads. Keep in step with the app. */
export const Permissions = z.object({
  location: z.boolean(),
  notifications: z.boolean(),
  sms: z.boolean(),
  microphone: z.boolean(),
});

/** PUT /v1/me/device */
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
  /**
   * Full number (E.164), for the owner's phone only: the app keeps it so an SOS can be sent by
   * SMS from the phone's own SIM without internet. Null once declined.
   */
  phone: z.string().nullable(),
  status: GuardianStatus,
});

/** PATCH /v1/guardians/:id — send only what changes; `relation: null` clears it. */
export const UpdateGuardianRequest = z
  .object({
    name: PersonName.optional(),
    relation: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.relation !== undefined, {
    error: 'Send at least one field',
  });

/** POST /v1/guardians */
export const AddGuardianRequest = z.object({
  name: PersonName,
  /** Indian mobile in any common form: "98123 44521", "+91 98123 44521", "098123 44521". */
  phone: z.string().trim().min(10).max(20),
  /** e.g. "brother", optional. */
  relation: z.string().trim().min(1).max(40).optional(),
});

/** GET /g/i/:code (guardian, no login) */
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

/** POST /v1/sos — a real SOS. Sending the same `id` again returns the same SOS. */
export const StartSosRequest = z.object({
  id: Id,
  trigger: SosTrigger,
  /** Phone time when the countdown finished. */
  startedAt: DateTime,
  journeyId: Id.optional(),
  location: Place.optional(),
  /**
   * Guardians the phone already reached by SMS from its own SIM (no internet at the time).
   * They get only the live link, never a second SOS SMS.
   */
  simSmsSentTo: z.array(Id).max(5).optional(),
});

/** POST /v1/sos/test — a practice alert to accepted guardians only (5 a day). */
export const TestSosRequest = z.object({
  id: Id,
  startedAt: DateTime,
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

/** POST /v1/sos/:id/end */
export const EndSosRequest = z.object({ reason: z.literal('safe') });

/** POST /v1/sos/cancelled — an SOS cancelled during the countdown (report only, no alerts). */
export const CancelledSosRequest = z.object({
  id: Id,
  trigger: SosTrigger,
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

/** POST /v1/locations */
export const LocationsRequest = z.object({ points: z.array(LocationPoint).min(1).max(50) });

export const LocationsReply = z.object({
  saved: z.number().int(),
  /** Already saved before (sent again). */
  duplicates: z.number().int(),
});

/** POST /v1/heartbeat — every 30–60 seconds while an SOS or journey is active. */
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

/**
 * POST /v1/journeys — sending the same `id` again returns the same journey. Shared with all
 * accepted guardians (at least one needed). Arrival between 5 minutes and 12 hours from now.
 */
export const StartJourneyRequest = z.object({
  id: Id,
  destination: z.object({
    lat: Latitude,
    lng: Longitude,
    /** The place picked from the search, e.g. "Home" or "Sector 18 Metro Station". */
    label: z.string().trim().min(1).max(200),
  }),
  expectedArrivalAt: DateTime,
  /** Route from Google Directions as an encoded polyline; optional (no route = no off-route check). */
  route: z.string().min(1).max(20_000).optional(),
});

/** POST /v1/journeys/:id/end */
export const EndJourneyRequest = z.object({
  /** `arrived` = "I reached safely"; `ended` = ended without arriving. */
  outcome: z.enum(['arrived', 'ended']),
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
  /** Encoded polyline, if one was sent. */
  route: z.string().nullable(),
});

/**
 * POST /v1/journeys/:id/checkins — the phone found a reason to ask "Are you okay?" (stopped 3 min,
 * 500 m off route for 2 points in a row, or 15 min late) and shows the alert.
 */
export const RaiseCheckinRequest = z.object({
  id: Id,
  reason: CheckinReason,
});

/**
 * POST /v1/checkins/:id/answer — `traffic_pause` = "Stuck in traffic" (no check-ins for 10 min);
 * `sos` = "I need help" (the app then starts an SOS with trigger "checkin").
 */
export const AnswerCheckinRequest = z.object({
  answer: z.enum(['fine', 'traffic_pause', 'sos']),
});

// ---------------------------------------------------------------------------------------------
// A7 — History, delete account, support
// ---------------------------------------------------------------------------------------------

export const HistoryItem = z.object({
  type: z.enum(['sos', 'journey']),
  id: Id,
  /**
   * SOS: `active`, `ended` or `cancelled` (stopped in the countdown).
   * Journey: `active`, `arrived`, `ended` or `lost_contact`.
   */
  status: z.string(),
  /** A test SOS (journeys: always false). */
  isTest: z.boolean(),
  /** SOS only: `button`, `widget`, `tile`, `checkin` or `journey`; null for journeys. */
  trigger: z.string().nullable(),
  /** Journey only: where to, e.g. "Home"; null for SOS. */
  destinationLabel: z.string().nullable(),
  startedAt: DateTime,
  endedAt: DateTime.nullable(),
});

/** GET /v1/history?type=sos|journey&cursor=<nextCursor> — 20 per page, newest first. */
export const HistoryQuery = z.object({
  type: z.enum(['sos', 'journey']).optional(),
  cursor: z.string().max(200).optional(),
});

export const HistoryPage = z.object({
  items: z.array(HistoryItem),
  /** Pass as `cursor` to get the next page; null when there are no more. */
  nextCursor: z.string().nullable(),
});

export const TimelineEntry = z.object({
  at: DateTime,
  /**
   * `sos_started`, `sos_cancelled`, `guardian_alerted`, `link_opened`, `guardian_responding`,
   * `sos_ended`, `journey_started`, `checkin`, `checkin_answered`, `journey_ended`.
   */
  kind: z.string(),
  /** Plain text for the row, e.g. "Ravi opened the live link". */
  text: z.string(),
});

/** An audio clip of an SOS (listed in the SOS timeline; see audio, A8). */
export const AudioClip = z.object({
  id: Id,
  recordedAt: DateTime,
  durationS: z.number().nullable(),
  keep: z.boolean(),
  /** Deleted automatically after this, unless `keep` is true. */
  deleteAfter: DateTime,
});

/** GET /v1/history/sos/:id and GET /v1/history/journeys/:id */
export const HistoryDetail = z.object({
  item: HistoryItem,
  timeline: z.array(TimelineEntry),
  /** SOS only (empty for journeys). */
  clips: z.array(AudioClip),
});

/** Saved places: one `home`, one `work`, and up to 8 `other`. */
export const PlaceLabel = z.enum(['home', 'work', 'other']);

/** POST /v1/places — saving `home` or `work` again replaces the old one. */
export const SavePlaceRequest = z.object({
  label: PlaceLabel,
  name: z.string().trim().min(1).max(60),
  address: z.string().trim().max(200).optional(),
  lat: Latitude,
  lng: Longitude,
});

export const SavedPlace = z.object({
  id: Id,
  label: PlaceLabel,
  name: z.string(),
  address: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
});

/** POST /v1/support-tickets — "Report a problem". */
export const SupportRequest = z.object({
  category: z.enum(['otp', 'guardian_sms', 'app_stopped', 'other']),
  message: z.string().trim().min(10).max(2000),
  /** The app's version, e.g. "1.0.3 (12)". If left out, the last one sent in PUT /v1/me/device is used. */
  appVersion: z.string().trim().min(1).max(40).optional(),
  /** e.g. "Redmi Note 12". If left out, the last one sent in PUT /v1/me/device is used. */
  deviceModel: z.string().trim().min(1).max(80).optional(),
});

/**
 * DELETE /v1/me — the app first runs a new phone OTP (the Firebase token must be at most 5 minutes
 * old) and has the user type DELETE.
 */
export const DeleteAccountRequest = z.object({
  firebaseIdToken: z.string().min(1),
  confirm: z.literal('DELETE', { error: 'Type DELETE to confirm' }),
});

// ---------------------------------------------------------------------------------------------
// A8 — Audio (clips are encrypted on the phone; the key never leaves it)
// ---------------------------------------------------------------------------------------------

/** Largest audio clip accepted (a 30-second AAC clip is about 250 KB). */
export const MAX_CLIP_BYTES = 2 * 1024 * 1024;

/** POST /v1/sos/:id/audio-upload — upload link for one encrypted clip. */
export const ClipUploadRequest = z.object({
  /** Made on the phone; the same id always gets the same storage key. */
  clipId: Id,
  sizeBytes: z.number().int().min(1).max(MAX_CLIP_BYTES),
});

/** POST /v1/sos/:id/audio — after the upload: record the clip. Safe to repeat. */
export const SaveClipRequest = z.object({
  clipId: Id,
  recordedAt: DateTime,
  durationS: z.number().int().min(0).max(120),
});

/** PATCH /v1/audio/:id — keep stops the automatic delete. */
export const KeepClipRequest = z.object({ keep: z.boolean() });

/** GET /v1/audio/:id/play — download the encrypted clip; the phone decrypts it with its own key. */
export const ClipLink = z.object({
  url: z.string(),
  expiresAt: DateTime,
});

// ---------------------------------------------------------------------------------------------
// Guardian live page (C2) — /g/l/:code, no login
// ---------------------------------------------------------------------------------------------

/** One location as the live page shows it (no names or numbers). */
export const LivePoint = z.object({
  sosId: z.string().nullable(),
  journeyId: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
  accuracyM: z.number().nullable(),
  batteryPct: z.number().nullable(),
  network: z.string().nullable(),
  recordedAt: DateTime,
});

export const LiveGuardian = z.object({
  firstName: z.string(),
  /** `alerted` = SMS sent, `opened` = opened the link, `responding` = tapped "I'm responding". */
  status: z.enum(['alerted', 'opened', 'responding']),
  /** This is the guardian who opened the page. */
  isYou: z.boolean(),
});

/** GET /g/l/:code — what the guardian's live page shows. 410 `link_expired` after the end. */
export const LiveView = z.object({
  kind: z.enum(['sos', 'journey']),
  /** `active` while the SOS / journey is on; `ended` for the few minutes the link stays open after. */
  status: z.enum(['active', 'ended']),
  /** After the end: `safe` (SOS), `arrived` or `ended` (journey); otherwise null. */
  outcome: z.enum(['safe', 'arrived', 'ended']).nullable(),
  person: z.object({
    firstName: z.string(),
    /** For "Call Priya" (SOS only; null on a journey). */
    phone: z.string().nullable(),
    /** SOS only; null on a journey or if not given. */
    bloodGroup: BloodGroup.nullable(),
  }),
  location: LivePoint.nullable(),
  /** Battery from the newest point or heartbeat. */
  batteryPct: z.number().nullable(),
  /** The phone has been silent too long (guardians were told). */
  lostContact: z.boolean(),
  startedAt: DateTime,
  endedAt: DateTime.nullable(),
  journey: z
    .object({
      destinationLabel: z.string(),
      destination: z.object({ lat: z.number(), lng: z.number() }),
      expectedArrivalAt: DateTime,
      /** Google encoded polyline, if the app sent one. */
      route: z.string().nullable(),
    })
    .nullable(),
  guardians: z.array(LiveGuardian),
  youAreResponding: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type ErrorReply = z.infer<typeof ErrorReply>;
export type LoginRequest = z.infer<typeof LoginRequest>;
export type DevLoginRequest = z.infer<typeof DevLoginRequest>;
export type LoginReply = z.infer<typeof LoginReply>;
export type Me = z.infer<typeof Me>;
export type ConsentRequest = z.infer<typeof ConsentRequest>;
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;
export type PhotoUploadRequest = z.infer<typeof PhotoUploadRequest>;
export type UploadLink = z.infer<typeof UploadLink>;
export type SavePhotoRequest = z.infer<typeof SavePhotoRequest>;
export type Permissions = z.infer<typeof Permissions>;
export type DeviceRequest = z.infer<typeof DeviceRequest>;
export type Guardian = z.infer<typeof Guardian>;
export type AddGuardianRequest = z.infer<typeof AddGuardianRequest>;
export type UpdateGuardianRequest = z.infer<typeof UpdateGuardianRequest>;
export type InviteInfo = z.infer<typeof InviteInfo>;
export type StartSosRequest = z.infer<typeof StartSosRequest>;
export type TestSosRequest = z.infer<typeof TestSosRequest>;
export type SosGuardian = z.infer<typeof SosGuardian>;
export type Sos = z.infer<typeof Sos>;
export type EndSosRequest = z.infer<typeof EndSosRequest>;
export type CancelledSosRequest = z.infer<typeof CancelledSosRequest>;
export type LocationPoint = z.infer<typeof LocationPoint>;
export type LocationsRequest = z.infer<typeof LocationsRequest>;
export type LocationsReply = z.infer<typeof LocationsReply>;
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;
export type StartJourneyRequest = z.infer<typeof StartJourneyRequest>;
export type EndJourneyRequest = z.infer<typeof EndJourneyRequest>;
export type Checkin = z.infer<typeof Checkin>;
export type Journey = z.infer<typeof Journey>;
export type RaiseCheckinRequest = z.infer<typeof RaiseCheckinRequest>;
export type AnswerCheckinRequest = z.infer<typeof AnswerCheckinRequest>;
export type HistoryItem = z.infer<typeof HistoryItem>;
export type HistoryQuery = z.infer<typeof HistoryQuery>;
export type HistoryPage = z.infer<typeof HistoryPage>;
export type TimelineEntry = z.infer<typeof TimelineEntry>;
export type AudioClip = z.infer<typeof AudioClip>;
export type HistoryDetail = z.infer<typeof HistoryDetail>;
export type PlaceLabel = z.infer<typeof PlaceLabel>;
export type SavePlaceRequest = z.infer<typeof SavePlaceRequest>;
export type SavedPlace = z.infer<typeof SavedPlace>;
export type SupportRequest = z.infer<typeof SupportRequest>;
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;
export type ClipUploadRequest = z.infer<typeof ClipUploadRequest>;
export type SaveClipRequest = z.infer<typeof SaveClipRequest>;
export type KeepClipRequest = z.infer<typeof KeepClipRequest>;
export type ClipLink = z.infer<typeof ClipLink>;
export type LivePoint = z.infer<typeof LivePoint>;
export type LiveGuardian = z.infer<typeof LiveGuardian>;
export type LiveView = z.infer<typeof LiveView>;
