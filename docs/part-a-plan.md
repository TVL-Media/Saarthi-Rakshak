# Part A — Server for the app

> Part of [`phase-1-plan.md`](phase-1-plan.md). Owner: Parmeet. Status: **waiting for approval**.
> Everything runs locally (Docker + `pnpm dev`). Each step: plan → approve → build → test → commit, one branch per step.

## What Part A gives

The server API that the Android app uses: login, profile, phone details, guardians, SOS, live location,
journeys, check-ins, history, delete account and support tickets.

Not in Part A: sending SMS and push (Part B), timers (Part B), the guardian web page (Part C), the app itself (Part D).
Until Part B exists, every message the server would send (invite, SOS alert) is **printed in the server console**.

## Steps

| Step | Name | Size |
| --- | --- | --- |
| A00 | Local setup | S |
| A0 | API contract | S |
| A1 | Login | M |
| A2 | Profile and phone details | S |
| A3 | Guardians and invites | M |
| A4 | SOS | M |
| A5 | Live location and heartbeat | M |
| A6 | Journeys and check-ins | M |
| A7 | History, delete account, support | S |

Order: A00 → A0 → A1 → A2 → A3 → A4 → A5 → A6 → A7. Each step needs the one before it.

## Decisions to confirm before starting

| # | Question | Suggested answer |
| --- | --- | --- |
| 1 | Who gets an SOS alert: only guardians who accepted the invite, or also those who haven't answered yet? | Accepted **and** not-yet-answered (in an emergency more people is better); never declined ones |
| 2 | How long does a user stay logged in? | 90 days, extended every time the app is used; ends on logout, delete account or a new login on another phone |
| 3 | Can the user have more than one phone logged in? | No — one phone at a time. A new login ends the old session |

## Rules for all of Part A

- All new code goes in `server/src/app/` (one folder per step). Do not edit admin code (`admins`, `auth`, `audit`, `settings`, `users`, `history`).
- App routes start with `/app`. Every `/app` route needs a login unless it is marked public.
- The app sends its login token in the `Authorization: Bearer <token>` header (no cookies).
- Every request body is checked with Zod. Bad input → `400` with a clear message.
- Anything the phone creates (SOS, journey, check-in, location point) carries an id made on the phone. Sending it twice never creates two records.
- A **blocked** user cannot log in, start a journey or invite guardians. A blocked user who is already logged in **can always raise an SOS**.
- Phone numbers: store full (E.164, e.g. `+919812344521`); never write them in logs. Use `normaliseIndianMobile` from `server/src/users/phone.ts`.
- Safety rules (countdown, check-in limits, etc.) are copied onto each SOS and journey when it starts. Later code reads the copy, never the live setting.
- No fake data in the dev database. Tests use `sarthi_test` only.
- New migrations start at `0010`. Pull `main` first; if the number is taken, use the next one.

---

## A00 — Local setup

**Goal:** a phone can reach the server on the laptop, and the server has what Part A needs.

**Build**
- Add **MinIO** to `docker-compose.yml` (port 9000, console 9001) for photos and audio. It creates bucket `sarthi-dev` on start. (Shared file — tell Anjali.)
- New settings in `.env.example` and `env.schema.ts`:

  | Setting | Example | Used for |
  | --- | --- | --- |
  | `FIREBASE_PROJECT_ID` | `sarthi-rakshak-dev` | Checking login |
  | `GOOGLE_APPLICATION_CREDENTIALS` | `C:\keys\firebase-dev.json` | Firebase key file (outside the project, never committed) |
  | `PHONE_HASH_KEY` | 32 random bytes, base64 | Hashing declined guardian numbers |
  | `S3_ENDPOINT` | `http://localhost:9000` | MinIO now, Spaces later |
  | `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `sarthi-dev` / … | Storage |
  | `GUARDIAN_WEB_URL` | `http://localhost:5175` | Links in invite and SOS messages |

- Packages: `firebase-admin`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
- Firebase dev project: turn on Phone sign-in, add 3–5 **test phone numbers** with fixed OTP codes (no real SMS).
- `SETUP.md`: new section "Connect a phone" — USB (`adb reverse tcp:3000 tcp:3000`), emulator (`10.0.2.2:3000`), Wi-Fi (laptop IP + Windows firewall rule).

**Done when**
- `docker compose up -d` starts PostgreSQL, Redis and MinIO.
- The server starts with the new settings and stops with a clear message if one is missing.
- A phone on USB opens `http://localhost:3000/health` and sees `ok`.

---

## A0 — API contract

**Goal:** one written list of every `/app` call, so the server and the app are built to the same shapes.

**Build**
- Make `packages/shared` a real package (add to `pnpm-workspace.yaml`).
- `packages/shared/src/app-api.ts`: Zod schemas for every request and reply in this plan. The server uses them to check input.
- `docs/app-api.md`: the same list in plain words for the Flutter app (Dart can't read TypeScript): address, method, request fields, reply fields, error codes.
- One error reply shape for everything: `{ "error": "code_name", "message": "Plain text" }`.

**Done when**
- Server and admin build with the shared package.
- `docs/app-api.md` lists every call from A1–A7.

---

## A1 — Login

**Goal:** a user logs in with phone + OTP and gets a token for all other calls.

**How it works**
1. The app does the OTP with Firebase and gets a Firebase ID token.
2. The app sends it to our server.
3. The server checks it with Firebase, reads the phone number, finds or creates the user, and returns our own token.

**Database (migration 0010)**

New table `user_sessions`:

| Column | Notes |
| --- | --- |
| `id` | uuid |
| `user_id` | → users |
| `device_id` | → devices (filled in A2) |
| `token_hash` | SHA-256 of the token; the token itself is never stored |
| `created_at`, `last_seen_at`, `expires_at` | 90 days, pushed forward on use |
| `ended_at`, `end_reason` | `logout`, `new_login`, `blocked_login`, `account_deleted` |

**API**

| Call | Login needed | What it does |
| --- | --- | --- |
| `POST /app/auth/login` `{ firebaseIdToken }` | No | Returns `{ token, user, isNewUser }` |
| `POST /app/auth/logout` | Yes | Ends this session |
| `GET /app/me` | Yes | Returns the user: id, name, own phone number, blood group, consent given, guardians count |
| `POST /app/me/consent` `{ version }` | Yes | Saves `consent_at`. Until then only `/app/me`, `/app/me/consent` and logout work |

**Rules**
- Blocked user → `403 account_blocked` at login.
- New login ends any other open session for that user.
- Max 10 login attempts per IP per 15 minutes (Redis).
- Firebase check is behind one small class, so tests can use a fake checker (only when `NODE_ENV=test`).

**Tests**
- New user, returning user, blocked user, bad token, expired session, logout, second phone logs out the first, consent gate.

**Done when:** login works from a real phone with a Firebase test number, and all tests pass.

---

## A2 — Profile and phone details

**Goal:** the user fills in their profile, and the server knows the phone's setup (for the admin "Setup complete" check).

**API**

| Call | What it does |
| --- | --- |
| `GET /app/profile` | Name, photo address, blood group |
| `PATCH /app/profile` `{ name?, bloodGroup? }` | Name 1–60 characters; blood group one of `A+ A- B+ B- AB+ AB- O+ O-` or empty |
| `POST /app/profile/photo-upload` | Returns a 5-minute upload link (JPEG, max 2 MB) |
| `POST /app/profile/photo` `{ key }` | Saves the uploaded photo; deletes the old one |
| `PUT /app/device` `{ deviceId, model, androidVersion, appVersion, pushToken, permissions, batteryOptimisationOff }` | Creates or updates this phone; links it to the session |

`permissions` uses exactly these keys (the admin panel reads them): `location`, `notifications`, `sms`, `microphone` — each `true`/`false`.

**Rules**
- `deviceId` is made by the app once per install.
- `users.last_seen_at` and `devices.last_seen_at` are updated at most once a minute.

**Tests:** profile changes, wrong blood group, photo upload flow with MinIO, device update, permission keys.

**Done when:** after setting up a real phone, the admin Users screen shows its device and setup status.

---

## A3 — Guardians and invites

**Goal:** the user adds up to 5 guardians; each gets an invite they can accept or decline.

**Database (migration 0011)**
- `guardians`: add `invite_token_hash`, `invite_expires_at`.
- New table `guardian_invite_blocklist` (`user_id`, `phone_hash`, `created_at`): numbers that declined, stored only as a hash. Unique on (`user_id`, `phone_hash`).
- `alerts.type`: add `invite`.

**API (user)**

| Call | What it does |
| --- | --- |
| `GET /app/guardians` | List: name, relation, masked phone, status (`pending` / `accepted` / `declined`) |
| `POST /app/guardians` `{ name, phone, relation? }` | Adds a guardian and sends the invite |
| `POST /app/guardians/:id/resend` | Sends the invite again (pending only) |
| `DELETE /app/guardians/:id` | Removes a guardian |

**API (guardian, no login — used by the invite page in Part C)**

| Call | What it does |
| --- | --- |
| `GET /g/invite/:code` | Shows who invited them (user's first name only) |
| `POST /g/invite/:code/accept` | Status → accepted |
| `POST /g/invite/:code/decline` | Status → declined; phone removed; number added to the blocklist |

**Rules**
- Max guardians = setting `guardian.max_count` (5). Users who already have more keep them but can't add.
- Refused: own number, same number twice, a number on the blocklist (reply is the same general "can't invite this number"), blocked user.
- Invite link: random code, only its hash stored, valid 7 days.
- Max 10 invites (including resends) per user per day.
- Can't remove a guardian while an SOS is active.
- Invite message is printed in the console until Part B (with the link to `GUARDIAN_WEB_URL/invite/<code>`).

**Tests:** limit of 5, duplicates, own number, accept, decline removes phone, blocklist, expired link, daily limit, blocked user.

**Done when:** add guardian on the phone → link appears in the console → accept with the link → status shows accepted in the app and admin panel.

---

## A4 — SOS

**Goal:** the server records an SOS, prepares a secret live link for each guardian, and ends it when the user is safe.

**Database (migration 0012)**
- `sos_events`: add `rules` (copy of safety settings at start).

**API**

| Call | What it does |
| --- | --- |
| `POST /app/sos` `{ id, trigger, isTest, startedAt, journeyId?, location? }` | Saves the SOS (same `id` again → returns the existing one). Creates one guardian link per guardian. Returns the SOS and guardian list |
| `POST /app/sos/:id/end` `{ reason: "safe" }` | Status → ended. Guardian links stay open for `guardian.link_live_after_end_minutes` (15) more |
| `POST /app/sos/cancelled` `{ id, trigger, isTest, startedAt, cancelledAt }` | Reports an SOS cancelled during the 5-second countdown (no alerts; counts as a false alarm in reports) |
| `GET /app/sos/active` | The current SOS, if any, with each guardian's status (alerted / opened / responding) |

`trigger` is one of `button`, `widget`, `tile`, `checkin`, `journey`.

**Rules**
- Works for blocked users.
- Only one active SOS per user. A second one while active → returns the active one.
- `startedAt` is the phone's time (it may arrive late after being offline); refused if more than 1 minute in the future.
- Guardian link: long random code, only its hash stored, expires when the SOS ends + 15 minutes.
- Test SOS: same flow, marked `isTest`; message text says TEST.
- Until Part B, the SOS message for each guardian (with its link) is printed in the console.
- SOS records can't be deleted or have their core facts changed (database already blocks this).

**Tests:** create, same id twice, second SOS while active, end, cancelled report, test SOS, blocked user can SOS, future start time, links expire after end.

**Done when:** an SOS from a real phone shows in the admin History screen, the console shows a link per guardian, and "I'm safe" ends it.

---

## A5 — Live location and heartbeat

**Goal:** the phone sends its location during an SOS or journey; the server keeps the latest point ready for the live page.

**Database (migration 0013)**
- `location_points`: add `client_point_id` (uuid from the phone), unique per user — so resent points are ignored.

**API**

| Call | What it does |
| --- | --- |
| `POST /app/locations` `{ points: [...] }` | 1–50 points. Each: `clientPointId`, `sosId` or `journeyId`, `lat`, `lng`, `accuracyM`, `batteryPct`, `network`, `recordedAt` |
| `POST /app/heartbeat` `{ batteryPct, network, sosId?, journeyId? }` | "Phone is alive" signal, every 30–60 seconds |

**What the server does with each point**
1. Saves it to `location_points`.
2. Saves the newest point in Redis (`loc:last:sos:<id>` or `loc:last:journey:<id>`).
3. Publishes it on Redis channel `sos:<id>:location` (Anjali's Live SOS screen and the guardian page listen to this).

**Rules**
- Points are accepted only for the user's own SOS/journey that is active or ended less than 2 minutes ago.
- Latitude −90…90, longitude −180…180, battery 0–100, `recordedAt` not more than 1 minute in the future.
- Heartbeat writes the time into Redis sorted set `heartbeats` (Part B uses it for "lost contact").
- `delete_after` stays empty until the client decides how long to keep locations.

**Tests:** batch save, resent points ignored, someone else's SOS refused, ended SOS after 2 min refused, Redis latest point, published message, heartbeat. Speed check (test database only): 50 phones × 1 point every 3 seconds stays under 100 ms per call.

**Done when:** during an SOS from a real phone, points appear in the database and the newest point in Redis.

---

## A6 — Journeys and check-ins

**Goal:** the user shares a trip; the server records it and stores check-ins and their answers.

**Database (migration 0014)**
- `journeys`: add `rules` (copy of settings), `route` (line on the map, optional).
- `checkins`: add `source` (`phone` / `server`), `paused_until`.

**API**

| Call | What it does |
| --- | --- |
| `POST /app/journeys` `{ id, destination: { lat, lng, label }, expectedArrivalAt, route? }` | Starts a journey (same `id` again → returns the existing one) |
| `POST /app/journeys/:id/arrived` | "I reached safely" → status arrived; guardians told (Part B) |
| `POST /app/journeys/:id/end` | Ends without arriving |
| `GET /app/journeys/active` | The current journey with any open check-in |
| `POST /app/journeys/:id/checkins` `{ id, reason }` | Phone found a problem: `off_route` or `stopped` |
| `POST /app/checkins/:id/answer` `{ answer }` | `fine`, `traffic` (pauses check-ins for 10 min) or `sos` |

**Rules**
- Blocked users can't start a journey. One active journey per user.
- `expectedArrivalAt` must be in the future and within 24 hours.
- Answer `sos`: the check-in is marked `sos`; the app then sends `POST /app/sos` with `trigger: "checkin"`.
- While paused (`traffic`), new check-ins are refused until `paused_until`.
- "Late" check-ins and "no reply" are made by the server timers in Part B.

**Tests:** start, same id twice, second active journey, blocked user, arrived, end, each answer, traffic pause, check-in on someone else's journey refused.

**Done when:** a journey from a real phone shows in admin History (as "A user's journey"), and a check-in answer is saved.

---

## A7 — History, delete account, support

**Goal:** the user sees their past events, can delete their account, and can report a problem.

**API**

| Call | What it does |
| --- | --- |
| `GET /app/history?before=<date>` | User's own SOS events and journeys, newest first, 20 at a time |
| `GET /app/history/sos/:id` | One SOS: start, guardians alerted / responding, end |
| `GET /app/history/journeys/:id` | One journey: start, check-ins and answers, end |
| `DELETE /app/account` | Deletes the account (uses the existing `deleteUserData`), deletes photo and audio files from storage, ends all sessions |
| `POST /app/support` `{ category, message }` | Category: `otp`, `guardian_sms`, `app_stopped`, `other`; message 10–2000 characters. Shows in admin Support Tickets |

**Rules**
- Delete account is refused while an SOS or journey is active.
- After delete: SOS events and alerts stay, with no link to the person (existing rule).
- Max 5 support messages per user per day.

**Tests:** history paging, only own events, delete refused while active, delete removes data and files, support limits.

**Done when:** a real user can see history, send a support message (visible in the admin panel), and delete their account.

---

## Database changes in Part A (summary)

| Migration | Change |
| --- | --- |
| 0010 | New `user_sessions` |
| 0011 | `guardians.invite_token_hash`, `invite_expires_at`; new `guardian_invite_blocklist`; `alerts.type` + `invite` |
| 0012 | `sos_events.rules` |
| 0013 | `location_points.client_point_id` (unique per user) |
| 0014 | `journeys.rules`, `journeys.route`; `checkins.source`, `checkins.paused_until` |

## Tell Anjali (shared parts)

- A00: MinIO added to `docker-compose.yml`; new `.env` settings.
- A1: new `user_sessions` table; `/app` routes have their own login check (admin checks untouched).
- A2: phones now report `permissions` with keys `location`, `notifications`, `sms`, `microphone`.
- A5: live points on Redis channel `sos:<id>:location` — ready for her Live SOS screen.
- Every new migration number before merging.
