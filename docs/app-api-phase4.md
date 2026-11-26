# Phase 4 app API (mobile)

All Phase 4 endpoints are behind staged-release switches (default off): `feature.night_mode`,
`feature.safe_places`, `feature.women_safety`, `feature.legal_support`, `feature.child_safety`.
When a switch is off the endpoint returns 404 "Not available yet." and the app hides the menu entry.
The switches reach the phone in `me.rules`.

| Endpoint | Purpose |
| --- | --- |
| GET/PUT `/v1/night-mode` | Night Mode on/off (never starts SOS or tracking) |
| GET `/v1/safe-places?lat&lng&category&radiusM` | Partner + Google Places (server-side key) |
| GET `/v1/guidance?situation` | Reviewed safety guidance (not medical/legal advice) |
| GET `/v1/partners?kind=women_support|lawyer` | Verified partner directory |
| GET/POST `/v1/partner-requests`, GET `/:id`, POST `/:id/close` | Help / consultation requests |
| GET `/v1/incident-reports?group=women|men`, PUT/GET `/:id`, POST `/:id/delete` | Private incident reports (draft/submit) |
| `/v1/child/*` | Links, zones, routes, alerts, invitations, `POST /v1/child/location` |

## Not built in this round (decisions)
- Safe-route guidance (WOM-05) depends on P4-13 safety scoring, which is not built yet: shown as "not available yet".
- Child screen time (CHD-07) and full child check-in journeys: deferred; child uses the existing SOS.
- Guardian-route report delivery is recorded only; nothing is sent to guardians yet.
- Child location is posted every 2 minutes while the Child mode screen is open (no background service yet).
- Partner portal, parent identity verification and `GOOGLE_PLACES_API_KEY` are outside integrations.
- P4-11 Community feed: the Phase 2 feed (areas, flags, moderation) already covers it.
