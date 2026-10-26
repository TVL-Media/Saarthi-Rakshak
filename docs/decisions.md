# Decisions Log

Short record of what was decided and why. Add new decisions at the top.

| Decision | Why |
| --- | --- |
| Admin passwords: Node's built-in scrypt, N=2^16, r=8, p=2 (OWASP-listed), maxmem 128 MB, 16-byte salt; stored as `scrypt$N$r$p$salt$hash` | No extra library or native build; settings are stored per hash so they can be raised later |
| First Super Admin via `pnpm app:setup --name --email`: one-time temporary password (20 chars, ~115 bits) shown once in the terminal, never stored or logged; must be changed at first login; expires after 24 hours. Refuses if any Super Admin exists | No password in code or `.env`; only one bootstrap path |
| Break-glass: `pnpm app:setup --reissue --email` gives an EXISTING Super Admin a new temporary password and re-enables the account; never creates an admin; audit-logged (`setup.super_admin_reissued`) | Recovers from an expired temporary password or a disabled only Super Admin. Needs server access, so it is only for the tech lead |
| Default safety settings inserted by the setup command, only if missing. Location retention and SMS providers are not inserted until agreed | Running setup again never undoes a change made in Settings |
| Test database reset by undoing and re-running all migrations (before and after each run, and before each setup test); end-to-end tests run one file at a time | `audit_log` and `sos_events` refuse deletes, so dropping tables is the clean way to wipe; tests never leave records |
| Kysely (0.29) for migrations and typed queries; migrations written as plain SQL | One small tool with no dependencies, on the `pg` driver we already use; plain SQL is easy to review; PostGIS works directly |
| `sos_events`: a database trigger blocks deletes and changes to id, user_id, trigger, is_test, started_at (user_id may only become NULL on account deletion). Status, ended_at, end_reason can change. Admins have no edit API at all | SOS history must be trustworthy, even if application code has a bug |
| `audit_log` is append-only (triggers block UPDATE, DELETE and TRUNCATE) | An audit trail that can be edited proves nothing |
| Production: the server connects as a **limited database user** (read/write rows only: no DDL, no TRUNCATE, not the table owner). Only migrations run as the owner user | Triggers can be dropped or disabled by the table owner; a limited user cannot, so the audit and SOS protections hold even if the server is compromised |
| Guardian API (when built): a declined guardian's row loses its phone; only a **hashed** phone is kept in a "do not invite again" list | Stops repeat invites to someone who said no, without keeping their number |
| "Delete my account" (`deleteUserData`): deletes user, devices, guardians, journeys, location points, check-ins, guardian links, audio clips and support tickets; keeps SOS events and alerts with every link to the person removed | DPDP: personal data goes; anonymous counts keep pilot reports correct. Support tickets are deleted because their messages are personal text |
| Guardians who decline: phone number removed (database rule: a declined guardian must have no phone). The guardian API does this when it is built | Someone who said no should not stay on file |
| `location_points.delete_after` for a future cleanup job; retention days to be agreed with the client and stored as a setting | Location history is sensitive and should not be kept forever |
| Alerts and audit_log hold ids only, never phone numbers or names (including provider error text) | They are kept after account deletion |
| Node.js 24 LTS (≥ 24.9) for the server, locally and on DigitalOcean; Jest runs with `--experimental-vm-modules` | NestJS 12 ships only as ES modules; Jest loads them only on Node ≥ 24.9 with that flag. Node 22 leaves support in April 2027 |
| Server: NestJS 12, TypeScript 6.0 (not 7), `pg` driver, ioredis 5 (not 6), Zod for settings; no `@nestjs/config` or `@nestjs/terminus` | TS 7 not yet supported by ts-jest/typescript-eslint; BullMQ uses ioredis 5; Node's built-in `.env` loader and a small custom `/health` are enough |
| Settings from root `.env` if present, otherwise real environment variables; test URLs required only in development/test | Same code runs locally and on DigitalOcean; tests can never fall back to dev data |
| Local Docker: `postgis/postgis:17-3.5`, `redis:7.4-alpine`; one PostgreSQL container with two databases (`sarthi_dev`, `sarthi_test`); local PostgreSQL port 5433; Redis tests use DB `/1` | Same PostgreSQL version as DigitalOcean managed; pinned versions for everyone; simplest setup that keeps test data separate; 5433 avoids clashing with a Windows-installed PostgreSQL |
| UI is designed in Figma and read by Claude Code through the Figma MCP server; Ant Design in code | One source of truth for design; Ant Design components map closely to the Ant Design Figma kit |
| No fake data in the admin panel; no simulator; clear empty states | Requested by the project owner; only real data and real configuration appear in the panel |
| Local development uses Docker (PostgreSQL + PostGIS, Redis); staging and production use DigitalOcean | Docker is the easiest identical setup for every developer; DigitalOcean hosts the real system in India |
| Build the admin panel first, with the backend it needs | Requested by the team |
| Admin panel: React + Vite + Ant Design (not Next.js) | Panel sits behind a login, needs no search engine pages; Ant Design gives ready admin components |
| Support Admin is not a command centre | Support handles app problems in office hours; emergencies go to guardians and 112 in Phase 1 |
| Excluded for now: auto-call, silent alert, Hindi | Not in the scope document |
| WhatsApp alerts only via Change Request | Not in the scope document |
| Disaster alerts (official NDMA) moved to Phase 2 | Simple, uses official data; replaces crowdsourced earthquake warning |
| Child Safety Mode must be visible (Phase 4) | Hidden monitoring is banned by Google Play and legally risky |
| Admins cannot play audio | Privacy; audio belongs to the user. Export only for police/court requests, logged |
| Audio auto-deletes after 30 days unless kept | Privacy and storage |
| No-guardian-response backup: re-send alerts, help user call 112 | No command centre in Phase 1 |
| Check-ins only on events: off route 500 m, stopped 3 min, late 15 min | Fewer annoying prompts; no reply in 2 min alerts guardians (not full SOS) |
| SOS countdown 5 s, cancel without PIN | Speed; guardians are told if an SOS is cancelled |
| Phase 1 uses "while using the app" location only | Easier Google Play approval; tracking runs in a user-started foreground service |
| Guardians use an SMS web link, no app | Removes the biggest adoption barrier |
| SMS: Indian provider + backup, DLT registered; SIM SMS when offline | Delivery in India; works without internet |
| Firebase for push, crash reports and login OTP | Standard on Android; OTP works before DLT is ready |
| Database: PostgreSQL + PostGIS; Redis + BullMQ | Linked data, location maths, fast live data and timers |
| Hosting: DigitalOcean, Bangalore | Data stays in India |
| Stack: Flutter + Kotlin safety engine, Node.js (NestJS), React | Team skills; native code needed for reliable background work |
| Android first, Noida pilot | Most users on Android; team is based in Noida |
