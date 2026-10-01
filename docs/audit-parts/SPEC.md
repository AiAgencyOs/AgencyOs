# AgencyOS Business Phase 1–4 — forensic audit spec (MODE A: AUDIT ONLY)

This is the owner's brief, condensed faithfully. Repo: /home/user/AgencyOs (current `main`, squash 72d2ccc + docs). Read AGENTS.md first (this Next.js differs from what you know).

## Phase numbering (do NOT confuse with any "development roadmap" phases)
- BUSINESS PHASE 1 = LEAD-TO-CLOSE
- BUSINESS PHASE 2 = CLIENT ONBOARDING + M1 PAYMENT + OFFICIAL PROJECT KICK-OFF
- BUSINESS PHASE 3 = UI THEME + COLOR + SCREEN/UX DIRECTION FINALIZATION (NOT full UI)
- BUSINESS PHASE 4 = COMPLETE UI DESIGN + FIGMA + UI APPROVAL + FUNCTIONAL PROTOTYPE + PROTOTYPE QA + CLIENT APPROVAL + M2 FINANCIAL GATE

## MODE A rules (hard)
- AUDIT ONLY. No product-code changes, no migrations, no commits, no pushes. Write ONLY inside `docs/audit-parts/`.
- NO ASSUMPTIONS. A screen != working feature; an API route != backend flow; a table != workflow; a prompt != functional agent; a test file != passing test; a button != working action; a WhatsApp message != structured state change; client "yes" != formal approval; payment screenshot != verified payment; code written != production ready; a previous Claude status report is NOT truthful. VERIFY ACTUAL RUNTIME BEHAVIOR.
- Existing prior audit docs (docs/AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.md/.json from 2026-09-28 at commit aa9d59a, docs/phase1..3/*, docs/phase-4-*) are CLAIMS to check, not evidence. Much changed since (PRs #535, #536, ~390 migrations). Re-verify; where code and docs disagree record the conflict; if no safe resolution mark NEEDS_BUSINESS_CLARIFICATION. Notably re-check on current main: milestone position indexing (M1/M2 invoice generators), `finance.new_receipt_reference()` grant, design revision event subscribers, PM/agent assignment, lead routing.
- If code and docs disagree: do not silently choose; record the conflict.

## Principle
AgencyOS behaves like ONE coordinated professional agency (client sees one agency). Orchestrator -> specialised agents -> policy -> backend -> admin -> structured records. Only the appropriate conversational owner talks to the client at each stage. AI recommends; backend policy decides. Agent-to-agent messages are DATA, not authorization. Payment proof != verified payment. WhatsApp = channel, not source of truth.

## Agent capabilities to look for (reuse equivalent existing names; do not demand duplicates)
Sales Agent (Phase 1 owner; senior, ethical, commercially intelligent; NOT an FAQ bot) · Quotation Master (specialist; versioned quotes; must not invent discount/offer/tax/exception) · Orchestrator (routes; never overrides policy, invents prices, verifies payment, approves itself) · Policy Engine (deterministic: pricing/discount/offer/payment-terms/trust/follow-up/approval/scope/revision/finance exceptions) · Admin (human authority for governed exceptions only) · WhatsApp/Communication (webhook→dedupe→identity→language→intent→context→agent routing→delivery→delivery state→audit) · Finance Agent (invoice, instructions, submission, verification packet, tracking, receipt, milestone gate) · PM Agent (Phase 2+ operational owner) · Requirements/Scope capability · UI Designer · UI/Design QA · Prototype Agent · Prototype QA · Automation/Job system (follow-ups, reminders, retry, dead letter, escalation) · Memory/Context (sales knowledge survives into Phase 2).

## Row schema (EVERY step needs exactly one row object; JSON keys exactly these)
phase, step_id (e.g. "1.7"), step_name, business_trigger, primary_agent, supporting_agents, expected_frontend, expected_backend, expected_database, expected_api, expected_events_jobs, expected_admin_control, expected_state_transition, existing_files (array of repo paths, with line refs where useful), existing_routes (array), existing_tables (array, schema.table), existing_tests (array of test file names, each marked [behavioral] or [static-regex] or [live-db]), runtime_evidence (what you actually ran/observed: command + result excerpt, or "none"), implementation_status, verification_status, test_status, production_readiness, security_status, data_integrity_status, known_bug, blocker, dependency, risk, required_fix, validation_method, notes.

Allowed values:
- implementation_status: COMPLETE | PARTIAL | MISSING | BROKEN | MOCKED | OUTDATED | UNKNOWN | NEEDS_REVIEW (add NEEDS_BUSINESS_CLARIFICATION in `notes`/`blocker` when applicable)
- verification_status: VERIFIED (actual code path traced AND runtime/test evidence confirms) | NOT_VERIFIED
- test_status: PASSED | FAILED | NOT_RUN | BLOCKED | PARTIAL
- production_readiness: PRODUCTION_READY | NOT_PRODUCTION_READY. PRODUCTION_READY only if: functional, verified, tested, security valid, tenant isolation valid, error path tested, no production mock, observability adequate, required audit exists, required E2E path passes.
- security_status: OK | RISK | BLOCKED | UNKNOWN ; data_integrity_status: OK | RISK | BROKEN | UNKNOWN

NO FALSE GREEN: UI exists but API broken -> PARTIAL. API works but no permission protection -> PARTIAL/security RISK. Agent prompt exists but not runtime-integrated -> MOCKED/PARTIAL. Backend exists but tests not run -> NOT_VERIFIED + NOT_PRODUCTION_READY. Test exists but skipped -> NOT_RUN. Mock passes but real integration untested -> PARTIAL. Never mark green to look good. A "static-regex" test (readFileSync of source/migration + regex) proves the text exists, NOT behavior: it never justifies VERIFIED/PASSED-as-behavior by itself.

## How to verify (use what exists; you may RUN things)
- Unit tests (Node 26): `export PATH=/root/.npm/_npx/bac97da9607b7ef2/node_modules/node/bin:$PATH; cd /home/user/AgencyOs; node --conditions=react-server --import ./tests/_alias.mjs --experimental-test-module-mocks --disable-warning=ExperimentalWarning --test tests/<file>.test.ts` — classify each test file you cite as behavioral vs static by reading it.
- Live DB verifiers: `npm run db:verify:<name>` (see package.json). Local Postgres db `agencyos_local` at /tmp/pg/agencyos-pg.bwOBOh port 55432 (psql -h /tmp/pg/agencyos-pg.bwOBOh -p 55432 -U postgres -d agencyos_local). The DB is long-lived and dirty; some verifiers fail locally for reasons unrelated to you (they pass on CI's fresh DB). Several agents work at the same time: RUN EVERY live verifier through a lock: `flock /tmp/verify.lock npm run -s db:verify:<name>`. Read-only SELECTs need no lock. Never delete data; never `pkill -f`.
- Dev server is already running at http://127.0.0.1:3000 (use `curl --noproxy '*'`). Do NOT start another dev server. Login as owner for browser-style checks: GET /auth/callback?token_hash=login:owner@local.test&type=magiclink&next=/ (see /tmp/pg/sweep.mjs for a Playwright pattern; chromium at /opt/pw-browsers/chromium-1194/chrome-linux/chrome). Other seeded users: finance@local.test, contractor@local.test (and owner, ops admin etc. — check auth.users).
- Real AI providers and WhatsApp are NOT configured locally: a flow that needs them can be traced in code and exercised with the repo's own fakes, but record "real integration not tested" honestly (PARTIAL / NOT production ready).
- Trace with Grep/Read: agents in `ai.agents` (migrations seed them), prompts under src/lib/ai or src/modules/*/prompts, tools registry, jobs runner app/api/jobs/run/route.ts, event catalog src/lib/events/catalog.ts, handlers, services under src/modules/*, admin pages under app/(internal)/*, supabase/migrations/*.

## Deliverables per agent (write inside docs/audit-parts/)
1. `<name>.json` — a JSON array of row objects (schema above). Validate with `node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`.
2. `<name>.md` — (a) a table: step_id | step | implementation | verification | test | production | blocker/key note; (b) FINDINGS sections: critical blockers; major missing flows; broken flows; mock-only flows; untested flows; security risks; data risks; agent gaps; admin gaps; WhatsApp gaps; finance gaps; UI/prototype gaps; NEEDS_BUSINESS_CLARIFICATION items; doc-vs-code conflicts; stale/incorrect claims in the 2026-09-28 audit. Every finding cites file:line or a command result.
3. Final chat report (short): row count, counts per implementation_status, top blockers, anything you could not verify and why.

## Steps (each step = one row; also add one extra row "N.GATE" evaluating that phase's production-ready/exit gate, and for Phase 1 one row "1.EXIT" covering exit routes A WON->Phase 2, B FOLLOW_UP, C NURTURE, D LOST+win-back)

### PHASE 1 — LEAD-TO-CLOSE (objective: new lead -> trusted conversation -> qualified -> confirmed requirements -> approved proposal -> controlled negotiation -> acceptance -> WON | follow-up/nurture | lost + win-back)
1.1 Lead arrives (sources: Facebook lead form, Instagram, direct WhatsApp, website, referral, manual admin, existing client, other configured; backend creates inbound event capturing source, campaign, ad, phone, email, name, message, timestamp, metadata; appears in Admin Leads queue; agent does not blind-pitch)
1.2 Normalize + deduplicate (normalize phone/email/name/source; search active lead, existing client, lost lead, previous enquiry, repeat client; outcomes NEW_IDENTITY, EXISTING_LEAD, EXISTING_CLIENT, REACTIVATED_LEAD, POSSIBLE_DUPLICATE_REVIEW; never auto-merge uncertain identities; preserve history)
1.3 Assign Sales Agent (routing may consider service, source, language, availability, priority, region, existing relationship, admin rules; Sales Agent becomes primary Phase 1 owner)
1.4 Language + communication style (Hindi/English/Hinglish/other; preserve natural style; not robotic; name used naturally, not every sentence)
1.5 First response (relationship/comfort/understanding first, NOT a package; greet, acknowledge, understand why they contacted; one useful question at a time)
1.6 Relationship building (respectful, patient, warm, non-pushy; no false friendship)
1.7 Lead intent identification (service enquiry, price enquiry, project requirement, comparison, trust concern, existing project, repeat project, support/non-sales, spam; route non-sales correctly)
1.8 Initial qualification (what/why/problem/who for/platform/stage/existing system/timeline/urgency/decision-maker/budget/agency experience/bad past experience/what matters; do not re-ask known answers)
1.9 Qualification score/priority (need clarity, budget fit, timeline fit, decision-maker, feasibility, urgency, engagement, trust readiness, service fit, commercial potential; for prioritization only, never to disrespect low score)
1.10 Deep requirement discovery (goal, problem, roles, features, platform, integrations, admin needs, design refs, existing system, tech constraints, delivery expectation, optional, future; stored structured)
1.11 Requirement classification (CONFIRMED, ASSUMPTION, UNANSWERED, OPTIONAL, NICE_TO_HAVE, EXCLUDED, REFERENCE, TECHNICAL_CONSTRAINT; assumptions never mixed with confirmed)
1.12 Requirement summary + versioning (client can say YES / CORRECT / ADD / REMOVE; confirmed requirements get a version; quotation references exact version)
1.13 Trust signal detection (record exact concern: "how do I trust you", "bad experience", "show work first", "no advance", "prototype first", ...)
1.14 Trust building (approved portfolio/case study/demo/process/milestones/approvals/payment gate/prototype structure/support/agency info; no unsupported guarantees)
1.15 Commercial strategy before quote (budget range, ideal timeline, must-have vs optional, flexibility, commercial sensitivity)
1.16 Quotation request to Quotation Master (structured handoff: lead/client, requirement_version, project type, must-haves, optional scope, platforms, integrations, timeline, pricing context, budget context, trust context, payment preferences)
1.17 Quotation Master (quote has client, summary, scope, deliverables, timeline, price, tax as configured, payment milestones, validity, terms, next step, version; uses approved pricing/discount/offer/payment rules)
1.18 Quote policy check (price range, margin where configured, discount, offer, payment structure, minimum advance, timeline promises, exceptions; AUTO_APPROVED | ADMIN_APPROVAL_REQUIRED | BLOCKED)
1.19 Admin commercial approval (admin sees client, project, requirements, quote version, price, discount, payment plan, exception, reason, risk; APPROVE/REJECT/REQUEST_CHANGE attached to exact quote version)
1.20 Quote delivery (Sales Agent explains value/timeline/payment/next step, not just a PDF; track sent time, channel, delivery, read)
1.21 Post-quote follow-up (contextual, not "any update?" spam; clarification, feature explanation, budget/decision/trust concern, real offer expiry; respect opt-out; stop redundancy after response)
1.22 Objection diagnosis (PRICE, BUDGET, VALUE_NOT_CLEAR, TRUST, TIMELINE, FEATURE_MISSING, PAYMENT_STRUCTURE, COMPETITOR, DECISION_DELAY, INTERNAL_APPROVAL, NOT_READY; not every objection is price)
1.23 Price objection (understand comfortable budget first; solve via scope optimisation, phase-wise delivery, payment structure, optional removal, approved package/offer/discount/extra value; do not cut price immediately)
1.24 Value negotiation (explain why feature exists, benefit, quality/process, support, milestone safety, included work, savings; no pressure)
1.25 Scope-based negotiation (e.g. budget 50k vs quote 60k: keep scope/structured payment; remove low-priority features; phase features; approved package/offer; admin-approved exception; never promise hidden free work)
1.26 Approved extra value (only if catalog/policy permits, cost/timeline impact ok, scope explicit, offer versioned, commercial record updated; never invent extras)
1.27 Discount (only approved autonomous limit; above threshold -> Admin; record original amount, discount, reason, approved by, expiry, final amount; never because lead repeatedly asks)
1.28 Payment structure negotiation (only approved structures: standard milestone, lower advance, prototype-first, split, deferral, other configured; exceptions via policy/Admin)
1.29 Feature objection (already-confirmed requirement missing -> correct quote; new requirement -> new scope/negotiation item; never quietly add free scope)
1.30 Timeline objection (check real feasibility; scope reduction, phased delivery, resources, approved expedite; never promise impossible timeline)
1.31 Trust objection (evidence, process, milestones, versioned approvals, prototype structure, approved trust offer; not uncontrolled discounts)
1.32 Negotiation loop (each round stores client request, objection, agency response, quote version, discount, offer, payment term, admin approval, client response, next action; configured limits; no endless loop)
1.33 Quote revision (material change: V1 -> V2; never overwrite V1; track what changed; client accepts exact version)
1.34 Lead ghosts (not immediately LOST; intelligent follow-up using last context, stage, objection, engagement, policy, time)
1.35 Follow-up engine (context-sensitive schedule: quotation reminder, clarification, trust evidence, decision check, offer expiry, budget alternative, timeline availability; frequency limits, business hours, opt-out, previous response)
1.36 Nurture (reason: budget later, project later, decision-maker pending, funding pending, trust not ready, timing; store nurture reason, next follow-up date, future trigger; no spam)
1.37 Lost (structured reason: price, no budget, competitor, postponed, no response, not fit, requirements changed, trust, timeline, cancelled, other; store evidence/context)
1.38 Lost-lead win-back (reason-based later attempt if policy permits; never repeat-chase opted-out leads)
1.39 Closing signal (detect ready/asks payment method/asks start date/confirms quote/agrees scope/terms; move from persuasion to exact confirmation)
1.40 Structured acceptance (client confirms exact quote version, scope, price, payment plan, terms; generic "okay"/"looks fine" is not final acceptance)
1.41 Won (WON = commercially valid conversion per policy; WON != payment verified; preserve sales history, conversation, requirements, quotation, negotiation, objections, approvals, expectations)
1.42 Sales handoff package (client identity, contacts, language, style/preferences, requirement version, accepted quote version, commercial terms, payment plan, trust concerns, objections, special approvals, promises actually approved, timeline expectation, assets/references, stakeholders, open questions, risk flags; client must not repeat the sales conversation)
1.EXIT exit routes A WON->Phase 2, B FOLLOW_UP stays Phase 1, C NURTURE scheduled, D LOST historical + win-back
1.GATE Phase 1 production-ready gate: lead enters; Sales Agent communicates; requirements persist; quotation works; negotiation works; follow-up works; policy works; admin exception works; acceptance structured; lost/nurture works; handoff complete; audit exists; no critical mocks; E2E tests pass.

Sales Agent quality checklist (audit separately as a table, not step rows): remembers context & uses name naturally; asks intelligent non-redundant questions; adapts to lead type; builds trust; explains value; discovers requirements & budget; detects decision readiness; handles objections; negotiates; uses approved offers/discounts/payment structures; reshapes scope; follows up intelligently; recovers ghosted leads; nurtures; ethical win-back; knows when to stop; escalates. MUST NOT: lie, fake scarcity, fake friendship, pressure vulnerable leads, invent testimonials/portfolio/discounts, promise impossible delivery, offer unauthorized free work, ignore opt-out, spam, silently change commercial terms. Conversation memory should retain structured facts (name, business, project, pain points, goals, requirements, budget, timeline, decision-maker, trust concerns, objections, previous answers, quote versions, offers, approved discount, payment preference, next action, follow-up date) with source evidence. Internal reasoning must not be exposed; store only structured outcomes (lead_stage, intent, qualification, requirements, objection_type, trust_signal, next_best_action, follow_up_at, quote_version, approved_offer, approval_needed). Handoffs must carry: task ID, organization, client/project, source phase, destination agent, exact context, version refs, required action, permissions, policy status, known blockers, completion evidence, correlation ID.

### PHASE 2 — CLIENT ONBOARDING + M1 PAYMENT + OFFICIAL KICK-OFF (trigger: Phase 1 = WON; primary PM Agent + Finance Agent)
2.1 Receive sales handoff (PM receives structured package; does not re-ask the client everything)
2.2 Client identity validation (existing client, duplicate identity, contacts, billing details, GST/tax details, communication preference; create/reuse durable client record)
2.3 Onboarding record (client, project name/type, accepted quote, requirements, payment plan, start conditions, target dates, stakeholders, required assets, credential/access requirements, PM, specialist agents, status)
2.4 Commercial baseline validation (accepted quote version, price, scope, discount, payment plan, approved exception; no silent change)
2.5 M1 finance trigger (from accepted baseline; default M1 = 30% advance unless configured/approved exception)
2.6 GST / non-GST context (finance checks configured billing/tax mode; never guess tax)
2.7 M1 invoice (references client, project/onboarding, accepted quote, M1, amount, tax config, payment instructions, due date)
2.8 Invoice communication (send via approved WhatsApp/email/portal; sales/PM do not invent account details)
2.9 Client payment submission (UTR/reference/screenshot/gateway -> PENDING_VERIFICATION; never paid from screenshot/message alone)
2.10 Payment verification (Finance prepares; Admin/authorised Finance verifies; VERIFIED, REJECTED, NEEDS_MORE_INFO, PARTIAL, MISMATCH, DUPLICATE)
2.11 Project start gate (official start requires M1 verified OR exact approved payment exception; else WAITING_FOR_PAYMENT/BLOCKED)
2.12 Project record / workspace (authoritative project linked to client, quote, requirements, scope, payment plan, PM, members, agents, documents, communication)
2.13 Project manager assignment (PM becomes primary client-facing owner; Sales no longer drives ordinary project comms)
2.14 Specialist agent assignment (UI, Prototype, Developer later, QA later, Finance, Support; no unrestricted access for all agents)
2.15 WhatsApp project group (create/link; store provider group ID, project mapping, authorised participants; PM owner)
2.16 Asset collection (logo, brand colors/guide, references, existing app/site, content, credentials, API access, domain/hosting, legal text; each REQUIRED/REQUESTED/RECEIVED/VALIDATED/MISSING)
2.17 Secure access / credential collection (no secrets in normal WhatsApp text when a secure mechanism exists)
2.18 Requirements import (import confirmed Sales requirements with version/reference; not a lossy paragraph)
2.19 Initial scope baseline (included/excluded/optional/future)
2.20 Timeline / milestones (operational status and financial status stay separate)
2.21 Onboarding checklist (client identity, accepted quote, terms, M1/exception, project name, requirements, scope, timeline assumptions, stakeholders, assets, brand refs, technical access, WhatsApp group, PM, specialist agents)
2.22 Kickoff package (project officially started, what is approved, current phase, what next, what client provides, communication method, next review milestone)
2.23 Official kickoff (send via approved channel; project event; project -> ACTIVE / PHASE_3_READY per actual state model)
2.GATE Phase 2 exit gate: client valid; commercial baseline valid; payment condition satisfied; project exists; PM assigned; group mapped; requirements imported; scope exists; assets/access tracked; kickoff completed; audit exists.

### PHASE 3 — UI THEME + COLOR + SCREEN/UX DIRECTION (NOT complete UI design; locks direction before Phase 4; primary PM + UI Designer)
3.1 UI input package (scope, requirements, platform, roles, business flows, brand assets, references, technical constraints, accessibility, device requirements, timeline; missing info = BLOCKER not imagination)
3.2 Screen inventory (every required screen: Screen ID, name, role, purpose, requirements, entry, exit, data, actions)
3.3 Screen content definition (what each screen must contain before UI)
3.4 User flow map (primary, alternate, edge cases, permissions, navigation, success, failure)
3.5 UI/UX direction (industry, audience, platform, brand, desired personality, references)
3.6 Theme options (2-3 genuinely useful directions, all with SAME functional scope; no hiding/adding features between options)
3.7 Color options (2-3 combinations tied to directions; accessibility/contrast checked)
3.8 Design tokens preview (colors, typography, spacing, radius, shadow/elevation, icons, buttons, inputs, cards, navigation per direction)
3.9 Internal design review (UI QA/PM: scope mapping, screen completeness, consistency, brand fit, practicality, accessibility direction)
3.10 Admin review (exact options/version; APPROVE_FOR_CLIENT / REQUEST_CHANGE / REJECT)
3.11 Client presentation (PM presents; UI agent does not overwhelm the client)
3.12 Client feedback (classify: visual preference, color, layout direction, clarification, new scope, requirement correction; new functionality does not silently enter UI scope)
3.13 Revision (next design-direction version; preserve old options/history)
3.14 Client selection (record exact theme, color, direction, version, client identity, timestamp/evidence)
3.15 Final UI direction lock (CLIENT_APPROVED_UI_DIRECTION or equivalent state; becomes Phase 4 input)
3.GATE Phase 3 exit gate: screen inventory; screen contents; user flows; theme; color; design-system direction; admin review; client selection; exact version; audit.

### PHASE 4 — FULL UI + FIGMA + FUNCTIONAL PROTOTYPE + M2 (primary UI Designer, PM, Prototype Agent; supporting UI QA, Prototype QA, Requirements, Admin, Finance, Client, Orchestrator)
4.1 Load locked baseline (approved scope, requirements, Phase 3 direction, screen inventory, design tokens; no redesign from scratch)
4.2 Figma-first rule (actual detailed Figma/approved design artifacts per current AgencyOS architecture; random generated images are not the source of truth; approved artifact/version is)
4.3 Design system (colour tokens, typography, spacing, radius, elevation, icons, buttons, inputs, forms, cards, tables, modals, navigation, feedback states)
4.4 Full screen design (every scoped screen; no mandatory screen missing)
4.5 Screen states (default, hover/focus, pressed, disabled, loading, empty, validation error, system error, success, permission denied, offline/network, long content/overflow)
4.6 Responsive (desktop, tablet, mobile per project platform/scope)
4.7 Accessibility (contrast, labels, focus, keyboard, touch targets, semantic hierarchy, reduced motion, screen-reader handoff)
4.8 Feature coverage matrix (REQUIREMENT -> FEATURE -> SCREEN -> INTERACTION -> DESIGN STATE -> PROTOTYPE COVERAGE; flag unmapped feature, orphan screen, missing role, missing state)
4.9 Internal UI QA (all screens/features/states/responsive/tokens/navigation/naming-versioning/assets/placeholders/visual defects)
4.10 PM / Admin approval (exact UI version; store version, scope version, screen coverage, known limitations, decision, evidence)
4.11 Client UI review (PM sends exact UI version; client reviews screens, flows, theme, colors, contents, experience)
4.12 Client feedback classification (BUG/CORRECTION, INCLUDED_REVISION, CLARIFICATION, SCOPE_CHANGE, DESIGN_DIRECTION_CHANGE, REJECTED_REQUEST; new feature != design correction)
4.13 UI revision loop (next UI version; preserve previous version, feedback, changes, revision usage, approval state; repeat QA)
4.14 Client UI approval (exact UI_VERSION_X_APPROVED with client, timestamp, evidence; prototype source of truth)
4.15 Prototype task (PM hands Prototype Agent: approved UI version, scope, critical flows, platform, interaction expectations)
4.16 Prototype generation (functional WEB and/or APK per project type; represents approved UI; no random divergence)
4.17 Prototype interactions (critical flows actually work: navigation, forms/interactions, buttons, back behavior, main journey, responsive)
4.18 Prototype version (immutable/traceable PROTOTYPE_VX linked to UI_VERSION_X)
4.19 Prototype QA (smoke, navigation, critical flows, broken routes, screen coverage, visual consistency, basic responsiveness, runtime errors; fix and retest)
4.20 Admin approval (Admin/PM approves exact prototype build/version before client release where configured)
4.21 Client prototype review (exact APK / web preview / approved access)
4.22 Client prototype feedback (classify again; no silent backend/product scope)
4.23 Prototype revision (update UI if required, prototype, version, QA; preserve history)
4.24 Client prototype approval (exact PROTOTYPE_VERSION_X_APPROVED with client/evidence/timestamp)
4.25 M2 finance trigger (standard locked flow: M2 = 20% after UI/prototype milestone; PM confirms operational milestone completion; Finance creates invoice from commercial baseline)
4.26 M2 payment (invoice -> submission -> PENDING_VERIFICATION -> Admin/authorised Finance verification -> VERIFIED; prototype approval != financial payment)
4.27 Development handoff package (approved scope version, requirements, approved UI version, screen inventory, design system, Figma/design refs, approved prototype version, prototype access/build, revision history, known limitations, client approvals, M2 financial gate, development constraints)
4.GATE Phase 4 exit gate: UI complete; UI QA pass; admin approval; client UI approval; prototype generated; prototype QA pass; admin approval; client prototype approval; M2 financial condition satisfied; development handoff complete; audit/history complete.

## Admin / real-time expectations (cross-cutting; note in rows where relevant)
Every major Phase 1-4 workflow should be observable/manageable in Admin: Lead 360, sales conversations, requirements, qualification, quote versions, negotiation, offers, discount approvals, follow-ups, lost reason, win-back, client, onboarding, M1 invoice/payment, project, agents, assets, scope, UI versions, theme options, client feedback, prototype versions, M2 payment, approvals, events/jobs, audit. Business config should not be unnecessarily hardcoded. Live status must be authoritative (command -> backend validation -> authoritative state -> UI update; no success shown before backend authority).

## PERSIST AS YOU GO (the container can restart and kill you without warning)
- Create your `<name>.json` and `<name>.md` within your first few minutes and append/rewrite them after EVERY step you finish (write the row as soon as the step is done, not at the end). Keep the JSON valid after each write (rewrite the whole array from your in-memory list, or keep one row per line in `<name>.rows.jsonl` and convert to `<name>.json` at the end).
- If you are restarted, first read your own partial files and CONTINUE from the first missing step; never redo finished rows.
- The local stack may need restoring after a restart: `bash /tmp/pg/ensure.sh` (Postgres/PostgREST/gateway). Do NOT start `next dev` yourself (the parent does); check `curl --noproxy '*' -m 5 http://127.0.0.1:3000/login`.
