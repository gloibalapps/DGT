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
- **Tap-for-detail Money cards (DONE, June 2026):** Every Money card (Money Now hero, Performance, Where, Tax position, Deductions, Best & worst) shows a chevron and opens a full-screen breakdown via one parameterised screen `app/money-detail.tsx` (`?section=&period=`) that re-uses the `/api/money` payload — no new backend. Richer per-section views incl. a Money-Now waterfall + large Keep-rate, per-metric Performance explanations, Where as % of gross, Tax position with Update-set-aside, Deductions breakdown + est. tax impact, and Best/Worst day full stats + per-platform league table.
- **Money page redesign — 3-layer "what your work is really worth" (DONE, June 2026):** New `/api/money?period=` endpoint + `taxlib.money_overview()` powering a rebuilt Money tab with period tabs (Today/Week/Month/This FY). **Layer 1 Money Now:** real take-home (gross − expenses − estimated tax), Gross/Expenses/Est-tax breakdown, and **Keep Rate**. **Layer 2 Performance:** real $/hr, gross $/hr, $/km(mi), cost/km, profit/km, km driven, plus month-over-month trend. **Layer 3 Money Intelligence:** Tax position (owed YTD vs `tax_set_aside`, ahead/behind + recommended set-aside %, editable via `/tax-saved` modal), Deductions tracked YTD (+ est. tax impact), Best/Worst day (by real $/hr) & Best platform (by $/hr). Per-period tax uses the YTD effective rate from the existing tax engine. "Where your money went" bar breakdown ending in "Money you kept". New `tax_set_aside` profile field. Tests: `test_money.py` (77/77 pytest pass). Adaptations (accepted by user): work hours = logged online hours; best/worst *day* (no shift times); best platform by $/hr.
- **Weekly Goal (DONE, June 2026):** Drivers set a weekly earnings target (`profile.weekly_goal`, editable via new `/weekly-goal` modal). The Money hero shows a live progress bar — this week's income (Mon–Sun) vs the goal with a percentage, DoorDash-style; shows a "Set a weekly goal" prompt when unset. Field verified round-tripping through PUT/GET `/api/profile`.
- **Money hero redesign (DONE, June 2026):** Removed the This-FY/All-time period toggle — Money is now **Today only**. Net total is a full-width auto-shrinking figure on top (no overflow), with Income & Expenses stacked below a divider (Reports-style), plus the weekly-goal bar.
- **Driving Insights screen (DONE, June 2026):** New `/api/insights` endpoint + `taxlib.insights()` returns an 8-week weekly recap (income, expenses, profit, online hours, $/hr) and a best-day-to-drive breakdown (income & $/hr per weekday over the last 12 weeks, with `best_earning_day` / `best_hourly_day`). New full-screen `app/insights.tsx` (reached from a "Driving insights" card on the Money tab): trophy headline ("Saturdays pay best"), weekly earnings bars with hours, and horizontal per-weekday bars (uses $/hr when hours are logged, else earnings). Tests: `test_insights.py` (74/74 pytest pass). Documented conceptually alongside Online hours.
- **Online Hours logging (DONE, June 2026):** Drivers log manual online hours per shift so earnings-per-hour reflects real online time (incl. waiting), not just driving. Backend: new `shifts` collection + CRUD `GET/POST/PUT/DELETE /api/shifts` (`Shift` model: id, profile_id, date, hours, platform?, vehicle_id?, note?). `/api/performance` now prefers logged online hours over trip driving minutes when shifts exist in a week, and returns `hours_source: "online"|"driving"`. Frontend: `entry.tsx` gained a `shift` kind (Hours + Platform + Date + Note); Money tab has an **Online hours** card (period-aware total, `$/hr online`, per-shift list tap-to-edit/delete, "Log hours" button). Tests: `test_shifts.py` + new perf cases (72/72 pytest pass). Documented in User Guide.
- **Google login re-enabled (DONE, June 2026):** The Emergent-managed Google sign-in gate was restored in `_layout.tsx` (LoginScreen shown when `user` is null). `auth.tsx` hardened for native (module-scope `maybeCompleteAuthSession`, one-shot session_id guard, cold-start `getInitialURL` + `url` listener). Backend `/auth/*` endpoints unchanged. NOTE: preview URL now requires sign-in (previously bypassed for frictionless sharing).
- **AI Tax Assistant "Ask GigTax" (DONE):** New `Ask` tab — grounded Q&A chat for gig drivers. Backend `POST /api/ask` uses Claude Sonnet 4.6 (Emergent LLM key) with a system prompt locked to a **verified knowledge base** (`backend/tax_kb.py`, distilled from official ATO & IRS gig-driver deduction rules). No web search; answers ONLY from the KB, cites rule/year, refuses out-of-scope ("not in my verified sources — see a registered tax agent"), auto-tailors to country. Frontend `app/(tabs)/ask.tsx` chat UI with suggestions, disclaimer, light multi-turn. Verified live. Documented in User Guide.
- **Tax setup country-aware (DONE):** AU shows GST registration + ABN/TFN; US hides GST fields, shows EIN/SSN + "Estimated tax frequency" (1040-ES note).
- **Method comparison moved to Reports (DONE):** The "Which method is better?" vehicle-deduction comparison card was moved from the **Mileage** tab to the **Reports** tab (works for both AU logbook-vs-cents/km and US actual-vs-standard-mileage, FY-based via `api.taxMileage`). The old US-only "Car expense method" card in Reports was deleted (redundant). Reports now fetches report + tax-mileage in parallel.
- **Tab de-duplication (DONE):** Removed duplicate modules so each lives in one place. **Home** no longer shows the "Set aside for taxes" jar or the "Tax Mileage" estimate card (both already in **Reports**). **Vehicle management moved entirely to Settings** — "Set up your vehicle" card and "Add car" link removed from Mileage (switcher chips + read-only odometer card remain). **Settings** has a proper **Vehicles** list (add / edit / set-active via `/vehicle`).
- **Monetization / Paywall (DONE, 2026 — needs native build to test purchases):** `GigTax Pro` subscription via RevenueCat (`react-native-purchases` 10.7.1). Monthly ($19.99) + Yearly ($99.99) plans with a 7-day free trial; whole-app gate after login (`SubGate` in `_layout.tsx`). Polished `PaywallScreen` reachable as `/paywall` modal + from Settings › Subscription. Entitlement id = `pro_access` (must match RevenueCat dashboard). Real store prices load from RevenueCat offerings; fallback preview prices in `PaywallScreen.tsx`. Keys in `frontend/.env`: `EXPO_PUBLIC_RC_IOS_KEY` (appl_…) / `EXPO_PUBLIC_RC_ANDROID_KEY` (goog_…) — empty in preview, user to supply. Gate bypassed on web/Expo Go/no-keys.
- **Work-type-aware platforms (DONE):** `platformsForWorkType()` filters platform options by work type in onboarding + Settings; Work type section sits directly above Platforms in Settings.
- **Tax-Savings Jar (DONE, tested iteration_10):** Home shows a running "set aside for taxes" balance for the tax year. US = self-employment tax + estimated federal income tax; AU = estimated income tax (resident brackets + Medicare levy) + GST to remit if registered. Attached to /api/dashboard as tax_jar; taps to Reports. 61/61 pytest pass.
- **US Tax Support (DONE, tested iteration_9):** Country-aware engine; IRS standard mileage vs actual, Schedule C, SE tax.
- **Multi-Vehicle (DONE, tested iteration_8):** Per-car trips/expenses/logbook/deduction; income/GST combined.
- **Tax Mileage (Phases 1-3, DONE, tested iteration_7):** Logbook-method-first with live method comparison (ATO logbook vs cents-per-km 91c/5000km cap).
- **Calendar date picker (DONE, tested iteration_6):** All manual date-typing removed.

## Notes
- GPS shift tracker uses **foreground** location — full background auto-tracking requires a native dev/prod build (cannot be validated in Expo Go/web preview).
- Receipt images currently stored as base64 on the expense doc (cloud archival deferred to P1).
