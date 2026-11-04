# User app API

Every call the Android app makes to the server. The source of truth is
[`packages/shared/src/app-api.ts`](../packages/shared/src/app-api.ts) (Zod schemas, used by the server to check
input); this page is the same list for the Flutter app. Change both together.

Status: **matches Implementation Plan v2 (31 Oct 2026)**. All app calls start with `/v1`; guardian pages use `/g`.
Built so far: **A1–A8**, push notifications and the guardian pages API (Parts B and C). The Android app (Part D) is in `apps/mobile`.

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

`Me` = `{ id, name, phone, bloodGroup, gender, dateOfBirth, email, homeAddress, medicalNotes, photoUrl, consentGiven, guardiansCount, acceptedGuardiansCount, rules }`
(`name`, `bloodGroup`, the profile details and `photoUrl` may be `null`; `gender` is `female`, `male` or `other`;
`dateOfBirth` is `YYYY-MM-DD`). The profile details are shown only to the user, never to guardians or admins. `rules` = the safety settings the app needs, e.g.
`{ "sos.countdown_seconds": 5, "checkin.stopped_minutes": 3, … }`.

Until consent is given, only these four calls work; everything else returns `consent_required`.

- Only Indian mobile numbers can log in (`invalid_input` otherwise).
- One phone at a time: a new login ends the session on the old phone (it gets `not_logged_in`).
- A session lasts 90 days from the last use.
- At most 10 login tries per network address in 15 minutes (`too_many_requests`).

## A2 — Profile and phone details

| Call | Body | Reply |
| --- | --- | --- |
| `PATCH /v1/me` | `{ name?, bloodGroup?, gender?, dateOfBirth?, email?, homeAddress?, medicalNotes? }` — at least one; `null` (or empty text) clears an optional field | `Me` |
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

`Guardian` = `{ id, name, relation, phoneMasked, phone, status }`; `status` is `pending`, `accepted` or `declined`.
`phone` is the full number (E.164) for the owner's own phone: the app keeps it so an SOS can go out by SMS from the
phone's SIM without internet (null once declined).

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
| `GET /v1/journeys/:id` | — | `Journey` |
| `POST /v1/journeys/:id/end` | `{ outcome }` — `arrived` ("I reached safely") or `ended` | `Journey` |
| `POST /v1/journeys/:id/checkins` | `{ id, reason }` — `stopped`, `off_route` or `late` | `Checkin` |
| `POST /v1/checkins/:id/answer` | `{ answer }` — `fine`, `traffic_pause` or `sos` | `Checkin` |

- `Journey` = `{ id, status, destination, expectedArrivalAt, startedAt, endedAt, openCheckin, checkinsPausedUntil, route }`;
  `status` is `active`, `arrived`, `ended` or `lost_contact`.
- `Checkin` = `{ id, reason, source, status, askedAt }`; `status` is `pending`, `fine`, `traffic_pause`, `sos` or `no_reply`.
- A journey is shared with **all accepted guardians**; at least one is needed (`conflict` otherwise). Each gets an SMS
  with a live link (`GUARDIAN_WEB_URL/l/<code>`): "Priya started a journey to Home, arriving 11:28 pm. Follow: …".
- `expectedArrivalAt` between 5 minutes and 12 hours from now. One journey at a time (`conflict`: "End it first").
  The same `id` again returns the same journey. `route` = Google encoded polyline (optional).
- End: guardians get "Priya reached Home safely." or "Priya ended the journey to Home."; links stay open 15 more
  minutes (Settings). A check-in still waiting is closed. Ending twice is fine.
- Check-ins are decided on the phone (stopped 3 min, 500 m off route for 2 points in a row, 15 min late); the phone
  shows the alert and tells the server. While one waits for an answer, raising again returns that one.
- Refused (`conflict`) while check-ins are paused after "Stuck in traffic" (10 min, Settings) and, for the same reason,
  within 5 minutes of "I'm fine".
- Answer `sos`: the app then sends `POST /v1/sos` with `trigger: "checkin"` and `journeyId`.
- No answer in 2 minutes → guardians alerted (Part B timer). A late answer is still recorded; an answered check-in
  can't change.

## A7 — History, saved places, report a problem, delete account

| Call | Body | Reply |
| --- | --- | --- |
| `GET /v1/history?type=&cursor=` | — | `{ items, nextCursor }` (20 per page, newest first) |
| `GET /v1/history/sos/:id` | — | `{ item, timeline, clips }` |
| `GET /v1/history/journeys/:id` | — | `{ item, timeline, clips: [] }` |
| `GET /v1/places` | — | `SavedPlace[]` (Home, Work, then others) |
| `POST /v1/places` | `{ label, name, address?, lat, lng }` | `SavedPlace` |
| `DELETE /v1/places/:id` | — | `204` |
| `POST /v1/support-tickets` | `{ category, message, appVersion?, deviceModel? }` | `204` |
| `DELETE /v1/me` | `{ firebaseIdToken, confirm: "DELETE" }` | `204` |

- History item: `{ type: "sos" | "journey", id, status, isTest, trigger, destinationLabel, startedAt, endedAt }`.
  SOS `status`: `active`, `ended`, `cancelled` (stopped in the countdown). Journey `status`: `active`, `arrived`,
  `ended`, `lost_contact`. `type` filters the list (All · SOS · Journeys); pass `nextCursor` as `cursor` for the next
  page (null = no more).
- Timeline entry: `{ at, kind, text }`, oldest first. `kind`: `sos_started`, `sos_cancelled`, `guardian_alerted`,
  `link_opened`, `guardian_responding`, `sos_ended`, `journey_started`, `checkin`, `checkin_answered`,
  `journey_ended`. Show `text` as it is ("Ravi opened the live link").
- `clips` (SOS only): `{ id, recordedAt, durationS, keep, deleteAfter }` — audio clips not yet deleted (A8).
- Saved place `label`: `home`, `work` or `other`. Saving `home` or `work` again replaces it (same `id`). Up to 8
  `other` (`limit_reached`). `name` 1–60 characters, `address` up to 200.
- Support `category`: `otp`, `guardian_sms`, `app_stopped`, `other`; `message` 10–2000 characters; at most 5 a day
  (`too_many_requests`). Without `appVersion` / `deviceModel` the last ones from `PUT /v1/me/device` are saved.
- Delete account: the app explains what is deleted, has the user type DELETE, then runs a **new phone OTP** and sends
  that Firebase token (at most 5 minutes old, same number; otherwise `invalid_input`). Refused while an SOS or journey
  is active (`conflict`: "End your SOS or journey first."). Removes the profile, guardians, places, journeys,
  locations, audio and photo files, sessions and the Firebase login; SOS events and alerts stay without the person.
  Then go to Welcome; the old token gets `not_logged_in`.

## A8 — Audio during an SOS

Clips are encrypted **on the phone** with a key kept only in that phone's Android Keystore. The server stores the
encrypted bytes and can never play them; admins have no play or download option.

| Call | Body | Reply |
| --- | --- | --- |
| `POST /v1/sos/:id/audio-upload` | `{ clipId, sizeBytes }` | `{ key, uploadUrl, headers, expiresAt }` |
| `POST /v1/sos/:id/audio` | `{ clipId, recordedAt, durationS }` | `AudioClip` |
| `PATCH /v1/audio/:id` | `{ keep }` | `AudioClip` |
| `GET /v1/audio/:id/play` | — | `{ url, expiresAt }` (10 minutes) |

- Flow per 30-second clip: make a `clipId` (UUID) → ask for an upload link → `PUT` the encrypted file to `uploadUrl`
  with exactly `headers` (`Content-Type: application/octet-stream`, `Content-Length`) → record it. Offline: keep the
  file and do the same later. Recording again with the same `clipId` returns the same clip.
- At most 2 MB per clip, `durationS` 0–120, `recordedAt` during the SOS. 300 upload links per hour.
- Only for the user's own real SOS (`conflict` for a test or countdown-cancelled SOS).
- `AudioClip` = `{ id, recordedAt, durationS, keep, deleteAfter }`. Deleted `deleteAfter` (30 days, from the rules
  copied onto the SOS) unless `keep` is true. The clips of an SOS are listed in `GET /v1/history/sos/:id`.
- Play: download `url` (the encrypted file) and decrypt it on the phone. Another phone, or the same phone after a
  reset or reinstall, cannot decrypt it.

## Push notifications to the phone (Part B)

The server sends these to the newest phone of the user with a push token (`PUT /v1/me/device`), as
Firebase Cloud Messaging messages with a notification (Android channel `safety_alerts`, high priority) and
`data` values (all strings):

| `data.type` | When | Other `data` | App should |
| --- | --- | --- | --- |
| `guardian_status` | A guardian opened the live link or tapped "I'm responding" | `sosId` or `journeyId`, `guardianId`, `status` (`opened` / `responding`) | Refresh `GET /v1/sos/:id` (or the journey) |
| `show_call_112` | No guardian responded within 5 minutes of the SOS (Settings) | `sosId` | Show the big **Call 112** button on the SOS screen |
| `checkin_no_reply` | A check-in was not answered within 2 minutes; guardians got the live link | `journeyId`, `checkinId` | Show "Your guardians were told" |

A token Firebase reports as no longer valid is removed; the app sends a new one with `PUT /v1/me/device`.

## Guardian pages (Part C) — `/g/...`, no login

The SMS links open the guardian pages (`apps/guardian-web`): `GUARDIAN_WEB_URL/i/<code>` (invite) and
`GUARDIAN_WEB_URL/l/<code>` (live). The pages call:

| Call | Reply |
| --- | --- |
| `GET /g/l/:code` | `LiveView` — `410 link_expired` "This alert has ended." once the link has expired (or for an unknown code) |
| `POST /g/l/:code/responding` | `LiveView` (SOS only and while active; `conflict` otherwise). Tapping again is fine |

- `LiveView` = `{ kind, status, outcome, person: { firstName, phone, bloodGroup }, location, batteryPct,
  lostContact, startedAt, endedAt, journey, guardians: [{ firstName, status, isYou }], youAreResponding }`.
  `phone` and `bloodGroup` only for an SOS. `journey` = `{ destinationLabel, destination, expectedArrivalAt, route }`.
- The first open of a link is recorded (`opened`) and pushed to the user; "I'm responding" too, and it stops the
  "no guardian responded" reminder.
- Live updates: Socket.IO at path `/g/socket.io`, connect with `auth: { code }`. Events: `ready` (joined),
  `location` (a new point: `{ sosId, journeyId, lat, lng, accuracyM, batteryPct, network, recordedAt }`),
  `changed` (reload `GET /g/l/:code`), `ended` (the link does not work).
- Responses carry `X-Robots-Tag: noindex` and `Cache-Control: no-store`; 120 calls per minute per address.

## SMS delivery reports (Part B)

`POST /v1/webhooks/sms/main` (or `/backup`), header `x-webhook-secret: <SMS_WEBHOOK_SECRET>`, body
`{ messageId, status: "delivered" | "failed", error? }` → `204`. Marks the alert delivered or failed. Each real
provider gets a small adapter for its own report format when it is added.

