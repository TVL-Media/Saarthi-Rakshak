import { z } from 'zod';
import { DateTime, Id, Latitude, Longitude } from './app-api';

// =============================================================================================
// Phase 2 — the user app API (see docs/app-api.md, "Phase 2").
// Evidence routes only ever move encrypted files and encrypted details: the server cannot read
// any evidence, and there are no admin routes for evidence or full-day location.
// =============================================================================================

/** A value encrypted on the phone (base64 of nonce + ciphertext + tag). The server never opens it. */
export const Locked = z
  .string()
  .min(16)
  .max(64_000)
  .regex(/^[A-Za-z0-9+/=_-]+$/, { error: 'Must be base64' });

// ---------------------------------------------------------------------------------------------
// SOS triggers (features 1, 2, 4, 5, 6)
// ---------------------------------------------------------------------------------------------

export const ShakeMode = z.enum(['off', 'journey', 'always']);

/** GET / PUT /v1/me/sos-triggers */
export const SosTriggerSettings = z.object({
  shakeMode: ShakeMode,
  /** Listens for the user's phrase during an active journey only (on the phone). */
  voiceOn: z.boolean(),
  /** Crash detection during a journey by vehicle (beta). */
  driveMode: z.boolean(),
  /** Fall detection (beta). */
  fallOn: z.boolean(),
  /** Discreet mode: countdown with vibration only, no sound, dim screen. Alerts go out normally. */
  quietCountdown: z.boolean(),
  /** An "SOS" button on the journey notification. */
  journeySosButton: z.boolean(),
});
export const UpdateSosTriggerSettings = SosTriggerSettings.partial();

/** POST /v1/sos/false-alarms — a detection countdown the user cancelled (counts only). */
export const FalseAlarmRequest = z.object({
  id: Id,
  trigger: z.enum(['shake', 'voice', 'crash', 'fall', 'discreet', 'button', 'widget', 'tile']),
});

// ---------------------------------------------------------------------------------------------
// Photo at SOS start (feature 3)
// ---------------------------------------------------------------------------------------------

export const MAX_SOS_PHOTO_BYTES = 1024 * 1024;

/** POST /v1/sos/:id/photo-upload */
export const SosPhotoUploadRequest = z.object({
  photoId: Id,
  sizeBytes: z.number().int().min(1).max(MAX_SOS_PHOTO_BYTES),
});

/** POST /v1/sos/:id/photos — after the upload. */
export const SaveSosPhotoRequest = z.object({
  photoId: Id,
  camera: z.enum(['front', 'back']),
  takenAt: DateTime,
});

export const SosPhoto = z.object({
  id: Id,
  camera: z.enum(['front', 'back']),
  takenAt: DateTime,
  keep: z.boolean(),
  deleteAfter: DateTime,
});

// ---------------------------------------------------------------------------------------------
// Full-day location, timeline and daily report (features 7–11)
// ---------------------------------------------------------------------------------------------

export const RetentionDays = z.union([z.literal(7), z.literal(30), z.literal(90)]);

/** GET /v1/me/daily-tracking */
export const DailyTracking = z.object({
  enabled: z.boolean(),
  pausedUntil: DateTime.nullable(),
  retentionDays: RetentionDays,
  consentVersion: z.string().nullable(),
});

/** PUT /v1/me/daily-tracking — turning it on needs the consent version the user accepted. */
export const UpdateDailyTracking = z
  .object({
    enabled: z.boolean().optional(),
    /** null = resume now. */
    pausedUntil: DateTime.nullable().optional(),
    retentionDays: RetentionDays.optional(),
    consentVersion: z.string().trim().min(1).max(20).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    error: 'Send at least one field',
  });

export const DailyPoint = z.object({
  /** Made on the phone; a point sent twice is saved once. */
  clientPointId: Id,
  lat: Latitude,
  lng: Longitude,
  accuracyM: z.number().min(0).max(100_000).optional(),
  batteryPct: z.number().int().min(0).max(100).optional(),
  recordedAt: DateTime,
  /** still / walking / vehicle (from Android activity recognition), if known. */
  activity: z.enum(['still', 'walking', 'vehicle', 'unknown']).optional(),
});

/** POST /v1/daily-locations — up to 500 points (the phone keeps up to 7 days when offline). */
export const DailyPointsRequest = z.object({
  points: z.array(DailyPoint).min(1).max(500),
});

/** A date in the user's day, "YYYY-MM-DD" (India time). */
export const DayParam = z.iso.date({ error: 'Must be a date (YYYY-MM-DD)' });

export const TimelineStop = z.object({
  lat: z.number(),
  lng: z.number(),
  arrivedAt: DateTime,
  leftAt: DateTime,
  minutes: z.number().int(),
});

export const TimelineRoute = z.object({
  from: DateTime,
  to: DateTime,
  distanceM: z.number().int(),
  /** Points along the route (thinned), for the map. */
  points: z.array(z.tuple([z.number(), z.number()])),
});

/** GET /v1/timeline?date= — stops (100 m for 5+ minutes) and the routes between them. */
export const Timeline = z.object({
  date: z.string(),
  stops: z.array(TimelineStop),
  routes: z.array(TimelineRoute),
  pointsCount: z.number().int(),
});

/** GET /v1/timeline/summary?date= */
export const TimelineSummary = z.object({
  date: z.string(),
  distanceM: z.number().int(),
  stopsCount: z.number().int(),
  movingMinutes: z.number().int(),
  firstPointAt: DateTime.nullable(),
  lastPointAt: DateTime.nullable(),
});

// ---------------------------------------------------------------------------------------------
// Evidence vault (features 12–21)
// ---------------------------------------------------------------------------------------------

/** How the vault key was locked with the recovery phrase (phone side; Argon2id). */
export const VaultKdf = z.object({
  name: z.literal('argon2id'),
  salt: z.string().min(16).max(200),
  memoryKiB: z
    .number()
    .int()
    .min(8 * 1024)
    .max(512 * 1024),
  iterations: z.number().int().min(1).max(20),
  parallelism: z.number().int().min(1).max(8),
});

/** POST /v1/vault/setup and the reply of GET /v1/vault/recovery. */
export const VaultKey = z.object({
  /** The vault key encrypted with a key made from the recovery phrase. */
  lockedKey: Locked,
  kdf: VaultKdf,
  /** A value the phone uses to tell whether a typed phrase is right (no secret in it). */
  checkValue: z.string().min(16).max(200),
});

export const EvidenceKind = z.enum(['audio', 'video', 'photo', 'file', 'detail', 'report']);
export const IncidentKind = z.enum(['blackmail', 'harassment', 'physical', 'sos', 'other']);

/** Up to 200 MB per file (videos up to 10 minutes). */
export const MAX_EVIDENCE_BYTES = 200 * 1024 * 1024;

/** POST /v1/vault/items/upload — a link for one encrypted file. */
export const EvidenceUploadRequest = z.object({
  itemId: Id,
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_EVIDENCE_BYTES + 1024),
});

/** POST /v1/vault/items — records an item (after its encrypted file was uploaded, if it has one). */
export const SaveEvidenceRequest = z.object({
  id: Id,
  kind: EvidenceKind,
  incidentId: Id.nullable().optional(),
  /** The file key locked with the vault key. */
  lockedFileKey: Locked,
  /** Place, note, original file name, detail value — encrypted on the phone. */
  lockedDetails: Locked,
  /** SHA-256 of the original (unencrypted) file or detail, made on the phone at capture. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, { error: 'Must be a SHA-256 hex' }),
  capturedAt: DateTime,
  /** Size of the encrypted file (0 for a detail). */
  sizeBytes: z
    .number()
    .int()
    .min(0)
    .max(MAX_EVIDENCE_BYTES + 1024),
  /** Copy of an SOS clip or photo: links the item to that SOS's automatic incident. */
  sosId: Id.optional(),
});

export const EvidenceItem = z.object({
  id: Id,
  kind: EvidenceKind,
  incidentId: Id.nullable(),
  lockedFileKey: z.string(),
  lockedDetails: z.string(),
  sha256: z.string(),
  capturedAt: DateTime,
  /** When our server first received it (cannot change afterwards). */
  receivedAt: DateTime,
  sizeBytes: z.number().int(),
  hasFile: z.boolean(),
  uploaded: z.boolean(),
  hidden: z.boolean(),
  /** It cannot be deleted before this time. */
  deleteLockedUntil: DateTime,
});

/** PATCH /v1/vault/items/:id */
export const UpdateEvidenceRequest = z
  .object({
    incidentId: Id.nullable().optional(),
    lockedDetails: Locked.optional(),
    hidden: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    error: 'Send at least one field',
  });

/** POST /v1/vault/incidents */
export const SaveIncidentRequest = z.object({
  id: Id,
  kind: IncidentKind,
  /** Title, date and description, encrypted on the phone. */
  lockedDetails: Locked,
});

/** PATCH /v1/vault/incidents/:id */
export const UpdateIncidentRequest = z
  .object({ kind: IncidentKind.optional(), lockedDetails: Locked.optional() })
  .refine((v) => v.kind !== undefined || v.lockedDetails !== undefined, {
    error: 'Send at least one field',
  });

export const Incident = z.object({
  id: Id,
  kind: IncidentKind,
  lockedDetails: z.string(),
  sosId: Id.nullable(),
  itemsCount: z.number().int(),
  createdAt: DateTime,
  updatedAt: DateTime,
});

export const AccessAction = z.enum([
  'created',
  'viewed',
  'exported',
  'shared',
  'edited',
  'hidden',
  'unhidden',
  'deleted',
  'report',
  /** The vault was reset after a forgotten password (no item). */
  'reset',
]);

/** POST /v1/vault/access-log — what the user did (no content). */
export const AccessLogRequest = z.object({
  entries: z
    .array(
      z.object({
        action: AccessAction,
        itemId: Id.nullable().optional(),
        incidentId: Id.nullable().optional(),
        at: DateTime,
      }),
    )
    .min(1)
    .max(100),
  device: z.string().trim().max(100).optional(),
});

export const AccessLogEntry = z.object({
  action: AccessAction,
  itemId: Id.nullable(),
  incidentId: Id.nullable(),
  device: z.string().nullable(),
  at: DateTime,
});

/** POST /v1/vault/reset — forgotten password: start a new vault. The old evidence cannot be opened
 * without the old password, so it is deleted; items still protected from deletion are hidden and
 * deleted when their protection ends. Typing RESET confirms it. */
export const VaultResetRequest = z.object({ confirm: z.literal('RESET') });

/** Reply to POST /v1/vault/reset. */
export const VaultResetResult = z.object({
  deleted: z.number().int(),
  keptLocked: z.number().int(),
  /** When the last protected item will be deleted (null if none). */
  lockedUntil: DateTime.nullable(),
});

/** GET /v1/vault/usage */
export const VaultUsage = z.object({
  usedBytes: z.number().int(),
  limitBytes: z.number().int(),
  items: z.number().int(),
});

// ---------------------------------------------------------------------------------------------
// Community feed (feature 23)
// ---------------------------------------------------------------------------------------------

export const PostCategory = z.enum(['lighting', 'unsafe_spot', 'harassment_area', 'road', 'other']);

/** Area names (Noida sectors etc.): letters, numbers, spaces and - . , */
export const AreaName = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[\p{L}\p{N} .,'-]+$/u, { error: 'Use letters, numbers and spaces' });

const PHONE_IN_TEXT = /(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/;
const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** POST /v1/community/reports — shown only after an admin approves it. */
export const CommunityReportRequest = z.object({
  id: Id,
  category: PostCategory,
  area: AreaName,
  body: z
    .string()
    .trim()
    .min(20, { error: 'Write at least 20 characters' })
    .max(500, { error: 'Write at most 500 characters' })
    .refine((v) => !PHONE_IN_TEXT.test(v) && !EMAIL_IN_TEXT.test(v), {
      error: 'Remove phone numbers or emails from your report',
    }),
  /** Storage key from POST /v1/community/photo-upload, if a photo was added. */
  photoKey: z.string().max(300).optional(),
});

export const CommunityPhotoUploadRequest = z.object({
  sizeBytes: z.number().int().min(1).max(MAX_SOS_PHOTO_BYTES),
});

export const CommunityPost = z.object({
  id: Id,
  category: PostCategory,
  area: z.string(),
  body: z.string(),
  photoUrl: z.string().nullable(),
  official: z.boolean(),
  createdAt: DateTime,
});

export const MyCommunityReport = CommunityPost.extend({
  status: z.enum(['pending', 'published', 'rejected', 'removed']),
  reason: z.string().nullable(),
});

/** POST /v1/community/posts/:id/flag */
export const FlagPostRequest = z.object({
  reason: z.string().trim().min(3).max(300),
});

// ---------------------------------------------------------------------------------------------
// Rakshak sign-up (feature 24)
// ---------------------------------------------------------------------------------------------

export const IdType = z.enum(['aadhaar', 'pan', 'driving_licence', 'voter_id', 'passport']);

/** POST /v1/rakshak/document-upload */
export const RakshakDocumentUploadRequest = z.object({
  document: z.enum(['idFront', 'idBack', 'selfie']),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_SOS_PHOTO_BYTES * 3),
});

/** How many areas a Rakshak can help in. */
export const MAX_RAKSHAK_AREAS = 5;

/** POST /v1/rakshak/application */
export const RakshakApplicationRequest = z.object({
  fullName: z.string().trim().min(2).max(80),
  dateOfBirth: z.iso.date({ error: 'Must be a date (YYYY-MM-DD)' }),
  address: z.string().trim().min(10).max(300),
  /** The first (main) area. Apps before multi-area send only this. */
  area: AreaName,
  /**
   * Every area where the Rakshak can help, 1 to 5, no repeats (the first is the main one). When
   * left out, the Rakshak helps in `area` only.
   */
  areas: z
    .array(AreaName)
    .min(1)
    .max(MAX_RAKSHAK_AREAS, { error: `Choose at most ${MAX_RAKSHAK_AREAS} areas` })
    .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, {
      error: 'Each area only once',
    })
    .optional(),
  idType: IdType,
  /** Only the last 4 characters of the ID number are kept (never a full Aadhaar number). */
  idLast4: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-Z]{4}$/, { error: 'Enter the last 4 characters of your ID number' }),
  motivation: z.string().trim().min(20).max(1000),
  /** Storage keys of the uploaded documents. */
  documents: z.object({ idFront: z.string(), idBack: z.string(), selfie: z.string() }),
  agreeToChecks: z.literal(true, { error: 'Please agree to the verification checks' }),
});

/**
 * POST /v1/rakshak/presence — an approved Rakshak with "Available now" on, every few minutes.
 * `start: true` when the switch is turned on (starts the time limit). Only the latest position is
 * kept; others see a first name and a position rounded to about 100 m.
 */
export const RakshakPresenceRequest = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).optional(),
  start: z.boolean().optional(),
});

/** Reply to POST /v1/rakshak/presence: when "Available now" switches itself off. */
export const RakshakPresence = z.object({ availableUntil: DateTime });

export const RakshakApplication = z.object({
  id: Id,
  status: z.enum(['under_review', 'approved', 'rejected', 'withdrawn']),
  reason: z.string().nullable(),
  /** The main area (the first of `areas`). */
  area: z.string(),
  /** Every area where the Rakshak helps (1 to 5). */
  areas: z.array(z.string()),
  createdAt: DateTime,
  decidedAt: DateTime.nullable(),
});

// ---------------------------------------------------------------------------------------------
// Plans and subscriptions (feature 25)
// ---------------------------------------------------------------------------------------------

export const PlanId = z.enum(['basic', 'silver', 'gold']);

export const Plan = z.object({
  id: PlanId,
  name: z.string(),
  monthlyPriceInr: z.number().int().nullable(),
  yearlyPriceInr: z.number().int().nullable(),
  monthlyProductId: z.string().nullable(),
  yearlyProductId: z.string().nullable(),
  features: z.array(z.string()),
  evidenceStorageMb: z.number().int(),
  /** false = not sold yet ("Coming soon"); every feature is free until plans go on sale. */
  onSale: z.boolean(),
});

/** GET /v1/plans */
export const PlansReply = z.object({
  plans: z.array(Plan),
  current: PlanId,
  /** True while no plan is on sale: everything is unlocked for everyone. */
  everythingFree: z.boolean(),
  renewsAt: DateTime.nullable(),
});

/** POST /v1/subscriptions/verify — after a Google Play purchase. */
export const VerifyPurchaseRequest = z.object({
  productId: z.string().trim().min(1).max(200),
  purchaseToken: z.string().trim().min(10).max(4000),
});

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type SosTriggerSettings = z.infer<typeof SosTriggerSettings>;
export type UpdateSosTriggerSettings = z.infer<typeof UpdateSosTriggerSettings>;
export type FalseAlarmRequest = z.infer<typeof FalseAlarmRequest>;
export type SosPhotoUploadRequest = z.infer<typeof SosPhotoUploadRequest>;
export type SaveSosPhotoRequest = z.infer<typeof SaveSosPhotoRequest>;
export type SosPhoto = z.infer<typeof SosPhoto>;
export type DailyTracking = z.infer<typeof DailyTracking>;
export type UpdateDailyTracking = z.infer<typeof UpdateDailyTracking>;
export type DailyPointsRequest = z.infer<typeof DailyPointsRequest>;
export type Timeline = z.infer<typeof Timeline>;
export type TimelineStop = z.infer<typeof TimelineStop>;
export type TimelineRoute = z.infer<typeof TimelineRoute>;
export type TimelineSummary = z.infer<typeof TimelineSummary>;
export type VaultKey = z.infer<typeof VaultKey>;
export type EvidenceUploadRequest = z.infer<typeof EvidenceUploadRequest>;
export type SaveEvidenceRequest = z.infer<typeof SaveEvidenceRequest>;
export type EvidenceItem = z.infer<typeof EvidenceItem>;
export type UpdateEvidenceRequest = z.infer<typeof UpdateEvidenceRequest>;
export type SaveIncidentRequest = z.infer<typeof SaveIncidentRequest>;
export type UpdateIncidentRequest = z.infer<typeof UpdateIncidentRequest>;
export type Incident = z.infer<typeof Incident>;
export type AccessLogRequest = z.infer<typeof AccessLogRequest>;
export type AccessLogEntry = z.infer<typeof AccessLogEntry>;
export type VaultUsage = z.infer<typeof VaultUsage>;
export type VaultResetRequest = z.infer<typeof VaultResetRequest>;
export type VaultResetResult = z.infer<typeof VaultResetResult>;
export type CommunityReportRequest = z.infer<typeof CommunityReportRequest>;
export type CommunityPhotoUploadRequest = z.infer<typeof CommunityPhotoUploadRequest>;
export type CommunityPost = z.infer<typeof CommunityPost>;
export type MyCommunityReport = z.infer<typeof MyCommunityReport>;
export type FlagPostRequest = z.infer<typeof FlagPostRequest>;
export type RakshakDocumentUploadRequest = z.infer<typeof RakshakDocumentUploadRequest>;
export type RakshakApplicationRequest = z.infer<typeof RakshakApplicationRequest>;
export type RakshakApplication = z.infer<typeof RakshakApplication>;
export type RakshakPresenceRequest = z.infer<typeof RakshakPresenceRequest>;
export type RakshakPresence = z.infer<typeof RakshakPresence>;
export type Plan = z.infer<typeof Plan>;
export type PlansReply = z.infer<typeof PlansReply>;
export type VerifyPurchaseRequest = z.infer<typeof VerifyPurchaseRequest>;
