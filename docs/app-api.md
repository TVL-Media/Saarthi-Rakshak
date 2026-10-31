# User app API

Every call the Android app makes to the server. The source of truth is
[`packages/shared/src/app-api.ts`](../packages/shared/src/app-api.ts) (Zod schemas, used by the server to check
input); this page is the same list for the Flutter app. Change both together.

Status: **contract agreed (A0)**. Each call is built in the step shown. Built so far: **A1, A2, A3, A4, A5**.

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
{ "error": "account_blocked", "message": "Your account is blocked. Contact support." }
```

| `error` | HTTP | Meaning | App should |
| --- | --- | --- | --- |
| `invalid_input` | 400 | A field is missing or wrong | Show `message` |
| `not_logged_in` | 401 | No token, or the session ended (logout, new login on another phone, account deleted) | Go to login |
| `consent_required` | 403 | Terms not accepted yet | Show the consent screen |
| `account_blocked` | 403 | Blocked by the support team | Show `message`. **SOS still works** if already logged in |
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
| `POST /app/auth/login` | No | `{ firebaseIdToken }` | `{ token, user: Me, isNewUser }` |
| `POST /app/auth/logout` | Yes | — | `204` |
| `GET /app/me` | Yes | — | `Me` |
| `POST /app/me/consent` | Yes | `{ version }` e.g. `"2026-10"` | `Me` |

`Me` = `{ id, name, phone, bloodGroup, consentGiven, guardiansCount }` (`name` and `bloodGroup` may be `null`).

Until consent is given, only these four calls work; everything else returns `consent_required`.

- Only Indian mobile numbers can log in (`invalid_input` otherwise).
- One phone at a time: a new login ends the session on the old phone (it gets `not_logged_in`).
- A session lasts 90 days from the last use.
- A blocked user can't log in (`account_blocked`); if already logged in, they stay logged in so SOS works.
- At most 10 login tries per network address in 15 minutes (`too_many_requests`).

## A2 — Profile and phone details

| Call | Body | Reply |
| --- | --- | --- |
| `GET /app/profile` | — | `{ name, bloodGroup, photoUrl }` |
| `PATCH /app/profile` | `{ name?, bloodGroup? }` — at least one; `bloodGroup: null` clears it | Profile |
| `POST /app/profile/photo-upload` | `{ sizeBytes }` (JPEG, max 2 MB) | `{ key, uploadUrl, headers, expiresAt }` |
| `POST /app/profile/photo` | `{ key }` | Profile |
| `PUT /app/device` | see below | `204` |

**Photo upload:** call `photo-upload`, then `PUT` the JPEG bytes to `uploadUrl` with **exactly** the `headers` given
(type and size are part of the link), within 5 minutes, then call `POST /app/profile/photo` with the `key`.

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

- `photoUrl` works for 1 hour; get the profile again for a fresh one.
- At most 10 photo upload links per hour.
- If another user logs in on the same phone (same `deviceId`), the phone moves to that user.

## A3 — Guardians and invites

| Call | Body | Reply |
| --- | --- | --- |
| `GET /app/guardians` | — | `Guardian[]` |
| `POST /app/guardians` | `{ name, phone, relation? }` | `Guardian` |
| `POST /app/guardians/:id/resend` | — | `204` |
| `DELETE /app/guardians/:id` | — | `204` |

`Guardian` = `{ id, name, relation, phoneMasked, status }`; `status` is `pending`, `accepted` or `declined`.

Limits: up to 5 guardians (Settings → max guardians); not your own number; not the same number twice;
at most 10 invites a day (resends count). A blocked user can't add or re-invite (`account_blocked`).
A number that declined can't be invited again by the same user. Guardians can't be removed during an SOS (`conflict`).

The invite SMS has the link `GUARDIAN_WEB_URL/invite/<code>`, valid 7 days; a resend makes a new link and the old one
stops working. Until Part B, the SMS is only printed in the server console (number masked).

Used by the guardian's invite page (no login):

| Call | Reply |
| --- | --- |
| `GET /g/invite/:code` | `{ inviterFirstName, guardianName, status, expiresAt }` |
| `POST /g/invite/:code/accept` | `204` |
| `POST /g/invite/:code/decline` | `204` |

- Expired link → `link_expired` (410); unknown code → `not_found`.
- Accept twice is fine. An accepted guardian can still decline with the link (while it is valid); a declined one can't accept.
- Declining deletes the guardian's number.
- At most 30 calls per minute per network address.

## A4 — SOS

| Call | Body | Reply |
| --- | --- | --- |
| `POST /app/sos` | `{ id, trigger, isTest, startedAt, journeyId?, location? }` | `Sos` |
| `POST /app/sos/:id/end` | `{ reason: "safe" }` | `Sos` |
| `POST /app/sos/cancelled` | `{ id, trigger, isTest, startedAt, cancelledAt }` | `204` |
| `GET /app/sos/active` | — | `Sos` or `204` if none |

- `trigger`: `button`, `widget`, `tile`, `checkin`, `journey`.
- `location`: `{ lat, lng, accuracyM? }`.
- Send `POST /app/sos` when the 5-second countdown ends. If the user cancels during the countdown, send
  `POST /app/sos/cancelled` later (no alerts; it only counts as a false alarm).
- `Sos` = `{ id, trigger, isTest, status, startedAt, endedAt, guardians: [{ guardianId, name, relation, alertedAt, openedAt, respondingAt }] }`.
- Works even for a blocked user.
- The same `id` sent again returns the same SOS (no second alert). While an SOS is active, a new start returns the
  active one.
- `startedAt` may be up to a day old (sent late after being offline), but not more than 1 minute in the future.
- Guardians who accepted **or have not answered yet** get a secret live link each (`GUARDIAN_WEB_URL/g/<code>`);
  declined ones don't. A test SOS says TEST in the message.
- After "I'm safe", links stay open 15 more minutes (Settings), then expire; guardians get a "safe" message.
- `alertedAt` stays `null` until Part B really sends alerts. Until then the messages are printed in the server console.

## A5 — Live location and heartbeat

| Call | Body | Reply |
| --- | --- | --- |
| `POST /app/locations` | `{ points: [...] }` — 1 to 50 points | `{ saved, duplicates }` |
| `POST /app/heartbeat` | `{ batteryPct?, network?, sosId?, journeyId? }` | `204` |

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
- At most 120 location calls per minute. Works for blocked users.

## A6 — Journeys and check-ins

| Call | Body | Reply |
| --- | --- | --- |
| `POST /app/journeys` | `{ id, destination: { lat, lng, label }, expectedArrivalAt, route? }` | `Journey` |
| `GET /app/journeys/active` | — | `Journey` or `204` if none |
| `POST /app/journeys/:id/arrived` | — | `Journey` |
| `POST /app/journeys/:id/end` | — | `Journey` |
| `POST /app/journeys/:id/checkins` | `{ id, reason }` — `off_route` or `stopped` | `Checkin` |
| `POST /app/checkins/:id/answer` | `{ answer }` — `fine`, `traffic` or `sos` | `Checkin` |

- `route`: Google encoded polyline (optional).
- `Journey` = `{ id, status, destination, expectedArrivalAt, startedAt, endedAt, openCheckin, checkinsPausedUntil }`.
- `Checkin` = `{ id, reason, source, status, askedAt }`; `reason` can also be `late` (made by the server).
- Answer `traffic` pauses check-ins for 10 minutes. Answer `sos`: then send `POST /app/sos` with `trigger: "checkin"`.

## A7 — History, delete account, support

| Call | Body | Reply |
| --- | --- | --- |
| `GET /app/history?before=<time>` | — | `{ items, nextBefore }` (20 per page, newest first) |
| `GET /app/history/sos/:id` | — | `{ item, timeline }` |
| `GET /app/history/journeys/:id` | — | `{ item, timeline }` |
| `DELETE /app/account` | — | `204` (refused while an SOS or journey is active) |
| `POST /app/support` | `{ category, message }` | `204` |

- History item: `{ type: "sos" | "journey", id, status, isTest, startedAt, endedAt }`.
- Timeline entry: `{ at, kind, text }`.
- Support `category`: `otp`, `guardian_sms`, `app_stopped`, `other`; `message` 10–2000 characters; at most 5 a day.
