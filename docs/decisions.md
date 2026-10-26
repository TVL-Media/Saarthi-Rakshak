# Decisions Log

Short record of what was decided and why. Add new decisions at the top.

| Decision | Why |
| --- | --- |
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
