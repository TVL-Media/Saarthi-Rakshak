# Sarthi Rakshak — Later Phases

Every scope-document feature not in Phase 1 has a place in Phase 2, 3 or 4.
Each phase starts only when what it depends on is ready. **Do not build these yet.**

## Phase 2 — Smarter protection

Starts when Phase 1 works reliably in Noida. Needs: lawyer's review of evidence tools, plan prices, NDMA alert feed access.

| Area | Feature | What it does |
| --- | --- | --- |
| Raise SOS | Shake SOS | Shake hard to start SOS; only during a journey or when switched on |
| Raise SOS | Voice SOS | Set phrase starts SOS; listens only during an active journey |
| Raise SOS | Photo at SOS start | Front + back photo while the SOS screen is open, sent to guardians |
| Detection (beta) | Crash detection | "Drive mode": hard hit + sudden speed drop → 10-s countdown → SOS |
| Detection (beta) | Fall detection | Free fall + hard hit → countdown; approximate fall height |
| Detection (beta) | Location "all the time" (optional) | Tracking restarts by itself after phone restart |
| Evidence | Evidence recorder | One-tap audio with time and place; locked 90 days |
| Evidence | Movement timeline | From the user's own location history |
| Evidence | Evidence report | Timeline + recordings as a PDF; no AI score |
| Alerts | Disaster alerts | Official NDMA (SACHET) alerts, "DROP, COVER, HOLD ON!", one-tap "I'm safe" |
| Community | Community safety feed | Admin-checked posts first |
| Growth | Rakshak sign-up | Applications checked by hand to build the Phase 3 pool |
| Growth | Subscriptions + payments | Basic/Silver/Gold; basic SOS, guardians, live location stay free |

## Phase 3 — Help network and services

We build the software; the client runs the people and operations.

| Feature | Client must have first |
| --- | --- |
| Rakshak availability map | Verified Rakshaks in Noida |
| Instant Rakshak (live ETA; falls back to guardians + 112) | Verified Rakshaks, strong background checks |
| Rakshak pre-booking | Booking/cancellation rules |
| Recognition tiers | Tier rules |
| Invisible Rakshak, Home Guard, Senior Safety Visits (booking flows) | Licensed security partner (PSARA), staff, prices |
| Partner network (detectives, agencies, cab/auto, local providers) | Onboarding and verification rules |
| Legal Protection Network | Contracted lawyers |
| Body cameras | Cameras with a usable API |
| Command centre (24/7 team acts on SOS cases) | Staffed 24/7 team or partner control room |
| Platinum plan | Insurance partner, live command centre |

New roles: Rakshak, partner, command centre operator.

## Phase 4 — Advanced features and outside approvals

| Feature | Starts when |
| --- | --- |
| Dial 112 / ERSS link | Government approval (start with UP 112, Noida) |
| CCTNS verification | Government approval |
| AI safe-route score | Enough real incident data |
| Child Safety Mode (visible: QR link, child SOS, school journeys, safe zones, "Where are you?", audio only on child SOS) | Lawyer's review; Google approval for location "all the time" |
| Smart glasses | Glasses with an open API |
| Consent documentation | Lawyer's review |
| Evidence consistency checklist (no score) | Phase 2 evidence tools in use |
| Witness confirmation (QR) + nearby device count | Phase 2 evidence tools in use |
| iPhone app (separate Swift safety engine) | Android app stable |
| Commercial extras (dynamic pricing, gamification, referrals, corporate) | Client business rules |

## Features changed so they can work

| Scope document says | Why it can't work as written | What we build instead | Phase |
| --- | --- | --- | --- |
| Earthquake warning from 50+ phones within 10 km | Needs huge numbers of phones running all the time; Android stops such apps; false alarms | Official government disaster alerts + "I'm safe" | 2 |
| Hidden child monitoring | Google Play bans hidden monitoring; whole app could be removed; legal risk | Visible Child Safety Mode | 4 |
| Always-listening voice SOS | Android blocks starting the mic from the background; battery | Voice SOS during an active journey | 2 |
| Automatic photo during SOS | Android blocks the camera off-screen | Photo while the SOS screen is open | 2 |
| Airbag signals | Phones have no airbag link | Hard hit + speed drop | 2 |
| Barometer fall height on every phone | Many phones have no barometer | Height from free-fall time | 2 |
| Witness detection from nearby phones | Bluetooth/Wi-Fi IDs are hidden and change | QR witness confirmation + device count as context | 4 |
| AI "defence strength score" | Not reliable; misleading; legal risk | Consistency checklist, no score | 4 |
| Rakshak in 2–3 minutes, every time | Depends on helpers nearby | Live ETA; fallback to guardians + 112 | 3 |

## Extras and excluded

| Item | Status |
| --- | --- |
| WhatsApp alerts | Extra — only if approved as a Change Request |
| Auto-call to guardians | Excluded for now |
| Silent alert | Excluded for now |
| Hindi language | Excluded for now |
| Scope document's future roadmap (volunteers, wearables, cyber safety, etc.) | Not planned unless approved separately |
