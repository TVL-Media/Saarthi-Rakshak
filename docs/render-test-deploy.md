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

| Part | Render service | Why |
| --- | --- | --- |
| Server + worker + admin panel + guardian page | Web Service `sarthi-rakshak-test` (Starter) | One address for everything; paid so it never sleeps (timers keep running) |
| Database | Postgres `sarthi-rakshak-test-db` (PostgreSQL 17) | PostGIS is switched on by the first migration |
| Redis | Key Value `sarthi-rakshak-test-redis` (Starter, `noeviction`) | Live data and the job queue |

Paid plans cost money every month — check Render's pricing page before you start.

## 1. Before you start (once)

1. **File storage** (photos and audio): make a DigitalOcean Space in **blr1** (Bangalore), e.g.
   `sarthi-test-files`, and a Spaces access key. You need: endpoint
   `https://blr1.digitaloceanspaces.com`, region `blr1`, bucket name, access key, secret key.
2. **Three secret keys** — run this three times in the VS Code terminal and keep each line:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   They are for `ADMIN_TOTP_ENCRYPTION_KEY`, `PHONE_HASH_KEY` and `GUARDIAN_LINK_KEY`. Never use the
   local ones from your `.env`.
3. **Firebase key file**: the same service-account JSON you use locally
   (`C:\Users\hp\firebase-credentials_...json`). It is uploaded to Render as a secret file — never
   put it in git.

## 2. Create the services

1. Push `main` to GitHub (`render.yaml` must be on `main`).
2. Render dashboard → **New → Blueprint** → connect GitHub → choose `TVL-Media/Saarthi-Rakshak`,
   branch `main`. Render reads `render.yaml` and lists the three services.
3. It asks for every `sync: false` value:

   | Setting | Value |
   | --- | --- |
   | `PUBLIC_URL`, `ADMIN_PANEL_ORIGIN`, `GUARDIAN_WEB_URL` | `https://sarthi-rakshak-test.onrender.com` (all three the same; if Render gives the service another address, use that one everywhere) |
   | `ADMIN_TOTP_ENCRYPTION_KEY`, `PHONE_HASH_KEY`, `GUARDIAN_LINK_KEY` | the three keys from step 1.2 (a different one each) |
   | `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | from step 1.1 |
   | `DEV_LOGIN_CODE` | a 6-digit code only your testers know (not `159344`) — or leave empty to use only real Firebase OTP |
   | `DEV_LOGIN_UNTIL` | last test day, e.g. `2026-11-20` (empty if no test login) |

4. Click **Apply**. Then open the web service → **Environment → Secret Files → Add**:
   filename `firebase.json`, paste the whole Firebase JSON → Save → **Manual Deploy → Deploy latest commit**.
5. Wait for the deploy to show **Live**. Check `https://<your address>/health` shows `"status":"ok"`.

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
the Render services and the Space when you no longer need them (test data lives only there).

## Problems

| Problem | Fix |
| --- | --- |
| Deploy fails at `corepack enable` | Change the build command start to `npm install -g pnpm@12.15.0 &&` instead of `corepack enable &&` |
| Server stops with a list of settings | A value is missing or wrong; the log names each one |
| `SERVE_WEB=on but .../index.html is missing` | The admin or guardian build failed; look higher up in the build log |
| Admin login loops back to the login page | `ADMIN_PANEL_ORIGIN` is not exactly the address in the browser (https, no `/` at the end) |
| App says it cannot reach the server | `API_URL` in the APK must be the `https://` address; rebuild the APK after changing it |
| Photos or audio fail to upload | Check the five `S3_*` values and that the access key can write to the bucket |
| "Too many requests" for every tester | `TRUST_PROXY_HOPS` must be `1` |
