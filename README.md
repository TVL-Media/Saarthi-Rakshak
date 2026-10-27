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

## Run it on your computer

**New to the project? Follow [`SETUP.md`](SETUP.md)** — step-by-step for Windows, with fixes for common problems.

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
2. **Start** the server and the admin panel together (both restart when you change code):
   ```powershell
   pnpm dev
   ```
   - Admin panel: **http://localhost:5173** (log in with the Super Admin from `pnpm app:setup`).
   - Server: http://localhost:3000. If port 3000 or 5173 is already in use, it stops with an error;
     close whatever is using the port (the panel must run on 5173: the server only accepts that address).
   - Use Chrome, Edge or Firefox locally. The login cookie is `Secure`; those browsers allow it on
     `http://localhost`. On the real server everything is HTTPS.
3. **Check the server** at http://localhost:3000/health, or:
   ```powershell
   curl.exe http://localhost:3000/health
   ```
   - `{"status":"ok", ...}` means PostgreSQL and Redis are both reachable.
   - A **503** shows which one is `down`. Start it with `docker compose up -d`.

If a setting is missing, the server stops at once and lists what to fix.

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs all tests: server tests, then the admin panel's browser tests. They use only `sarthi_test` and Redis slot `/1`, never your dev data |
| `pnpm lint` | Checks the code for mistakes |
| `pnpm format` | Formats the code (`pnpm format:check` only checks) |
| `pnpm build` | Builds the server (`server/dist`) and the panel (`apps/admin/dist`) |

Tests need Docker running (`docker compose up -d`). The browser tests need Chromium once:
`pnpm --filter admin exec playwright install chromium`. They start their own server and panel on
ports **3100** and **5174**, so they can run while `pnpm dev` is running.

### Database tables (migrations)

Tables are created by numbered migration files in `server/src/database/migrations/`.

| Command | What it does |
| --- | --- |
| `pnpm db:migrate` | Creates or updates the tables in `sarthi_dev`. Run this after first setup and after pulling changes |
| `pnpm db:status` | Shows which migrations have run (`done`) and which have not (`pending`) |
| `pnpm db:rollback` | Undoes the last migration in `sarthi_dev` |
| `pnpm db:migrate:test` | Same as `db:migrate`, for `sarthi_test` (tests also do this themselves) |

To see the tables: `docker compose exec postgres psql -U sarthi -d sarthi_dev -c "\dt"`

### First-time setup: default settings and the first Super Admin

Run once, after `pnpm db:migrate`:

```powershell
pnpm app:setup --name "Your Name" --email "you@tvlmedia.in"
```

- Adds the default safety settings (any that are missing; never overwrites a changed value).
- Creates the **first Super Admin** and prints a **temporary password once**. Copy it straight away:
  it is not saved anywhere. It works for **24 hours** and must be changed at first login.
- Refuses if a Super Admin already exists. More admins are added from the Admin Team screen.
- `pnpm app:setup` with no options only adds missing settings. Running it again changes nothing.

**Locked out?** If the temporary password expired, or the only Super Admin was disabled:

```powershell
pnpm app:setup --reissue --email "you@tvlmedia.in"
```

This gives that existing Super Admin a new temporary password (24 hours, must be changed) and
re-enables the account. It never creates a new admin, and it is written to the audit log.

On a server, run the same commands with the server's environment variables set (no `.env` needed).

### Admin login (API)

`.env` needs `ADMIN_TOTP_ENCRYPTION_KEY` (32 random bytes). Generate one and paste it in:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Never reuse a key between environments. Changing it later means every admin has to set up 2-step again.

**2-step login (authenticator app)** is set by `ADMIN_TWO_STEP`:

| Where | 2-step login |
| --- | --- |
| Your computer (`NODE_ENV=development`) | **Off** by default: log in with email + password only. Add `ADMIN_TWO_STEP=on` to `.env` to try it |
| Automated tests | Both are tested |
| Staging and production (`NODE_ENV=production`) | **Always on.** The server refuses to start with `ADMIN_TWO_STEP=off` |

Logging in has steps; each answer says what comes `next` (`done` = logged in):

| Step | Call | When |
| --- | --- | --- |
| 1 | `POST /admin/auth/login` `{ email, password }` | Always |
| 2 | `POST /admin/auth/password` `{ newPassword }` | `next: change_password` (temporary password). At least 12 characters |
| 3 | `POST /admin/auth/2fa/setup`, then `POST /admin/auth/2fa/setup/confirm` `{ code }` | `next: setup_2fa`. Add the secret to an authenticator app; you get **10 backup codes once** |
| 3 | `POST /admin/auth/2fa/verify` `{ code }` or `{ backupCode }` | `next: verify_2fa` |
| — | `GET /admin/auth/me`, `POST /admin/auth/logout` | When logged in |

Trying it with `curl.exe` (the panel does this for you later). Requests that change something must
send the panel's `Origin`; the cookie is kept in `cookies.txt`:

```powershell
curl.exe -i -c cookies.txt -b cookies.txt -H "Origin: http://localhost:5173" -H "Content-Type: application/json" `
  -d '{\"email\":\"you@tvlmedia.in\",\"password\":\"YOUR-PASSWORD\"}' http://localhost:3000/admin/auth/login
```

Note: the session cookie is marked `Secure`. Browsers accept it on `localhost`; `curl.exe` only keeps
it when the address is `localhost` too.

**Tests** reset `sarthi_test` themselves: before the run every table is dropped and rebuilt, and
after the run every table is dropped again, so no test records are left behind.
