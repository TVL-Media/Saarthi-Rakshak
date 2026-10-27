# Sarthi Rakshak — Phase 1 Overview

Phase 1 is a reliable SOS and safe-journey app for Android, piloted in Noida.
Its one promise: when someone presses SOS, the right people know where they are, every time.

## At a glance

| Question | Answer |
| --- | --- |
| Who is it for | Anyone travelling who feels unsafe, for example a late-night cab ride home |
| Platform | Android first (iPhone later) |
| Pilot city | Noida |
| Who responds in an emergency | Guardians (family and friends) and 112. No 24/7 command centre in Phase 1 |
| Guardians need the app? | No. They get an SMS with a live map link that opens in any browser |

In-app text: "Sarthi Rakshak alerts your guardians and helps you call 112. It is not a 24/7 monitoring service."

## What we are building

### User app (Android)

| Area | Feature | What it does |
| --- | --- | --- |
| Setup | Login | Phone number + OTP |
| Setup | Profile | Name, photo, optional medical info (blood group) shown to guardians in an SOS |
| Setup | Guardians | Up to 5 people from contacts; SMS invite with a decline option |
| Setup | Safety setup check | Turns on permissions; guides the user to stop the phone killing the app |
| Setup | Test SOS | A practice alert marked TEST |
| SOS | SOS button | Big button, home-screen widget and quick-settings tile |
| SOS | Countdown | 5 seconds, cancel without a PIN |
| SOS | Alerts to guardians | Push + SMS; no internet → SMS from the user's own SIM |
| SOS | Live location | Every 3–5 seconds, slower when battery is low |
| SOS | Audio recording | 30-second clips, encrypted, auto-deleted after 30 days unless kept |
| SOS | Call 112 | One tap |
| SOS | No-response backup | No guardian responds in 5 min → alerts sent again, app helps call 112 |
| SOS | End SOS | "I'm safe" → guardians told, link stays live 15 more minutes |
| Journey | Journey mode | Destination, arrival time, live sharing, "I reached safely" |
| Journey | Smart check-ins | Only when off route (500 m+), stopped 3+ min, or 15 min late. Buttons: I'm fine / Stuck in traffic (10 min) / SOS. No reply in 2 min → alert guardians (not a full SOS) |
| Journey | Lost contact | Phone silent about 5 min → server alerts guardians |
| Extras | History | Past journeys and SOS events |

### Guardian live page (web, no app needed)

Opens from the SMS link: live map, battery level, last update time, blood group.
Buttons: "I'm responding", "Call", "Call 112". The link expires after the event.

### Admin panel (web)

See [`admin-panel.md`](admin-panel.md).

## How the SOS works

1. **SOS pressed:** button, widget or quick tile → 5-second countdown with Cancel.
2. **Phone starts protecting:** saves the SOS on the phone first, shares location every 3–5 s, starts audio recording.
3. **No internet?** Phone sends SMS from its own SIM to every guardian with a map link, and keeps trying the server.
4. **Server saves the SOS** and makes a secret live-map link for each guardian.
5. **Alerts go out together:** push + SMS. If the main SMS provider fails, the backup sends it.
6. **Guardians open the live map** and tap "I'm responding"; the user and other guardians see who is coming.
7. **Safety timers on the server:**
   - No guardian responds in 5 min → alerts sent again, app helps the user call 112
   - Phone silent for 5 min → "Lost contact" alert with last location
8. **User taps "I'm safe":** everyone is told, the link expires after 15 minutes, the full timeline is saved.

## Architecture

```
 User app (Android)        Guardian live page        Admin panel
 Flutter + Kotlin           React, from SMS link      React, client team
        │                          │                        │
        └─────────── HTTPS / live updates (WebSocket) ──────┘
                                   ▼
 ┌──────────────── DigitalOcean · Bangalore, India ────────────────┐
 │      Node.js server (NestJS): API + live updates, 2 servers     │
 │                                │                                │
 │   Worker          PostgreSQL        Redis            Spaces     │
 │   push, SMS,      + PostGIS         live location,   audio,     │
 │   retries,        permanent         timers,          encrypted  │
 │   timers          record            job queue                   │
 └──────┼──────────────────────────────────────────────────────────┘
        ├──► Firebase (push, login OTP, crash reports)
        └──► SMS providers (main + backup, DLT) ──► Guardians
 Google Maps draws the maps in the app, guardian page and admin panel.
```

### Main parts

| Part | Job |
| --- | --- |
| User app — Flutter | All screens |
| User app — Kotlin "safety engine" | Foreground service, location, audio recording, SIM SMS, check-in detector, heartbeat, widget + tile. Works even if Flutter screens are closed |
| On-phone storage | SQLite offline queue; encrypted files (Android Keystore); WorkManager retries uploads |
| API server | Login, users & guardians, SOS, journeys, location intake, guardian links, admin, audit |
| WebSocket | Pushes live location to guardian page and admin panel (Socket.IO + Redis adapter) |
| Worker | BullMQ jobs: send push/SMS, provider failover, retries, timers (check-in timeout, lost contact, no-response), cleanup |
| PostgreSQL + PostGIS | users, devices, guardians, journeys, sos_events, location_points, checkins, alerts, guardian_links, media_clips, admins, audit_log, settings, support_tickets |
| Redis | Latest location per user, heartbeat keys with expiry, BullMQ queues, pub/sub between servers |
| Spaces | Audio clips; the app uploads directly with short-lived upload links |

### Design rules

1. **Phone manages alone in an emergency** (SIM SMS when offline).
2. **Server watches the clock, not the phone** (timers survive a dead or stolen phone).
3. **Every alert is tracked** (sent / delivered / failed, with retries and provider failover).
4. **Offline-first:** each SOS gets an ID made on the phone, so retries never create duplicates.
5. **All data in India.** Firebase holds only the phone number for login.

### Background running (Android)

- The safety engine is an Android **foreground service** with a fixed notification ("Sarthi Rakshak is protecting you"), started by a user tap (SOS, journey).
- Uses **"while using the app"** location only in Phase 1 (easier Play approval). "All the time" is optional in Phase 2.
- Adaptive location: moving every 5–10 s, stopped less often, SOS every 3–5 s, slower on low battery.
- Heartbeat every 30–60 s; server raises "lost contact" if it stops.
- Test on 8–10 real phones (Xiaomi, Samsung, Vivo, Oppo, Realme, OnePlus, Motorola): screen-off journey, swiped away, battery saver, no network, restart.

## Tech stack

| Part | Tool | Why |
| --- | --- | --- |
| App screens | Flutter | One codebase for screens; reusable for iPhone later |
| Safety engine | Kotlin (native Android) | Background tracking, SIM SMS, tile/widget need native code to be reliable |
| Server | Node.js (TypeScript, NestJS) | Common, fast to build, easy to hire for |
| Guardian page, admin panel | React | One web stack for both |
| Database | PostgreSQL + PostGIS | Reliable for linked data; location maths ("500 m off route") |
| Live data, timers | Redis + BullMQ | "Where is she now" and timers like "no reply in 2 min" |
| Audio storage | DigitalOcean Spaces | Encrypted storage in India |
| Hosting | DigitalOcean, Bangalore | Keeps data in India |
| Push, crash reports, login OTP | Firebase | Standard on Android |
| SMS | Indian provider + backup (e.g. MSG91, Gupshup) | Handles DLT rules; backup if main fails |
| Maps | Google Maps | Best accuracy in Noida |
| Code and releases | GitHub + GitHub Actions | Automatic tests and deployment |

**Kotlin and iPhone:** the app is mostly Flutter. Only the small safety engine is Kotlin. iPhone needs its own native code (Swift) for this part anyway, so the screens stay shared and only the engine is built once per platform.

## Privacy and security

| Area | How |
| --- | --- |
| Data location | DigitalOcean Bangalore (Firebase holds only the phone number) |
| In transit | HTTPS everywhere |
| At rest | Database encrypted; audio encrypted on the phone and in storage |
| Audio | Only the user can play it. Export only for an official police/court request, logged |
| Guardian links | Long random code, stored hashed, expires, rate-limited, hidden from search engines |
| Admin | 2-step login, two roles, every view and action logged |
| Misuse | Limits on OTP requests, guardian invites and SMS per user |
| User rights | Consent screens, "delete my account" (DPDP basics) |

## Reliability and hosting

- Two API servers behind a load balancer.
- Managed PostgreSQL with a standby copy, daily backups, point-in-time restore.
- Managed Redis.
- Two SMS providers with automatic switch-over.
- Uptime checks every minute; Sentry for server errors; Crashlytics for app crashes.
- Environments: development, staging, production.

## Before we start (Phase 0)

| Task | Who |
| --- | --- |
| DLT registration (company, sender name, ~10 SMS templates, link domain) | Client documents; TVL fills forms |
| Short-link domain for guardian links | Client |
| Google Play Console organisation account | Client |
| DigitalOcean, Firebase, Google Maps accounts | Client accounts; TVL sets up |
| SMS providers (main + backup) | TVL picks; client buys credits |
| Privacy policy and terms | TVL drafts; client's lawyer approves |
| 8–10 real test phones | TVL |

## Not in Phase 1

See [`later-phases.md`](later-phases.md).
