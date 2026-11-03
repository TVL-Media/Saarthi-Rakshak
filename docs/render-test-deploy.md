# Closed test server on Render

A test server so testers can use the app away from your laptop. It is a **closed test**, not the
pilot:

- **Guardians get no real SMS.** No SMS provider is connected yet (DLT). The messages, with their
  links, appear only in the Render **Logs**. To test a guardian step, copy the link from the logs
  and send it to the guardian yourself (e.g. WhatsApp).
- **Not in India.** Render has no India region; this uses Singapore. Use it only with the team's
  own phones and numbers, not real pilot users. The pilot runs on DigitalOcean Bangalore (Track F).
- Everything else works: login, guardians, SOS, live page, journeys, check-ins, timers, push,
  audio, admin panel.

You do **not** need GitHub Actions. Render builds and deploys by itself on every push to `main`.
Run `pnpm lint` and `pnpm test` on your laptop before pushing (Render does not run the tests).

## What Render makes (from `render.yaml`)

Everything runs on Render; nothing else (no DigitalOcean) is needed.

| Part | Render service | Why |
| --- | --- | --- |
| Server + worker + admin panel + guardian page | Web Service `sarthi-rakshak-test` (Starter) | One address for everything; paid so it never sleeps (timers keep running) |
| File storage (photos, audio) | Web Service `sarthi-rakshak-test-files` (Starter + 10 GB disk) | SeaweedFS, the same storage as on your laptop; phones upload with short signed links |
| Database | Postgres `sarthi-rakshak-test-db` (PostgreSQL 17) | PostGIS is switched on by the first migration |
| Redis | Key Value `sarthi-rakshak-test-redis` (Starter, `noeviction`) | Live data and the job queue |

All four are paid plans — check Render's pricing page before you start. Render makes all secret
keys itself (`generateValue`), so you never type or copy keys.

## 1. Before you start

Have the Firebase key file ready: the same service-account JSON you use locally
(`C:\Users\hp\firebase-credentials_...json`). It is uploaded to Render as a secret file — never put
it in git.

## 2. Create the services

1. Push `main` to GitHub (`render.yaml` must be on `main`).
2. Render dashboard → **New → Blueprint** → connect GitHub → choose `TVL-Media/Saarthi-Rakshak`,
   branch `main`. Render reads `render.yaml` and lists the four services.
3. It asks for these values:

   | Setting | Value |
   | --- | --- |
   | `PUBLIC_URL`, `ADMIN_PANEL_ORIGIN`, `GUARDIAN_WEB_URL` | `https://sarthi-rakshak-test.onrender.com` (all three the same) |
   | `S3_ENDPOINT` | `https://sarthi-rakshak-test-files.onrender.com` |
   | `DEV_LOGIN_CODE` | a 6-digit code only your testers know (not `159344`) — or leave empty to use only real Firebase OTP |
   | `DEV_LOGIN_UNTIL` | last test day, e.g. `2026-11-20` (empty if no test login) |

   If Render gives a service a different address (the name was taken), use the address it shows
   on the service page instead, then **Manual Deploy** the main service again.
4. Click **Apply**. Then open `sarthi-rakshak-test` → **Environment → Secret Files → Add**:
   filename `firebase.json`, paste the whole Firebase JSON → Save → **Manual Deploy → Deploy latest commit**.
5. Wait for all services to show **Live**. Check `https://sarthi-rakshak-test.onrender.com/health`
   shows `"status":"ok"`, and `https://sarthi-rakshak-test-files.onrender.com/healthz` answers (an
   empty page is fine).

## 3. First admin account

Web service → **Shell**, then:

```
cd server && node dist/setup/cli.js --name "Parmeet Singh" --email "parmeet@tvlmedia.in"
```

It prints a temporary password once. Open `https://<your address>/` → log in → set a new password
→ set up 2-step login with an authenticator app (Google Authenticator) → save the backup codes.

## 4. The APK for testers

The test login works only in **debug** builds, so testers get a debug APK:

1. In `apps/mobile/dart-defines.json` set `"API_URL": "https://<your address>"` (keep the Firebase
   values; `"DEV_LOGIN": "true"` only if you set `DEV_LOGIN_CODE` on Render).
2. Build: `cd apps/mobile` → `flutter build apk --debug --dart-define-from-file=dart-defines.json`
3. Send `apps/mobile/build/app/outputs/flutter-apk/app-debug.apk`. Testers allow "Install unknown
   apps" for the app they open it with.
4. Real Firebase OTP (instead of the test code): in Firebase → Project settings → Android app, add
   the **SHA-1 and SHA-256** of the key the APK is signed with (`cd apps/mobile/android` →
   `.\gradlew signingReport`, "debug" variant). Real SMS OTP may need the Firebase Blaze plan;
   Firebase **test phone numbers** work without it.

Change `API_URL` back to `http://10.0.2.2:3000` for the emulator on your laptop.

## 5. During the test

- **Guardian links**: Render → web service → **Logs**, search `SMS` — the invite (`/i/...`) and live
  links (`/l/...`) are there (numbers are masked).
- **Admin panel**: `https://<your address>/` — Dashboard, Live SOS, Alert Log, History.
- Use `docs/phone-test-sheet.md` for what to test on each phone.

## 6. When the test is over

Turn off the test login: delete `DEV_LOGIN_CODE` in Render (or let `DEV_LOGIN_UNTIL` pass). Delete
the Render services when you no longer need them (test data lives only there).

## Problems

| Problem | Fix |
| --- | --- |
| Deploy fails at `corepack enable` | Change the build command start to `npm install -g pnpm@12.15.0 &&` instead of `corepack enable &&` |
| Server stops with a list of settings | A value is missing or wrong; the log names each one |
| `SERVE_WEB=on but .../index.html is missing` | The admin or guardian build failed; look higher up in the build log |
| Admin login loops back to the login page | `ADMIN_PANEL_ORIGIN` is not exactly the address in the browser (https, no `/` at the end) |
| App says it cannot reach the server | `API_URL` in the APK must be the `https://` address; rebuild the APK after changing it |
| Photos or audio fail to upload | `S3_ENDPOINT` must be the files service's `https://` address and that service must be Live |
| Server stops: a key "Must be 32 random bytes in base64" | Replace that key's value with the output of `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| "Too many requests" for every tester | `TRUST_PROXY_HOPS` must be `1` |
