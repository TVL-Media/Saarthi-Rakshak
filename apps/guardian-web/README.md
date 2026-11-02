# apps/guardian-web

The pages guardians open from an SMS link. No app and no login: the code in the link is the key.

| Address | Page |
| --- | --- |
| `/i/<code>` | Invite: accept or decline being a safety guardian |
| `/l/<code>` | Live: map, last update, battery, blood group (SOS), "I'm responding", Call, Call 112; journeys show the destination and route. After the end: "This alert has ended." |

- Vite + React + TypeScript, no UI library (fast on any phone).
- Data from the server's `/g/...` routes (see `docs/app-api.md`, "Guardian pages"); live updates over
  Socket.IO at `/g/socket.io`. The page also reloads its data every minute.
- In development `pnpm dev` serves it on **http://localhost:5175** (must match `GUARDIAN_WEB_URL`)
  and passes `/g/...` on to the server (`VITE_API_URL`).
- Map: Google Maps with `VITE_GOOGLE_MAPS_API_KEY`; without a key it shows an "Open in Google Maps" link.
- Tests: `pnpm --filter guardian-web test` (Playwright, server replies faked; no server needed).
