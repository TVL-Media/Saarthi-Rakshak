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
- Node.js 24 LTS (24.9 or newer) and pnpm 12
- Docker Desktop (runs PostgreSQL + PostGIS and Redis locally)
- Later: Flutter SDK and Android Studio (for the mobile app)

## Local setup

Local PostgreSQL (with PostGIS) and Redis run in Docker. Commands below are for PowerShell on Windows,
run from the project folder.

1. Install and open **Docker Desktop** (wait until it says "Engine running").
2. Create your settings file (first time only), and change the password if you like:
   ```powershell
   copy .env.example .env
   ```
3. **Start** the services:
   ```powershell
   docker compose up -d
   ```
4. **Check** they are running — both should show `healthy`:
   ```powershell
   docker compose ps
   docker compose exec postgres psql -U sarthi -d sarthi_dev -c "SELECT postgis_version();"
   docker compose exec redis redis-cli ping
   ```
5. **Stop** them (your data is kept):
   ```powershell
   docker compose stop
   ```
6. **See logs** if something is wrong:
   ```powershell
   docker compose logs -f postgres
   ```

**Ports:** PostgreSQL is on **5433** (not the usual 5432), so it does not clash with a PostgreSQL installed
directly on Windows. Redis is on 6379. Both are only reachable from your own computer.

**Two databases:** `sarthi_dev` for your local work and `sarthi_test` for automated tests only.
Both are created automatically the **first** time PostgreSQL starts.

**Reset everything** (deletes all local data, and re-runs the first-time setup):
```powershell
docker compose down -v
docker compose up -d
```
If you change `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` or `POSTGRES_TEST_DB` in `.env`,
you must reset like this for the change to take effect.

### Server

Needs **Node.js 24.9 or newer** (Node 24 LTS) and **pnpm 12** (`corepack enable` sets up the right pnpm).

1. Install packages (first time, and after pulling new changes):
   ```powershell
   pnpm install
   ```
2. **Start** the server (restarts automatically when you change code):
   ```powershell
   pnpm dev
   ```
3. **Open** http://localhost:3000/health in your browser, or:
   ```powershell
   curl.exe http://localhost:3000/health
   ```
   - `{"status":"ok", ...}` means PostgreSQL and Redis are both reachable.
   - A **503** shows which one is `down`. Start it with `docker compose up -d`.

If a setting is missing, the server stops at once and lists what to fix.

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs all tests. They use only `sarthi_test` and Redis slot `/1`, never your dev data |
| `pnpm lint` | Checks the code for mistakes |
| `pnpm format` | Formats the code (`pnpm format:check` only checks) |
| `pnpm build` | Builds the server into `server/dist` |

Tests need Docker running (`docker compose up -d`).
