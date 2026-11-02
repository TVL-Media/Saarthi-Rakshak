# apps/mobile — Sarthi Rakshak Android app

Flutter screens + a native Kotlin **safety engine** (`android/app/src/main/kotlin/com/sarthirakshak/app/engine/`).
Screens follow the RAKSHAK-APP Figma design (copies in `docs/design/mobile/`, notes in `docs/design/mobile/README.md`).
Server calls: `docs/app-api.md`.

## What runs where

| Part | Where | Why |
| --- | --- | --- |
| Screens, login, guardians, history, settings | Flutter (`lib/`) | |
| SOS after the countdown, location, audio, SIM SMS, journey checks, sending to the server | Kotlin foreground service `SafetyService` | Keeps working with the screen off, the app closed or no internet |
| Widget and quick-settings tile | Kotlin (`SosWidgetProvider`, `SosTileService`) | Open the SOS countdown from the home screen / lock screen |

The engine keeps everything for the server in a local queue (SQLite) and sends it in order when online.
Audio clips are encrypted with a key that never leaves the phone (Android Keystore).

## One-time setup

1. Install **Flutter 3.47** (stable) and **Android Studio** (Android SDK 36, platform tools). Run `flutter doctor`.
2. Firebase (phone OTP and push), in the Firebase console of the project used by the server:
   - Add an **Android app** with package name `com.sarthirakshak.app`.
   - Add the debug **SHA-1 and SHA-256** (`cd android && ./gradlew signingReport`) — needed for phone OTP.
   - From the app's settings copy: API key, App ID, Project ID, Sender ID (they are public identifiers, not secrets).
   - Turn on **Phone** sign-in. For testing without SMS, add test phone numbers with fixed codes.
3. Google Maps (optional until the key is ready): put `MAPS_API_KEY=...` in `android/local.properties`
   (not committed) and pass the same key as `--dart-define=MAPS_API_KEY=...`. Without a key the journey map and
   destination search are off (saved places still work).

## Run on a phone (USB)

```powershell
# server running on the laptop: pnpm dev
adb reverse tcp:3000 tcp:3000
cd apps/mobile
flutter run `
  --dart-define=API_URL=http://localhost:3000 `
  --dart-define=FIREBASE_API_KEY=... `
  --dart-define=FIREBASE_APP_ID=... `
  --dart-define=FIREBASE_PROJECT_ID=... `
  --dart-define=FIREBASE_SENDER_ID=...
```

Tip: keep the defines in a file `dart-defines.json` (git-ignored) and use `--dart-define-from-file=dart-defines.json`.

Debug builds allow plain `http://` to the laptop; release builds use HTTPS only.

## Tests

```powershell
flutter analyze
flutter test                                   # Dart: API client, screens, helpers
cd android; ./gradlew :app:testDebugUnitTest   # Kotlin: journey checks (stopped, off route, late)
```

Things only a real phone can test (Implementation Plan section 6.5): screen off, app killed, battery saver,
no internet (SIM SMS), restart during an SOS, widget and tile on the lock screen. Test on 3 brands first.
