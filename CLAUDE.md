# CLAUDE.md — Sarthi Rakshak

Project memory for Claude Code. Read this first in every session, then the relevant file in `docs/`.

## What this project is

**Sarthi Rakshak** ("हर सफर में, एक रक्षक" — In every journey, a guardian) is a personal safety app.
TVL Media is building it for a client.

**Phase 1 (current):** a reliable SOS and safe-journey app for **Android**, piloted in **Noida**.
When someone presses SOS, their guardians (family/friends) know where they are, every time.

- Responders in Phase 1 are **guardians and 112 only**. There is **no 24/7 command centre** in Phase 1.
- Guardians **do not need the app** — they get an SMS with a live-map web link.
- Full Phase 1 scope: `docs/phase-1-overview.md`. Later phases: `docs/later-phases.md`.

## Current focus

**Admin panel first** (with the backend it needs). Build order: `docs/admin-panel.md` → "Build order".
**No fake data in the admin panel.** Do not build a simulator or seed sample users, SOS events or alerts into the
development or staging database. Screens must show clear empty states until real data arrives from the user app.
The only data created by setup is real configuration: the first Super Admin account and the default safety settings.
Automated tests may create temporary records in a separate test database that is wiped after each run.

## Tech stack (decided — do not change without asking)

| Part | Tool |
| --- | --- |
| Mobile app | Flutter (screens) + Kotlin (native Android "safety engine") — later |
| Server | Node.js 24 LTS (≥ 24.9) + TypeScript 6.0, NestJS 12 |
| Admin panel | React + TypeScript, Vite, Ant Design, React Router, TanStack Query, Socket.IO client, Recharts, React Hook Form + Zod |
| Guardian live page | React + TypeScript, very light (no Ant Design) — later |
| Database | PostgreSQL + PostGIS |
| Live data, timers, job queue | Redis + BullMQ |
| File storage (audio) | DigitalOcean Spaces |
| Hosting | DigitalOcean, Bangalore region (data must stay in India) |
| Push, login OTP, crash reports | Firebase |
| SMS | Indian provider (main + backup), DLT registered |
| Maps | Google Maps |
| Package manager | pnpm (workspaces) |
| Local services | Docker Compose (PostgreSQL + PostGIS, Redis, SeaweedFS for files — stands in for Spaces) |
| Tests | Jest/Vitest for units, Playwright for admin panel screens |

## Repository layout

```
server/              NestJS backend (API, WebSocket, worker)
apps/admin/          React admin panel
apps/guardian-web/   Guardian live-map page (later)
apps/mobile/         Flutter app (later)
packages/shared/     API contract for the user app (Zod schemas + types); written out for Flutter in docs/app-api.md
docs/                Plans, decisions, specs
docker-compose.yml   Local PostgreSQL + Redis + SeaweedFS (file storage)
```

## Rules that must never be broken

1. **Data stays in India.** No service outside the agreed list stores user data.
2. **Admins can never play or download audio.** Audio export only via a Super Admin action with a written reason (police/court request), always logged.
3. **Every admin view and action is written to the audit log.**
4. **Roles are checked on the server**, never only by hiding buttons in the UI.
5. **Admins cannot cancel, edit or delete SOS records.** SOS history is read-only.
6. **Live location is shown to admins only during an active SOS.** Journeys appear as counts, not names.
7. **Phone numbers are partly masked** in the admin panel (e.g. `+91 98•• ••4521`).
8. **No secrets in code.** Use `.env` (never committed); keep `.env.example` up to date.
9. **Never present Phase 1 as 24/7 monitoring.** In-app text: "Sarthi Rakshak alerts your guardians and helps you call 112. It is not a 24/7 monitoring service."

## UI design (admin panel)

- **The design is `docs/design/admin-panel.html`** (open it in a browser) with exact values in `docs/admin-design.md`.
  No Figma. Do not invent screens, layouts or styles that are not in the design.
- Build **one screen at a time**; follow the yellow note on each screen (route, rules, error text).
- Build with **Ant Design** components and the theme in `docs/admin-design.md` (one theme file, reused everywhere).
- If a screen or state is missing from the design, **ask** before building it.
- The older mockup (https://claude.ai/artifact/S2JFHZLFaiwZVTFjpaJTXc) is replaced by this design.

## Phase 1 safety rules (configurable in Settings)

| Rule | Default |
| --- | --- |
| SOS countdown | 5 seconds, cancel without PIN |
| Check-in: stopped too long | 3 minutes |
| Check-in: off route | 500 m |
| Check-in: late arrival | 15 minutes |
| Wait for check-in reply | 2 minutes, then alert guardians (not a full SOS) |
| "Stuck in traffic" pause | 10 minutes |
| Lost contact (phone silent) | 5 minutes |
| No guardian responds to SOS | 5 minutes → re-send alerts + help user call 112 |
| Guardian link after SOS ends | stays live 15 minutes |
| Audio auto-delete | 30 days unless the user keeps it |
| Max guardians | 5 |

## Excluded for now (do not build)

Auto-call to guardians · silent alert · fake call · Hindi language · WhatsApp alerts (only if the client approves a Change Request).

## How to work in this repo

- **Plan before code:** for any step, write a short plan first and wait for approval.
- **Small steps:** one feature per task; keep each change easy to review.
- **Run it and test it** before calling a step done; add tests for new logic.
- **Commit after each working step** with a clear message; one branch per feature.
- **Keep it simple:** no extra libraries or patterns unless the step needs them.
- **Update this file and `docs/decisions.md`** when a decision changes.
- Never stop or kill a process you did not start yourself. If a port is busy, ask.
- The project owner prefers **simple, plain language** in explanations.

<!-- planfirst:start -->
## Phase 1 plan (non-admin work)
Full plan: `./docs/phase-1-plan.md` — read before building the app server, alerts, guardian page, mobile app or hosting.
**Local development only for now:** no hosting, CI or DigitalOcean until Track F in the plan is approved.

### Stack (moment: validate — Noida pilot)
- App API + worker: NestJS (same codebase, user-app code under `server/src/app/`), BullMQ on Redis
- Login: Firebase phone OTP, then our own hashed session token
- Alerts: SMS main + backup behind one adapter; FCM push to the user's phone; SIM SMS offline
- Guardian page: Vite + React, no Ant Design
- Mobile: Flutter screens + Kotlin foreground-service safety engine

### Agent Rules
- DO NOT edit admin-owned code (apps/admin, server/src/admins, auth, audit, settings, users, history) without asking.
- DO pull main before adding a migration; take the next free number; never edit a merged migration.
- DO make SOS, location and check-in writes idempotent using the id made on the phone.
- DO read safety rules from the snapshot on the SOS/journey inside timers, never live from settings.
- DO NOT send real SMS from development; the log provider is refused in production.
- DO NOT add Kafka, GraphQL, Kubernetes, microservices or a third-party realtime service.
- DO NOT set up hosting, CI, cloud resources or internet tunnels now; keep everything runnable with `docker compose up -d` + `pnpm dev`, with every address in `.env`.
- DO run `pnpm lint` and `pnpm test` before every push (no CI yet).
<!-- planfirst:end -->
