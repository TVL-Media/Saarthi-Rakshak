# Phase 3 app API (customer side)

What the Flutter app (`apps/mobile`, version 1.1.8+) calls for Phase 3. **The server now has these**
(`server/src/app/phase3/bookings.ts`, migration `0020_phase3_bookings`), switched **off** by default: while
`feature.nearby` / `feature.bookings` are 0 (Settings in the admin panel) every call answers 404 and the
screens show "Not available yet" (the app treats HTTP 404 and 501 as "not built"), never an error and never
made-up data. Bookings are worked from the admin panel (**Bookings** screen: quote, assign a Rakshak, started,
completed, cancel with a reason). "Near me" lists approved Rakshaks who switched **Available now** on in the
app (see below; the separate Rakshak app is not built yet). The shapes below are what the server returns. If the server needs a different shape, change
`apps/mobile/lib/api/phase3_api.dart` (one file) and the tests in `apps/mobile/test/phase3_test.dart`.

Same rules as `docs/app-api.md`: `Authorization: Bearer <session token>`, errors are `{ "error", "message" }`.

Not in this version: staff (Rakshak) screens, Razorpay payments and subscriptions, visit footage and wearable
cameras, the verification workflow. Those stay in the Phase 3 plan for later.

## Turning the screens on

Menu items appear only when the server switches them on for the user, in `rules` of `GET /v1/me`:

| Rule | Shows |
| --- | --- |
| `feature.nearby` = 1 | Rakshaks Near Me |
| `feature.bookings` = 1 | Book a Rakshak, My Bookings |

Test builds made with `--dart-define=PHASE3=true` show them always (they then show "Not available yet" if the
server has nothing).

## Rakshak "Available now" (how Rakshaks get on the list)

Until the Rakshak app exists, an **approved Rakshak** uses the normal app: Become a Rakshak → **Available now**.
While it is on, the phone (`RakshakPresenceService`, a foreground service) sends its position about every
3 minutes; it turns itself off after `rakshak.available_hours` (Settings, default 4), on Stop, on logout, or when
the server refuses.

| Call | Body | Answer |
| --- | --- | --- |
| `POST /v1/rakshak/presence` | `{ lat, lng, accuracyM?, start? }` (`start: true` when switched on) | `{ availableUntil }`; 404 while `feature.nearby` is 0; 409 if not an approved Rakshak or the hours are up (the phone stops) |
| `DELETE /v1/rakshak/presence` | — | 204: off at once, the position is deleted |

Only the latest position is kept (one row per Rakshak, overwritten; migration `0025_rakshak_available` adds
`available_since`); positions older than 24 hours are deleted by the hourly cleanup. A Rakshak silent for
10 minutes drops off the list. Admins see "Available now / last available" only, never the position.

## Rakshaks near me

`GET /v1/rakshaks/nearby?lat=28.57&lng=77.32&radiusM=2000`

Verified, online Rakshaks inside the radius. Filter by straight-line distance first (PostGIS `ST_DWithin`); work
out the road time (`etaMinutes`) only for the nearest few, the rest get `null`. First name only, and an
approximate position.

```json
{
  "items": [
    { "id": "uuid", "firstName": "Asha", "lat": 28.57, "lng": 77.32, "distanceM": 850, "etaMinutes": 6,
      "updatedAt": "2026-11-21T08:00:00.000Z" }
  ],
  "refreshSeconds": 30,
  "maxRadiusM": 5000
}
```

- `refreshSeconds` is how often the open screen refreshes (the app never goes below 10 s). It is how the server
  controls Maps cost. The screen does not refresh, and does not read location, while the app is in the background.
- `maxRadiusM`: the app offers 1, 2, 3 and 5 km up to this value.
- The app asks for location only after the user accepts the on-screen consent text (what it is for, that a
  Rakshak sees the position only after a booking request).

## Bookings

One generic flow; the kind of service is data, not code.

| Call | Purpose |
| --- | --- |
| `GET /v1/booking/services` | `[{ "id": "home_guard", "name": "Home Guard", "description": "..." }]` (Pre-booking, Invisible Rakshak, Home Guard, Senior Safety Visit) |
| `POST /v1/bookings` | Create. Body below. The `id` is made on the phone: repeating the call must return the same booking |
| `GET /v1/bookings` | My bookings, newest first |
| `GET /v1/bookings/:id` | One booking (the open detail screen reads it every 15 s) |
| `POST /v1/bookings/:id/quote/accept` | Accept the quote, returns the booking |
| `POST /v1/bookings/:id/quote/decline` | Decline the quote, returns the booking |
| `POST /v1/bookings/:id/cancel` | Body `{ "reason"?: string }`, returns the booking |

Create body:

```json
{ "id": "uuid", "serviceType": "home_guard",
  "windowStart": "2026-11-25T10:00:00.000Z", "windowEnd": "2026-11-25T12:00:00.000Z",
  "place": { "lat": 28.57, "lng": 77.32, "label": "Sector 18" }, "notes": "optional, up to 300 characters" }
```

Booking reply (every call above returns this):

```json
{
  "id": "uuid", "serviceType": "home_guard", "serviceName": "Home Guard",
  "status": "quoted",
  "windowStart": "...", "windowEnd": "...",
  "place": { "lat": 28.57, "lng": 77.32, "label": "Sector 18" },
  "notes": "Ring the bell twice",
  "quote": { "amountPaise": 49950, "note": "Two hours", "expiresAt": null },
  "rakshak": { "firstName": "Asha", "etaMinutes": 6 },
  "matching": { "state": "searching", "message": "Finding a Rakshak near you…" },
  "canCancel": true,
  "cancelMessage": "A fee may apply.",
  "history": [ { "status": "requested", "at": "...", "by": "user" } ],
  "createdAt": "..."
}
```

- `status`: `requested`, `quoted`, `confirmed`, `assigned`, `in_progress`, `completed`, `cancelled`. A booking can
  be cancelled at any point before `completed`. Every change is in `history` with who (`user`, `rakshak`,
  `admin`, `system`) and when.
- `quote`, `rakshak`, `matching`, `cancelMessage`: all optional (null or missing is fine). `matching.state` is
  `searching`, `offered` or `no_match`; the app shows a spinner for the first two and the message for the last.
- `canCancel` and `cancelMessage` come from the server's cancellation rules. The app shows `cancelMessage`
  in the confirm box (for example any charge) and never invents a fee.
- No payment step yet: accepting a quote only confirms the booking.

## Push

Booking changes arrive as the usual Firebase push with `data.type = "booking_status"` (and `data.bookingId`).
Tapping it, or the entry in the bell list, opens My Bookings.

## Matching (server only)

Nothing in the customer app is specific to how matching works. The server finds verified, online Rakshaks in
range, sends offers (Firebase push, SMS as fallback), the first accept wins (a lock on the server), and an
offer nobody answers moves on to the next Rakshak. The customer sees this only as `matching` and `status`.
