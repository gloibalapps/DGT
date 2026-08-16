#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================
## Tax Mileage feature (Phases 1-3) — added by main agent
- Backend engine in tax.py: trip_business_km (mixed-trip aware), best_logbook_window (continuous 12-week ATO logbook, representative window), logbook_summary, method_comparison (logbook vs cents-per-km 91c/5000km cap), odometer_check, tax_mileage aggregator.
- New endpoints: GET /api/tax-mileage, GET /api/export-mileage (CSV motor vehicle report).
- Models extended: Profile.vehicle (Vehicle: registration, make_model, year, purchase_price, fuel_type, business_use_start, opening/closing odometer + dates); Trip gained type "mixed", business_pct, purpose, from_label, to_label, odo_start/end.
- Frontend: "Trips" tab renamed to "Mileage" (Tax Mileage hub at app/(tabs)/trips.tsx). New screens app/vehicle.tsx (My Vehicle setup + odometer) and app/logbook.tsx (12-week journeys audit trail). entry.tsx trip form now Business/Mixed/Private + purpose chips + mixed business% + from/to. Home has a Tax Mileage deduction-estimate pillar.
- Local profile only (no auth). ATO cents-per-km rate 2026-27 = 91c, 5000km cap (verified via web).

## Multi-Vehicle (added by main agent)
- Backend: standalone `vehicles` collection with CRUD (GET/POST/PUT/DELETE /api/vehicles, POST /api/vehicles/{id}/activate). ensure_vehicles() auto-migrates legacy profile.vehicle+vehicle_ownership+recurring_payment into a default active vehicle and back-fills vehicle_id onto existing trips/expenses. Trip & Expense gained vehicle_id. tax_mileage takes vehicle_id (defaults to active), returns per-vehicle logbook/method_comparison/odometer + a `vehicles` summary array + selected/active ids. compute_report & dashboard now apportion vehicle costs and recurring payments PER-vehicle (each car's own business-use %); income/GST stays combined. 30/30 pytest pass.
- Frontend: store exposes vehicles/activeVehicle/setActiveVehicle/reloadVehicles. Mileage hub has a vehicle switcher (vehicle-chip-{id}) + Add car (mileage-add-vehicle); tapping a chip activates that car and reloads its numbers. vehicle.tsx rewritten to add/edit a specific car (nickname, ownership, recurring payment, odometer) via api.addVehicle/updateVehicle/deleteVehicle. New trips (manual/GPS/auto) and fuel/vehicle expenses attach the active vehicle_id (create only, not edit). Onboarding syncs the first vehicle. Home pillar shows the active vehicle name + its deduction.
- Verified via curl: 2 cars, per-car logbook V1=66.67% V2=100%, vehicles summary + deductions correct.

## US Tax Support (added by main agent)
- Country-aware engine keyed off profile.country ("AU"|"US"). US = calendar tax year (Jan-Dec), miles, Schedule C, self-employment tax (~15.3% of 92.35% of net), NO GST/BAS.
- IRS standard mileage date-keyed: 2025=70c, 2026=72.5c (Jan-Jun) / 76c (Jul-Dec), NO 5000 cap. us_mileage_rate()/us_standard_mileage_deduction() sum business miles x the rate for each trip's date.
- tax.py: period_range/fy_start/_fy_bounds/_fy_label/fmt_period_label all take country. compute_report branches to compute_report_us (schedule_c{gross,car_and_truck=max(standard,actual),car_method,other_expenses,net_profit}, se_tax{net_earnings,amount,quarter_due}, show_bas=False). method_comparison(country): US actual-expense uses ANNUAL business-use % (not 12-week window); "cents_per_km" block becomes Standard mileage (date-keyed, no cap); labels via .title/.detail. logbook_summary(country): US = full tax-year mileage log (us_mode, no 12-week). dashboard/tax_mileage country-aware units/currency/quarters. tax_setup_complete for US only needs legal_name.
- Frontend: COUNTRIES US active=true. Reports screen branches on rep.country to show Schedule C + car-method + SE-tax cards (AU keeps BAS). Tax Mileage hub, Home pillar, logbook screen use tm.distance_unit (mi/km) and method .title/.detail; US labels "IRS Mileage Log"/"Standard mileage"/"Actual expenses". Vehicle odometer labels made tax-year-neutral.
- Verified via curl: US standard mileage $1485 (1000mi@72.5c + 1000mi@76c), actual 80%x$800=$640, recommends Standard mileage; SE tax on net; calendar quarters (Q3 due 15 Sep); AU unchanged (km/logbook/BAS). 45/45 pytest pass.

## Tax-Savings Jar (added by main agent)
- Backend: taxlib.tax_jar(profile, year_report, ref) computes a running "set aside for taxes" for the tax year to date, attached to GET /api/dashboard as `tax_jar`. US = self-employment tax (precise) + estimated federal income tax (2025 single brackets after standard deduction, half-SE deductible). AU = estimated income tax (2024-25 resident brackets + 2% Medicare levy) + GST to remit (if registered). Returns set_aside, rate_pct, net_profit, tax_year_label, components[], note. Helpers: us_federal_income_tax, au_income_tax, _bracket_tax.
- Frontend: Home shows a "SET ASIDE FOR TAXES" jar card (home-tax-jar) with the amount, % of net profit, component breakdown and disclaimer; taps through to Reports. Also fixed Home "business today" tile to use data.distance_unit (mi/km).
- Verified via curl: US net $38,550 -> $7,707.62 (SE $5,446.94 + fed $2,260.68, 20%); AU net $50,000 -> $6,788 income tax (13.6%). 53/53 pytest still pass.

## Final pre-ship check — AI Assistant + User Guide consistency (added by main agent)
- Google login REMOVED — app opens directly (local profile, no auth). No credentials needed.
- NEW: AI Tax Assistant "Ask" tab. Backend POST /api/ask {question, country, history} -> Claude Sonnet 4.6 (Emergent LLM key), grounded ONLY in backend/tax_kb.py (ATO for AU, IRS for US). Must: answer claimable/not-claimable Qs from KB, refuse out-of-scope ("not in my verified sources — registered tax agent"), no web search. Frontend app/(tabs)/ask.tsx chat UI (suggestions, disclaimer, send).
- Bottom tabs now: Home, Mileage, Ledger, Reports, Ask, Profile (Settings renamed to Profile, person icon).
- User Guide manual (Profile > Help > User guide, route /manual) updated to reflect ALL tabs/features: Ask tab, no-login wording, Home layout (hero + Performance + km/owed at bottom), collapsible History on Mileage & Ledger, ATO/IRS logbook + "which method is better" now in Reports, tax setup country-aware (AU GST/ABN·TFN; US EIN/SSN + estimated-tax freq).
- Recent UI: Mileage tab GPS/Add-trip controls at top above TODAY counter; History collapsible (tap header). Ledger History collapsible. Reports cards all have accent border; logbook card moved from Mileage to Reports. Home hero income/expenses on right.

### What to test now (both):
Backend (priority):
1. POST /api/ask country=AU: claimable question returns grounded ATO answer; out-of-scope question returns refusal; no crash.
2. POST /api/ask country=US: standard mileage / Schedule C question returns grounded IRS answer.
3. Existing endpoints still OK: GET /api/dashboard, /api/tax-mileage, /api/report (AU & US), /api/vehicles.
Frontend:
4. All 6 tabs load without error (Home, Mileage, Ledger, Reports, Ask, Profile).
5. Ask tab: type a question -> assistant replies; a suggestion chip works.
6. Profile > Help > User guide opens /manual; sections expand; mentions the Ask tab.
7. Mileage & Ledger: tapping History header expands the list.

## Consolidation — Ledger merged into new "Money" tab (added by main agent)
- Ledger tab REMOVED (app/(tabs)/expenses.tsx deleted). Home tab renamed to "Money" (wallet icon). Bottom tabs now: Money, Mileage, Reports, Ask, Profile (5).
- Money tab (app/(tabs)/home.tsx) rewritten: hero has a period segmented toggle testIDs money-period-today / money-period-fy / money-period-all. Net earnings + Income + Expenses recompute client-side for the selected period from api.listIncome/listExpenses/listTrips. FY is country-aware (AU Jul–Jun, US Jan–Dec); All-time = everything; Today = today only.
- Also on Money tab: quick-add (ledger-add-income / expense-add / expense-scan), expenses-by-category (period), Performance chart (last 4 weeks, period-independent), business-km tile (period) + recurring-owed tile (this quarter, from /api/dashboard), and collapsible History (ledger-history-toggle) filtered to the period with edit (tap row) + delete (ledger-del-*).
- No backend change; uses existing endpoints. No auth (login removed).

### What to test now (both):
Frontend (priority):
1. All 5 tabs load without red-screen: Money(/home), Mileage(/trips), Reports(/reports), Ask(/ask), Profile(/settings). Confirm there is NO Ledger tab.
2. Money tab period toggle: tap money-period-today / money-period-fy / money-period-all — hero label + Net/Income/Expenses update; History count line updates to the period.
3. Add an income and an expense via quick-add (entry flow); verify they appear in History (expand ledger-history-toggle) and Net updates; delete one via ledger-del-*.
4. Editing: tapping a history row opens /entry prefilled.
Backend regression:
5. GET /api/dashboard, /api/tax-mileage, /api/report, /api/vehicles, and POST /api/ask still return 200.
