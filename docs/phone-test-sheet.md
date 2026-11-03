# Phone test sheet (plan step E1 / E2)

Test the Android app on **real phones** against the server on your laptop, before going live.
Fill one copy of the results table per phone. Tests that need the phone far from the laptop
(long drives on mobile data) wait for staging (plan Track F4).

## 1. Build and install the test app (once per change)

1. On the laptop: `docker compose up -d`, then `pnpm dev` (server, worker, guardian page).
2. Connect the phone by **USB** (see SETUP.md, "Connect an Android phone"), then:
   `adb reverse tcp:3000 tcp:3000` and `adb reverse tcp:8333 tcp:8333`.
3. In `apps/mobile/dart-defines.json` set `"API_URL": "http://localhost:3000"` (USB) and keep
   `"DEV_LOGIN": "true"` while the test login is on (`.env`: `DEV_LOGIN_CODE`, `DEV_LOGIN_UNTIL`).
4. Build a **debug** APK (release builds allow HTTPS only, so they cannot reach the laptop):
   `cd apps/mobile` → `flutter build apk --debug --dart-define-from-file=dart-defines.json`
   → install `build/app/outputs/flutter-apk/app-debug.apk` (`adb install -r <file>`).
5. Guardians: use a second phone (or a teammate's) as guardian. In development no real SMS is
   sent: the SMS text with the link is printed in the `pnpm dev` window. Open that link on the
   guardian's phone (same USB/Wi-Fi setup) or on the laptop.

## 2. Tests (tick each: ✅ works · ❌ fails · ⚠️ works with a workaround — write it down)

| # | Test | Expected |
| --- | --- | --- |
| 1 | Sign up: name + any mobile + test OTP; accept terms | Goes to guardians step; name shown on Home |
| 2 | Add guardian by typing and by **Choose from contacts**; guardian accepts the invite link | Guardian shows "Accepted" |
| 3 | Safety setup: allow location (all the time), notifications, SMS, microphone; battery "No restrictions"; brand guide followed | Home card says **PROTECTED** |
| 4 | Test SOS from Safety setup | Guardian gets the test message; nothing is left active |
| 5 | SOS button: hold 1 s → countdown → **cancel** | Nothing sent; History shows "SOS cancelled" |
| 6 | SOS button: hold 1 s → let the countdown finish | Guardian link opens, live dot moves, "I'm responding" shows in the app |
| 7 | SOS with the **screen off** (lock the phone right after it starts) for 5 min | Points keep arriving on the guardian page |
| 8 | SOS, then **swipe the app away** from recent apps | SOS notification stays, points keep arriving |
| 9 | SOS from the **home-screen widget** and from the **quick-settings tile** | Countdown opens, SOS starts |
| 10 | SOS in **airplane mode** (SMS permission given) | Guardians get the SIM SMS with the location; when back online the SOS reaches the server once (no duplicate) |
| 11 | SOS, **restart the phone** | After restart the SOS continues (notification back, points arrive) |
| 12 | SOS with **battery saver** on and battery under 15 % | Still sends points (slower) |
| 13 | "I'm safe" | Guardian page shows ended; History shows the timeline and audio clips |
| 14 | Audio: play a clip in History on the same phone; "Keep" | Plays; admin panel shows only the clip count |
| 15 | Journey: pick a destination, start, walk / drive a short route | Guardian gets the journey link; "Arrived" ends it |
| 16 | Journey: stop for 3+ min | Check-in screen; **I'm fine** stops it; no answer for 2 min → guardian alerted |
| 17 | Journey: "Stuck in traffic" | No new check-in for 10 min |
| 18 | Journey: turn mobile data and Wi-Fi off for 6+ min | Guardian gets "lost contact", then "back online" when data returns |
| 19 | No guardian presses "I'm responding" for 5 min during an SOS | Reminder SMS to guardians; the app offers Call 112 |
| 20 | Fake call | Rings like a real call; answer and hang up work |
| 21 | Report a problem | "Thank you" message; ticket saved (`support_tickets` table — the admin Support Tickets screen is not built yet) |
| 22 | Log out and log in again; delete account (with a fresh OTP — needs real Firebase OTP) | Works; deleted account goes to Welcome |
| 23 | Admin panel during tests 6–19: Dashboard, Live SOS, Alert Log, History, user profile | Numbers and rows match what happened; phone numbers masked; no location coordinates |

## 3. Results per phone

| Phone (brand, model) | Android version | Tests failed / workaround | Tested by, date |
| --- | --- | --- | --- |
| | | | |

Phones to cover (plan E2): Xiaomi/Redmi, Samsung, Vivo, Oppo, Realme, OnePlus, Motorola, one cheap low-RAM phone.
