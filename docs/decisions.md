# Decisions Log

Short record of what was decided and why. Add new decisions at the top.

| Decision | Why |
| --- | --- |
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
