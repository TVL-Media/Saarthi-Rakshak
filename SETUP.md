# Run Sarthi Rakshak on your computer (Windows)

Follow these steps in order. It takes about 20 minutes the first time (mostly downloads).
All commands are for **PowerShell**. Run them from the project folder unless a step says otherwise.

When you're done you'll have the **admin panel** open at http://localhost:5173.

---

## 1. Install these tools (one time)

| Tool | Version | Where |
| --- | --- | --- |
| Git | any recent | https://git-scm.com/download/win |
| Node.js | **24 LTS, 24.9 or newer** | https://nodejs.org (pick the "LTS" download) |
| Docker Desktop | any recent | https://www.docker.com/products/docker-desktop |

Then install **pnpm 12** (the package manager this project uses). Open a **new** PowerShell window:

```powershell
npm install -g pnpm@12.15.0
```

> Don't use `corepack enable`: on Windows it often fails with `EPERM: operation not permitted`.

Check everything is installed:

```powershell
node -v      # must show v24.9.0 or higher
pnpm -v      # must show 12.x
docker -v    # any version
```

Start **Docker Desktop** and wait until it says **"Engine running"**. Keep it running whenever you work
on the project.

---

## 2. Get the code

```powershell
cd D:\           # or any folder you like
git clone https://github.com/TVL-Media/Saarthi-Rakshak.git SarthiRakshak
cd SarthiRakshak
```

> All the work is on the branch **`claude/upbeat-ride-jbwwxq`** (there is no `main` branch yet).
> `git clone` picks it automatically. Check with `git branch` — it should show that name.
> Later, to get new changes: `git pull`.

---

## 3. Create your settings file `.env`

```powershell
copy .env.example .env
```

Now make a secret key **for your computer only**:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

It prints something like `q3Xk...=` (44 characters, ends with `=`). Open `.env` in any editor and
replace

```
ADMIN_TOTP_ENCRYPTION_KEY=generate_me
```

with your key, for example:

```
ADMIN_TOTP_ENCRYPTION_KEY=q3Xk...=
```

Leave everything else as it is. **Never commit `.env`** (Git already ignores it) and never share your key.

---

## 4. Start the database, Redis and file storage

```powershell
docker compose up -d
docker compose ps
```

Wait until all three lines (`postgres`, `redis`, `storage`) show **`healthy`** (about 10–20 seconds;
run `docker compose ps` again).

---

## 5. Install packages and create the tables

```powershell
pnpm install
pnpm db:migrate
```

`pnpm db:migrate` should end with lines like `Success  up  0008_settings_audit_details`.

---

## 6. Create your admin account

Use your own name and email:

```powershell
pnpm app:setup --name "Your Name" --email "you@tvlmedia.in"
```

It prints a **temporary password once**. Copy it now — it is not saved anywhere, and it works for
24 hours.

---

## 7. Start the project

```powershell
pnpm dev
```

This starts the server (with its background worker), the admin panel and the guardian pages
together. Wait until you see:
- `Server running on http://localhost:3000`
- `Local: http://localhost:5173/` (admin panel)
- `Local: http://localhost:5175/` (guardian pages: the links in invite and SOS messages)

SMS are **not sent** on your computer: each message is printed in the server window instead, so you
can copy a link from there and open it in the browser.

Leave this window open. To stop, press `Ctrl + C`.

---

## 8. Log in

1. Open **http://localhost:5173** in **Chrome or Edge** (not Safari).
2. Log in with your email and the temporary password from step 6.
3. Choose your own password (at least 12 characters).
4. You're on the Dashboard.

On your computer, login is **email + password only**. (2-step login with an authenticator app is off
in local development and always on in staging and production.)

---

## Every day after that

```powershell
# Docker Desktop running first
docker compose up -d
git pull
pnpm install
pnpm db:migrate
pnpm dev
```

---

## Something went wrong?

| What you see | What to do |
| --- | --- |
| `Invalid server settings: ADMIN_TOTP_ENCRYPTION_KEY ...` | Step 3: replace `generate_me` in `.env` with a key you generated |
| `Invalid server settings: DATABASE_URL: Required` (or similar) | `.env` is missing. Run `copy .env.example .env` (step 3) |
| `Unsupported engine` / Node version error during `pnpm install` | Install Node.js 24 LTS (24.9 or newer), open a new PowerShell window, try again |
| `EPERM ... pnpx` after `corepack enable` | Ignore it. Use `npm install -g pnpm@12.15.0` instead (step 1) |
| `pnpm` is not recognised | Open a new PowerShell window after installing pnpm |
| `docker compose` fails / "cannot connect to the Docker daemon" | Start Docker Desktop and wait for "Engine running" |
| `docker compose ps` doesn't say `healthy` | Wait a little; if it stays unhealthy: `docker compose logs postgres` (or `redis`, `storage`) |
| App login answers `service_unavailable` | Firebase is not set up in `.env` (see "App login with Firebase") |
| Server says `File storage not reachable` | File storage isn't running: `docker compose up -d`. The admin panel still works without it |
| `ECONNREFUSED 127.0.0.1:5433` when migrating or starting | The database isn't running: `docker compose up -d` |
| `port is already allocated` for 5433, 6379 or 8333 | Another program uses that port. Ask the team before stopping anything |
| `Port 5173 is already in use` or the server says port 3000 is in use | Close the other `pnpm dev` window or program using that port. The panel must be on 5173 |
| Log in says "Email or password is wrong" | Check the email. After 5 wrong tries the account is locked for 15 minutes |
| The temporary password no longer works (older than 24 hours) | `pnpm app:setup --reissue --email "you@tvlmedia.in"` prints a new one |
| `A Super Admin already exists` | You already made your account. Log in with your password, or use `--reissue` (row above) |
| Page shows "Couldn't load this page" | Is `pnpm dev` still running? Is Docker running? Check http://localhost:3000/health |
| Login works but you're sent straight back to the login page | Use Chrome or Edge on `http://localhost:5173` exactly (not `127.0.0.1`, not Safari) |

---

## App login with Firebase (for the user app)

Only needed when you work on the user app; the admin panel works without it.

1. Ask the team lead for the Firebase **service-account key file** (a `.json` file). Save it **outside**
   the project folder, e.g. `C:\Users\<you>\firebase-key.json`. Never commit it or send it on chat.
2. Add these two lines to your `.env` (use your own path):
   ```
   FIREBASE_PROJECT_ID=sarthi-rakshak
   GOOGLE_APPLICATION_CREDENTIALS=C:\Users\<you>\firebase-key.json
   ```
3. Restart `pnpm dev`. Without these lines the server prints
   `FIREBASE_PROJECT_ID is not set: app login is off` and app login answers `service_unavailable`.

For testing on a phone, use the **test phone numbers** set up in the Firebase console
(Authentication → Sign-in method → Phone → Phone numbers for testing). They use a fixed code and send no SMS.

---

## Connect an Android phone (for the user app)

The app on the phone talks to the server on your computer. Use **one** of these:

| Way | When | What to do |
| --- | --- | --- |
| **USB cable** (recommended) | Real phone | Turn on *Developer options → USB debugging* on the phone, plug it in, then run the two lines below. The app then uses `http://localhost:3000` |
| **Emulator** | Android Studio emulator | Nothing to set up. The app uses `http://10.0.2.2:3000` |
| **Wi-Fi** | Phone and computer on the same Wi-Fi | Find your computer's address with `ipconfig` (e.g. `192.168.1.20`). The app uses `http://192.168.1.20:3000`. Allow Node.js through Windows Firewall when Windows asks (Private networks only) |

USB (run again each time you plug the phone in):

```powershell
adb reverse tcp:3000 tcp:3000   # server
adb reverse tcp:8333 tcp:8333   # file storage (photo and audio uploads)
```

Check it works: open **http://localhost:3000/health** in the phone's browser. It should show `"status":"ok"`.

> Wi-Fi only: file storage listens on your computer alone, so photo and audio uploads need the USB
> cable (or the emulator). The rest of the app works over Wi-Fi.

---

## Running the tests (optional)

```powershell
pnpm --filter admin exec playwright install chromium   # one time, downloads a test browser
pnpm db:migrate
pnpm test
```

Tests use a separate test database and never touch your own data. They can run while `pnpm dev` is running.

More detail: [`README.md`](README.md) ("Local setup") and [`CLAUDE.md`](CLAUDE.md).
