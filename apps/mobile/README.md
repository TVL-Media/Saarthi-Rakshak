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
   - Add the **SHA-1 and SHA-256** of the team key (see "Signing" below; `cd android && ./gradlew signingReport`)
     — needed for phone OTP. Without the team key on your computer, add your own debug key's values too.
   - From the app's settings copy: API key, App ID, Project ID, Sender ID (they are public identifiers, not secrets).
   - Turn on **Phone** sign-in. For testing without SMS, add test phone numbers with fixed codes.
3. Google Maps (optional until the key is ready): put `MAPS_API_KEY=...` in `android/local.properties`
   (not committed) and pass the same key as `--dart-define=MAPS_API_KEY=...`. Without a key the journey map and
   destination search are off (saved places still work).

## Signing (the team key)

Every APK we hand out is signed with **one team key**. Android installs an update only when the key
matches, and Play Protect blocks apps signed with the "Android Debug" key that every laptop makes for itself.

- The key is a keystore file plus `android/key.properties` (both git-ignored, never committed):

  ```
  storeFile=C:/keys/sarthi-rakshak-upload.jks
  storePassword=...
  keyAlias=upload
  keyPassword=...
  ```

  Use the full path for `storeFile`. Keep the keystore and passwords in the team's password manager:
  a lost key means testers must uninstall (losing their data on the phone) to get the next build.
- Make it **once** for the whole team (only if nobody has one yet):
  `keytool -genkeypair -v -keystore sarthi-rakshak-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`
- **Release builds stop** with a clear message if the key is missing; they never fall back to a debug key.
- **Debug builds** use the team key too when it is present, so a laptop build installs over a tester's
  build (and back) without uninstalling.
- Check an APK: `apksigner verify --print-certs <file>.apk` must show the team key, not `CN=Android Debug`.

## APK for testers (and Play Protect)

Testers get a **release** APK (not debug): it is not marked "debuggable" and is signed with the team key.
The test login still works (it comes from `DEV_LOGIN` in `dart-defines.json`, not from the build type).
Release builds use HTTPS only, so `API_URL` must be the `https://` test server.

```powershell
cd apps/mobile
flutter build apk --release --dart-define-from-file=dart-defines.json
# send build/app/outputs/flutter-apk/app-release.apk
```

Raise the build number in `pubspec.yaml` (`version: 1.0.6+8` → `+9`) for every APK you send; a phone
refuses an APK with a lower number than the one installed.

If Play Protect still warns or blocks it (Google has not seen the app before):

1. Check the APK is the release one with the team key (above).
2. Ask Google to review it: **Play Protect appeals** form
   (https://support.google.com/googleplay/android-developer/contact/protectappeals) — package
   `com.sarthirakshak.app`, the team key's SHA-256, and the release APK; explain it is a personal
   safety app (SOS SMS from the user's SIM, location and audio only during an SOS or journey). Send the
   same signed APK you give testers. Google does not confirm by email and a review can take days;
   guidance: https://developers.google.com/android/play-protect/warning-dev-guidance
3. On the phone, if it only warns: **More details → Install anyway**. If Play Protect blocks it outright,
   wait for Google's review. Do not ask testers to turn off Play Protect.

The app does not ask for the SMS-reading permissions that Play Protect blocks outright in India
(`READ_SMS`, `RECEIVE_SMS`, notification access, accessibility). It only asks for `SEND_SMS`, for the
offline SOS. Keep it that way: check with
`aapt2 dump badging <file>.apk | grep uses-permission` after adding a plugin.

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
