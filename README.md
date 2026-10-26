# Sarthi Rakshak

**हर सफर में, एक रक्षक — In every journey, a guardian.**

A personal safety app. Phase 1 is a reliable SOS and safe-journey app for Android, piloted in Noida.

## What's in this repository

| Folder | What it is | Status |
| --- | --- | --- |
| `server/` | Node.js (NestJS) backend: API, live updates, background worker | Starting |
| `apps/admin/` | React admin panel for the client's team | Starting (built first) |
| `apps/guardian-web/` | Guardian live-map page (opens from SMS, no app needed) | Later |
| `apps/mobile/` | Flutter Android app | Later |
| `packages/shared/` | Shared TypeScript types and API contract | Starting |
| `docs/` | Plans, decisions and specs | Ready |

## Start here

1. Read [`CLAUDE.md`](CLAUDE.md) — the project summary, tech stack and rules.
2. Read [`docs/phase-1-overview.md`](docs/phase-1-overview.md) — what Phase 1 builds.
3. Read [`docs/admin-panel.md`](docs/admin-panel.md) — the admin panel spec and build order.

## Tools to install

- Git
- Node.js (LTS) and pnpm
- Docker Desktop (runs PostgreSQL + PostGIS and Redis locally)
- Later: Flutter SDK and Android Studio (for the mobile app)

## Local setup

_To be added in build step 1 (Docker Compose for PostgreSQL + Redis) and step 2 (server skeleton)._
