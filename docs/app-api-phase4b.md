# Phone API: Phase 4, second group

All routes are under `/v1`, need a login, and return 404 "Not available yet." while their switch is off (Settings → Staged release, default off).

| Feature | Switch | Phone routes |
| --- | --- | --- |
| Chhupa Rakshak | `feature.chhupa_rakshak` | `GET/PUT /monitoring/:linkId[/consent]`, `POST /monitoring/:linkId/sessions`, `GET /monitoring-sessions/:id`, `POST .../stop`; child: `GET /child/monitoring`, `POST /child/monitoring/:id/location`, `POST .../stop` |
| School Monitoring | `feature.school` | `GET /schools`, `GET/POST /school-links`, `POST /school-links/:id/revoke`, `GET /school-links/:id/events`; school webhook `POST /hooks/school/:code` (HMAC signed) |
| Cyberbullying check | `feature.cyber_safety` | `GET /cyber/:linkId`, `PUT /cyber/:linkId/source`, `POST /cyber/:linkId/analyse`, `POST /cyber/flags/:id/review` |
| Smart Glasses | `feature.smart_glasses` | `GET /glasses/models`, `GET /glasses`, `POST /glasses/pair`, `POST /glasses/:id/unpair`, `/health`, `/captures` |
| Safer route | `feature.safe_route` | `POST /safe-route/routes`, `POST /safe-route/feedback` |
| Police / ERSS | `feature.police_handoff` | `GET /sos-handoff/:id` |

## Honest limits
- **Chhupa Rakshak** is location only, always visible on the child's phone, stops by itself, and every view is logged. No audio or photo.
- **School**: only events the school sends (signed). Missing news is "unknown", never "absent". A phone journey is not proof of attendance.
- **Cyberbullying**: rule-based and explainable; only text the family chooses to share. No access to any other account. A flag is a signal for a person, not proof.
- **Smart glasses**: model and firmware check works. Real recording needs the maker's SDK (not in this build); nothing is faked.
- **Safer route**: needs `GOOGLE_DIRECTIONS_API_KEY` (or the Places key) and imported datasets. Without them the app says so, or shows "not enough data". Never "safe", only "lower reported risk".
- **Police / ERSS**: no endpoint is assumed. SOS and Call 112 always work. The status shown is real (sent, accepted, timed out, fallback). The app never says police are on the way until the authority confirms.

## Secrets
Authority credentials are registered in the admin panel by environment-variable name only (for example `ERSS_API_KEY`), never the value.
