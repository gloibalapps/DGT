# GigTax — Product Requirements Document

## Original problem statement
GigTax is a mobile tax & expense tracker for gig-economy drivers (rideshare + delivery: Uber, DoorDash, Uber Eats, Menulog, Amazon Flex…). It logs income, expenses and mileage as they drive and turns that into tax figures they can actually lodge. Australia is the reference market; US/UK/CA follow. Native iOS+Android via React Native + Expo. The maths being *right* is the entire reason it exists over a generic expense tracker.

## Architecture
- **Backend:** FastAPI + MongoDB. Authoritative AU tax logic lives server-side (`backend/tax.py`) so figures are independently testable. No auth in milestone 1 — a client-generated `profile_id` (local storage) scopes all data.
- **Frontend:** Expo Router (file-based), 5 bottom tabs + modal routes. Theme (dark/light) with locked palette; Barlow Condensed (variable-free static) for display numerals, Inter (variable) for body; tabular-nums on all money.
- **Integrations:** OpenAI gpt-4o vision via Emergent Universal LLM key for receipt scanning (`POST /api/receipts/scan`).

## User personas
- Full-time rideshare driver (passengers → GST-registered from $1, needs BAS figures).
- Delivery-only driver (under $75k → no BAS, just Schedule-C-style net profit).
- Casual/seasonal driver (occasional lodgement).

## Core requirements (static)
- Work-type switch (passengers/delivery/both) decides whether the BAS/GST card renders + registration warnings.
- AU vehicle deduction = logbook method only (cents/km deliberately excluded — 5,000 km cap).
- Business-use % **derived** from tagged trips (business km ÷ total km), 100% fallback when no trips, read-only in Settings.
- Fuel & vehicle costs apportioned by business-use %; tolls/phone/other claimed in full.
- Recurring vehicle payment **calculated** via daily proration (period-boundary additive), own labelled line + in CSV.
- Per-line `tax_treatment` (inclusive/free/exempt/out_of_scope); only inclusive feeds 1A/1B.
- BAS uses ATO codes G1, 1A (=G1÷11), 1B, Net GST; rendered only when registered.
- Reporting periods calendar-aligned to AU filing calendar (BAS quarters, FY Jul-Jun); never rolling.

## Implemented (2026-07-28)
- ✅ Backend: profile CRUD, trips/income/expenses CRUD, `/reports` (all periods), `/dashboard`, `/export` CSV, `/receipts/scan` (gpt-4o). Tax math verified (17/17 backend tests + curl).
- ✅ Onboarding (country+region → work type → platforms → ownership w/ inline rental note → optional recurring payment).
- ✅ Home (live net-earnings hero, business km today, recurring status, quick-add, recent activity edit/delete, tax-setup nudge).
- ✅ Trips (business-use % gauge, add trip, foreground GPS shift tracker w/ permission flow + post-drive Business/Personal prompt, badge toggle, delete).
- ✅ Expenses (category breakdown, Add + Scan side-by-side, history with tax-treatment badges).
- ✅ Reports (period selector, vehicle deduction breakdown, BAS/GST card w/ sanity check, registration warning, ATO link, CSV export).
- ✅ Settings (work type, region, read-only business-use %, vehicle ownership + recurring payment in one card, locked logbook-method note, platforms, tax-setup card, theme toggle).
- ✅ Every income/expense/trip entry editable & deletable.

## Backlog (prioritised)
- **P0 (next):** US market (split-rate mileage 72.5¢→76¢ date-keyed, Schedule C + SE tax + 1040-ES), then UK (55p/25p tiered, MTD quarters), then CA (T2125, province GST/HST).
- **P1:** Real auth (Google + Microsoft) + cross-device sync; background GPS auto-trip detection (dev build); receipt image archival to cloud storage (Drive/OneDrive/Dropbox).
- **P1:** Monetization — 14-day trial, $9.99/mo vs $19.99/BAS-quarter, paywall on Reports quarter/year (lock output, never input).
- **P2:** Per-vehicle method lock-ins (US/UK), depreciation/CCA helpers, multi-vehicle.

## Recently completed
- **US Tax Support (DONE, tested iteration_9):** Country-aware engine (profile.country AU/US). US = calendar tax year, miles, IRS standard mileage (date-keyed 2026: 72.5c Jan-Jun / 76c Jul-Dec, no cap), Schedule C summary, self-employment tax (~15.3% of 92.35% of net), no GST. Reports/Tax Mileage/logbook adapt labels + units; recommends Standard mileage vs Actual expenses. AU unchanged. 53/53 pytest pass.
- **Multi-Vehicle (DONE, tested iteration_8):** Per-car trips/expenses/logbook/deduction; income/GST combined.
- **Tax Mileage (Phases 1-3, DONE, tested iteration_7):** Logbook-method-first with live method comparison (ATO logbook vs cents-per-km 91c/5000km cap).
- **Calendar date picker (DONE, tested iteration_6):** All manual date-typing removed.

## Notes
- GPS shift tracker uses **foreground** location — full background auto-tracking requires a native dev/prod build (cannot be validated in Expo Go/web preview).
- Receipt images currently stored as base64 on the expense doc (cloud archival deferred to P1).
