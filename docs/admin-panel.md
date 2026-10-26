# Admin Panel — Spec and Build Order

The admin panel is for the client's team: support, checking problems and pilot reports.
It is **not** a command centre — admins cannot act on an SOS in Phase 1.

Visual mockup: https://claude.ai/artifact/S2JFHZLFaiwZVTFjpaJTXc (6 screens; the sample data there is only for the mockup).

## Roles

| Role | Who |
| --- | --- |
| **Super Admin** | Client owner + TVL tech lead. Full access |
| **Support Admin** | Client staff member who handles everyday user problems ("OTP not received", "my guardian didn't get the SMS"). Can see user details to help, but cannot change settings, delete data or play audio |

| Action | Super Admin | Support Admin |
| --- | --- | --- |
| Dashboard, reports | ✅ | ✅ |
| Search users, view profile | ✅ | ✅ |
| SOS and journey history | ✅ | ✅ |
| Alert log | ✅ | ✅ |
| Support tickets | ✅ | ✅ |
| Block / unblock user | ✅ | ✅ |
| Send setup reminder | ✅ | ✅ |
| Export audio (police/court request, reason required, logged) | ✅ | ❌ |
| Delete user data (on user request) | ✅ | ❌ |
| Change settings (safety rules, SMS provider) | ✅ | ❌ |
| Add / remove admins | ✅ | ❌ |
| View audit log | ✅ | ❌ |

**Nobody** can play audio in the panel, or cancel/edit/delete an SOS record.

## Screens

| # | Screen | Shows |
| --- | --- | --- |
| 1 | Dashboard | Active SOS, active journeys, SOS today, new users, failed alerts; system health (server, DB, push, SMS main/backup); Noida map (SOS markers, journey counts only); "Needs attention" list; recent events |
| 2 | Live SOS | Active SOS list; selected SOS: duration, start method, last location age, battery, network, live map trail; per-guardian table (SMS, opened link, responding); audio status (no playback); view-only notice |
| 3 | Users | Search by phone; profile; setup status (permissions, battery saving); device (model, Android, app version, last seen); guardians (invite status, last alert); recent activity; actions |
| 4 | SOS & Journey History | Filters (type, real/test, date, outcome); event list; minute-by-minute timeline per event; read-only |
| 5 | Alert Log | Delivery stats; every SMS/push with provider, result and next step; failed first; DLT template / domain / backup status |
| 6 | Support Tickets | User complaints and "report a problem" messages |
| 7 | Reports | Signups, journeys, SOS count, false alarms (cancelled SOS), delivery rate, phones with problems |
| 8 | Settings (Super Admin) | Safety rules (see CLAUDE.md), SMS provider main/backup |
| 9 | Admin Team (Super Admin) | Admins, roles, last login, add/remove |
| 10 | Audit Log (Super Admin) | Who viewed or changed what, when |

## Privacy rules (enforced on the server)

- Live location only during an active SOS; journeys shown as counts on maps.
- Phone numbers partly masked.
- No audio playback for any admin.
- Every view and action written to `audit_log`.
- SOS records are read-only.
- 2-step login for every admin; auto logout after inactivity.

## Tech stack

React + TypeScript · Vite · Ant Design · React Router · TanStack Query · Socket.IO client · Google Maps (React) · Recharts · React Hook Form + Zod · Playwright tests.
Talks only to the NestJS server (never directly to the database).

## Build order (admin panel first)

**No fake data.** The user app does not exist yet, so most screens will be empty at first. Every screen must have a
clear empty state (for example "No SOS events yet"). Setup creates only real configuration: the first Super Admin and
the default safety settings. Automated tests use a separate test database that is wiped after each run; test records
never appear in the panel.
Do **one step per task**: plan → approve → build → run → test → commit.

| # | Step | Done when |
| --- | --- | --- |
| 1 | `docker-compose.yml`: PostgreSQL + PostGIS, Redis; `.env.example` | Both run locally with one command |
| 2 | pnpm workspace + NestJS server skeleton + `/health` | `/health` returns OK and checks DB + Redis |
| 3 | Database schema + migrations (tables listed in `phase-1-overview.md`) | Migrations create all tables |
| 4 | Setup command: create the first Super Admin and default safety settings; separate test database for automated tests | First Super Admin exists; tests run on their own database and clean up |
| 5 | Admin auth: login, 2-step verification, roles, audit log | Super Admin can log in; role checks tested |
| 6 | Admin panel skeleton: Vite + Ant Design, login page, layout (sidebar, top bar), routing | Login works in the browser |
| 7 | Screens in order: Settings → Admin Team + Audit Log → Users → History + timeline → Alert Log → Dashboard → Live SOS → Support Tickets → Reports | Each screen works, shows a clear empty state, and passes its tests |
| 8 | Security check: role access, no audio playback, audit entries | Checklist passes |

Settings, Admin Team and Audit Log come first because they work with real data from day one.
Screens that need user data (Users, History, Alert Log, Dashboard, Live SOS) are verified by automated tests until
the user app starts sending real data. Show the client a demo after every 2–3 screens.
