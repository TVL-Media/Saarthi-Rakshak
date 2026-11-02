# User app API

Every call the Android app makes to the server. The source of truth is
[`packages/shared/src/app-api.ts`](../packages/shared/src/app-api.ts) (Zod schemas, used by the server to check
input); this page is the same list for the Flutter app. Change both together.

Status: **matches Implementation Plan v2 (31 Oct 2026)**. All app calls start with `/v1`; guardian pages use `/g`.
Built so far: **A1, A2, A3, A4, A5** (A6–A7 and audio follow the plan; their exact shapes are confirmed when built).

## Basics

| Item | Rule |
| --- | --- |
| Address | Debug builds: `http://localhost:3000` (USB + `adb reverse`), `http://10.0.2.2:3000` (emulator) or `http://<laptop-ip>:3000` (Wi-Fi). Release builds: HTTPS only |
| Format | JSON in, JSON out (`Content-Type: application/json`) |
| Login | After login, send `Authorization: Bearer <token>` on every call. Keep the token in encrypted storage |
| Ids | SOS, journey, check-in, location point and device ids are **UUIDs made on the phone**. Sending the same id again never creates a second record — safe to retry |
| Times | ISO date-time with time zone: `2026-10-27T18:30:00+05:30` or `2026-10-27T13:00:00Z` |
| Phone numbers | Indian mobiles in any common form (`98123 44521`, `+91 98123 44521`, `098123 44521`) |

### Errors

Every error has the same shape:

```json
{ "error": "limit_reached", "message": "You can have up to 5 guardians." }
```

| `error` | HTTP | Meaning | App should |
| --- | --- | --- | --- |
| `invalid_input` | 400 | A field is missing or wrong | Show `message` |
| `not_logged_in` | 401 | No token, or the session ended (logout, new login on another phone, account deleted) | Go to login |
| `consent_required` | 403 | Terms not accepted yet | Show the consent screen |
| `not_found` | 404 | Not found, or not this user's | Show `message` |
| `conflict` | 409 | E.g. a journey is already active | Show `message` / refresh |
| `limit_reached` | 409 | E.g. 5 guardians already, daily invite limit | Show `message` |
| `too_many_requests` | 429 | Too many tries | Wait, then retry |
| `link_expired` | 410 | Guardian invite link is no longer valid | Show `message` |
| `service_unavailable` | 503 | A needed service is not set up or not reachable (e.g. login) | Show `message`, retry later |
| `server_error` | 500 | Something unexpected on the server | Show `message`, retry |

Anything else: show `message`.

---

## A1 — Login

Login is phone + OTP with **Firebase** on the phone; then the app swaps the Firebase token for our own token.

| Call | Login | Body | Reply |
| --- | --- | --- | --- |
| `POST /v1/auth/firebase` | No | `{ firebaseIdToken }` | `{ token, user: Me, isNewUser }` |
| `POST /v1/auth/logout` | Yes | — | `204` |
| `GET /v1/me` | Yes | — | `Me` |
| `POST /v1/me/consent` | Yes | `{ version }` e.g. `"2026-10"` | `Me` |

`Me` = `{ id, name, phone, bloodGroup, photoUrl, consentGiven, guardiansCount, acceptedGuardiansCount, rules }`
(`name`, `bloodGroup`, `photoUrl` may be `null`). `rules` = the safety settings the app needs, e.g.
`{ "sos.countdown_seconds": 5, "checkin.stopped_minutes": 3, … }`.

Until consent is given, only these four calls work; everything else returns `consent_required`.

- Only Indian mobile numbers can log in (`invalid_input` otherwise).
- One phone at a time: a new login ends the session on the old phone (it gets `not_logged_in`).
- A session lasts 90 days from the last use.
- At most 10 login tries per network address in 15 minutes (`too_many_requests`).

## A2 — Profile and phone details

| Call | Body | Reply |
| --- | --- | --- |
| `PATCH /v1/me` | `{ name?, bloodGroup? }` — at least one; `bloodGroup: null` clears it | `Me` |
| `POST /v1/me/photo-upload` | `{ sizeBytes }` (JPEG, max 2 MB) | `{ key, uploadUrl, headers, expiresAt }` |
| `POST /v1/me/photo` | `{ key }` | `Me` |
| `PUT /v1/me/device` | see below | `204` |

Name: 2–50 characters; letters in any language (Hindi too), spaces and `. ' ’ -`; starts with a letter.

**Photo upload:** call `photo-upload`, then `PUT` the JPEG bytes to `uploadUrl` with **exactly** the `headers` given
(type and size are part of the link), within 5 minutes, then call `POST /v1/me/photo` with the `key`.

**Device** (send after login, on app start, and whenever a value changes):

```json
{
  "deviceId": "uuid made once per install",
  "model": "Redmi Note 13",
  "androidVersion": "14",
  "appVersion": "1.0.0",
  "pushToken": "FCM token or null",
  "permissions": { "location": true, "notifications": true, "sms": true, "microphone": false },
  "batteryOptimisationOff": true
}
```

The four `permissions` keys are fixed: the admin panel's "Setup complete" check reads them.

- `photoUrl` works for 1 hour; call `GET /v1/me` again for a fresh one.
- At most 10 photo upload links per hour.
- If another user logs in on the same phone (same `deviceId`), the phone moves to that user.

## A3 — Guardians and invites

| Call | Body | Reply |
| --- | --- | --- |
| `GET /v1/guardians` | — | `Guardian[]` |
| `POST /v1/guardians` | `{ name, phone, relation? }` | `Guardian` |
| `PATCH /v1/guardians/:id` | `{ name?, relation? }` — `relation: null` clears it | `Guardian` |
| `POST /v1/guardians/:id/resend-invite` | — | `204` |
| `DELETE /v1/guardians/:id` | — | `204` |

`Guardian` = `{ id, name, relation, phoneMasked, status }`; `status` is `pending`, `accepted` or `declined`.

Limits: up to 5 guardians (Settings → max guardians); not your own number; not the same number twice;
at most 10 invites a day (resends count).
A number that declined can't be invited again by the same user. Guardians can't be removed during an SOS (`conflict`).

The invite SMS has the link `GUARDIAN_WEB_URL/i/<code>`, valid 7 days; a resend makes a new link and the old one
stops working. Until Part B, the SMS is only printed in the server console (number masked).

Used by the guardian's invite page (no login):

| Call | Reply |
| --- | --- |
| `GET /g/i/:code` | `{ inviterFirstName, guardianName, status, expiresAt }` |
| `POST /g/i/:code/accept` | `204` |
| `POST /g/i/:code/decline` | `204` |

- Expired link → `link_expired` (410); unknown code → `not_found`.
- Accept twice is fine. An accepted guardian can still decline with the link (while it is valid); a declined one can't accept.
- Declining deletes the guardian's number.
- At most 30 calls per minute per network address.

## A4 — SOS

| Call | Body | Reply |
| --- | --- | --- |
| `POST /v1/sos` | `{ id, trigger, startedAt, journeyId?, location?, simSmsSentTo? }` | `Sos` |
| `POST /v1/sos/test` | `{ id, startedAt }` | `Sos` (already ended) |
| `POST /v1/sos/:id/end` | `{ reason: "safe" }` | `Sos` |
| `POST /v1/sos/cancelled` | `{ id, trigger, startedAt, cancelledAt }` | `204` |
| `GET /v1/sos/active` | — | `Sos` or `204` if none |
| `GET /v1/sos/:id` | — | `Sos` |

- `trigger`: `button`, `widget`, `tile`, `checkin`, `journey`.
- `location`: `{ lat, lng, accuracyM? }`.
- Send `POST /v1/sos` when the 5-second countdown ends. If the user cancels during the countdown, send
  `POST /v1/sos/cancelled` later (nothing is sent to anyone; it only counts as a false alarm).
- `simSmsSentTo`: guardian ids the phone already reached by SMS from its own SIM (no internet at the time). They get
  only the live link, never a second SOS SMS.
- `Sos` = `{ id, trigger, isTest, status, startedAt, endedAt, guardians: [{ guardianId, name, relation, alertedAt, openedAt, respondingAt }] }`.
- The same `id` sent again returns the same SOS (no second alert). While an SOS is active, a new start returns the
  active one.
- `startedAt` may be up to a day old (sent late after being offline), but not more than 1 minute in the future.
- A real SOS reaches guardians who accepted **or have not answered yet**, each with a secret live link
  (`GUARDIAN_WEB_URL/l/<code>`); declined ones get nothing.
- Test SOS: accepted guardians only, message marked TEST with no link, at most 5 a day; `conflict` if no guardian has
  accepted yet. It is saved as an SOS that has already ended (nothing to stop).
- After "I'm safe", links stay open 15 more minutes (Settings), then expire; guardians get a "safe" message.
- `alertedAt` stays `null` until Part B really sends alerts. Until then the messages are printed in the server console.

## A5 — Live location and heartbeat

| Call | Body | Reply |
| --- | --- | --- |
| `POST /v1/locations` | `{ points: [...] }` — 1 to 50 points | `{ saved, duplicates }` |
| `POST /v1/heartbeat` | `{ batteryPct?, network?, sosId?, journeyId? }` | `204` |

Each point:

```json
{
  "clientPointId": "uuid made on the phone",
  "sosId": "uuid (or journeyId, or both)",
  "lat": 28.5706, "lng": 77.3272, "accuracyM": 12,
  "batteryPct": 64, "network": "mobile",
  "recordedAt": "2026-10-27T18:31:05+05:30"
}
```

`network`: `wifi`, `mobile`, `none`, `unknown`. Points sent twice are counted as `duplicates`, not saved again.
Send heartbeat every 30–60 seconds during an SOS or journey.

- Points are accepted for the user's own SOS / journey while it is active and for 2 minutes after it ends (late
  uploads); after that → `conflict`. Someone else's id → `not_found`.
- `recordedAt` may be up to a day old (sent late after being offline), not more than 1 minute in the future.
- Points can arrive in any order; the live map always shows the newest one.
- At most 120 location calls per minute.

## A6 — Journeys and check-ins

| Call | Body | Reply |
| --- | --- | --- |
| `POST /v1/journeys` | `{ id, destination: { lat, lng, label }, expectedArrivalAt, route? }` | `Journey` |
| `GET /v1/journeys/active` | — | `Journey` or `204` if none |
| `POST /v1/journeys/:id/arrived` | — | `Journey` |
| `POST /v1/journeys/:id/end` | — | `Journey` |
| `POST /v1/journeys/:id/checkins` | `{ id, reason }` — `off_route` or `stopped` | `Checkin` |
| `POST /v1/checkins/:id/answer` | `{ answer }` — `fine`, `traffic` or `sos` | `Checkin` |

- `route`: Google encoded polyline (optional).
- `Journey` = `{ id, status, destination, expectedArrivalAt, startedAt, endedAt, openCheckin, checkinsPausedUntil }`.
- `Checkin` = `{ id, reason, source, status, askedAt }`; `reason` can also be `late` (made by the server).
- Answer `traffic` pauses check-ins for 10 minutes. Answer `sos`: then send `POST /v1/sos` with `trigger: "checkin"`.

## A7 — History, delete account, support

| Call | Body | Reply |
| --- | --- | --- |
| `GET /v1/history?before=<time>` | — | `{ items, nextBefore }` (20 per page, newest first) |
| `GET /v1/history/sos/:id` | — | `{ item, timeline }` |
| `GET /v1/history/journeys/:id` | — | `{ item, timeline }` |
| `DELETE /v1/me` | `{ firebaseIdToken }` (fresh OTP) | `204` (refused while an SOS or journey is active) |
| `POST /v1/support-tickets` | `{ category, message }` | `204` |

- History item: `{ type: "sos" | "journey", id, status, isTest, startedAt, endedAt }`.
- Timeline entry: `{ at, kind, text }`.
- Support `category`: `otp`, `guardian_sms`, `app_stopped`, `other`; `message` 10–2000 characters; at most 5 a day.
