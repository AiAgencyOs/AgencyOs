# Phase 3 — requirement traceability and gap matrix

**UI Theme + Color Combination Finalization.** Written from reading the three
locked Phase 3 PDFs completely and then reading this repository, in that order.

Sources, and the precedence rule the mandate sets — **the Phase 3 PDFs win over
older general specifications** where they genuinely differ:

| # | Document | Pages |
| --- | --- | --- |
| Master | `AgencyOS_Phase_3_UI_Theme_Color_Finalization_Master_Flow_Implementation_Plan_Checklist.pdf` | 18 |
| Designer | `AgencyOS_Phase_3_UI_Designer_Agent_Responsibilities_Implementation_Specification.pdf` | 20 |
| PM | `AgencyOS_Phase_3_PM_Agent_Responsibilities_Implementation_Specification.pdf` | 18 |

Status vocabulary, as the mandate defines it: `EXISTS` means the repository
already does it; `PARTIAL` means a real implementation exists and does not yet
meet the locked requirement; `MISSING` means nothing does it; `CONFLICTING`
means the repository and the specification disagree and the disagreement is
named below; `MANUAL` means it cannot be automated on this deployment and the
honest step is exposed rather than faked.

---

## 0. The three findings that shape everything else

**1. There is no Figma integration in this repository at all.** A repository-wide
search for `figma` returns exactly one hit: a comment in
`20260813120001_deliverables.sql` observing that an artifact link is better than
a blob because *"an APK or a Figma file has a home already."* No client, no
token, no API call, no provider entry.

Master §20 and Designer §24 both anticipate this and say what to do:

> *"If fully automated Figma creation is not supported by the chosen
> integration, expose the exact manual/assisted step instead of faking
> success."*

That is **CASE C** in the mandate's own three-case framing, and it is what this
phase implements. Nothing here will claim a Figma file was created.

**2. The screen inventory already exists, and so does the UI Designer Agent.**
`projects.screens` (from `20260821230000_attractive_but_incomplete.sql`) is
substantially Master §13's ScreenDefinition contract, and it is already produced
by a *running* agent workflow — `ui_designer:screenInventory`, job kind
`ui.inventory`, subscribed to `scope.frozen`, with the schema in
`projects/schema.ts` and the workflow in `app/api/jobs/run/workflows.ts`. It
already refuses to map a screen to an excluded scope item, refuses a design
entering review while an included item has no screen, and refuses two screens
claiming one id. Phase 3 **extends** this. Building a second screen model would
be the duplication the mandate forbids.

**3. Phase 2 already emits the entry event, into nothing.**
`project.phase_three_ready` is declared in `core.event_types` and emitted by
`projects.record_kickoff` (G-258), with **no subscriber** — recorded at the time
as deliberate, *"exactly as Phase 1 emitted `opportunity.handed_off` with no
receiver until Phase 2 existed."* Phase 3 is that receiver.

---

## A. Entry — Phase 2 → Phase 3 handoff

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| Phase 2 complete gates Phase 3 start | Master §3, PM §2 | **EXISTS** | `projects.phase_two.state = 'completed'`, set by `record_kickoff` | Nothing consumes it |
| `Phase2Completed` event | Master §15 | **EXISTS**, named `project.phase_two_completed` | `core.event_types`, emitted by `record_kickoff` | Name differs; the event is the thing |
| `Phase3Started` / a receiver | Master §15, PM PM3-01 | **EXISTS** (G-277) | `projects:startPhaseThree` subscribes to `project.phase_three_ready` and drains as `phase_three.start` | The event had no subscriber when this matrix was written |
| Official kickoff occurred | Master §3 | **EXISTS** | `record_kickoff` requires an evidence reference (G-258, G-263) | — |
| Accepted quotation + approved scope available | Master §3 | **EXISTS** | `sales.proposals`, `projects.scope_versions`, `scope_items` | — |
| Project Planning output available | Master §3, §9 | **EXISTS** | `projects.project_plans` + registers (G-256…G-265), surfaced by G-274 | — |
| PM Agent assigned | Master §3 | **EXISTS** | `projects.phase_two.pm_agent_key` | Phase 3 needs its own owner column |
| Not already started for same project/version | Master §3, PM §2 | **EXISTS** (G-277) | `phase_three.project_id` is UNIQUE; a replay gets `already_started` and the existing id | Phase 2's pattern, copied |
| Context reusable without re-asking the client | Master §3, PM §4.2 | **EXISTS** | `resolveProjectContext` + `onboarding-context.ts` (G-252, reachable since G-276) | Phase 3 must consume, not duplicate |

## B. Phase 3 domain and state

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| `Phase3Workspace` | Master §19 | **EXISTS** (G-277) | `projects.phase_three` — state, owner agents, reviewer, blockers, revision count | Mirrors `projects.phase_two` |
| Phase 3 state machine (11 states) | Master §14 | **EXISTS** (G-277) | 18 states including both escalations, each unenterable without a reason | §14's list plus the waiting and escalation states §16–§17 require |
| `ScreenDefinition` | Master §13 | **EXISTS** (G-278) | `projects.screens` + `required_sections`, `dependencies`, `baseline_version` | Extended, not rebuilt. Evidence is the scope mapping `screen_scope_items` already carries |
| Screen status vocabulary | Master §13, §14 | **EXISTS** (G-278) | `draft / in_review / approved / superseded / blocked` | Resolved per **D-1**: `blocked` added, `finalized` expressed by the baseline version rather than by overloading a column the coverage trigger reads |
| `ThemeOption` | Master §11, Designer §12 | **EXISTS** (G-279) | `projects.theme_options` — every §11 field, three separate gate statuses | — |
| `ColorOption` | Master §12, Designer §13 | **EXISTS** (G-279) | `projects.color_options` — named validated hex tokens | — |
| `DesignTokenSet` | Designer §23 | **EXISTS** (G-295) | `projects.design_token_sets` — §4.5's primitives as named columns, no jsonb; colour stays in `color_options` | Still not `src/ui/tokens.ts`, which is AgencyOS's own product theme (D-3) |
| `RepresentativeScreen` | Designer §7, §23 | **EXISTS** (G-292) | `projects.representative_screens` — screen link NOT NULL and refused unless `approved`, theme link, Figma node or preview | §17 is what makes the link mandatory |
| `DesignJob` | Designer §23 | **PARTIAL** | `core.jobs` + `ai.agent_runs` carry status, idempotency, retries | No design-specific context version / artifact link |
| `DesignReview` (internal) | Master §19 | **EXISTS** (G-280) | `projects.design_reviews` — passed/changes_required, named reviewer, required comments | Distinct from `approvals`: internal-only, and it precedes Admin |
| `AdminDesignDecision` | Master §19 | **PARTIAL** | `approvals.approval_requests` has subject/state/decider/reason/evidence | `subject_type` is a closed list and has no design member |
| `ClientDesignShare` | Master §19, PM §14 | **EXISTS** (G-282) | `projects.client_design_shares` with channel, evidence and thread | It records a send; it does not send |
| `ClientDesignDecision` | Master §19, PM §12 | **EXISTS** (G-283) | `projects.client_design_decisions` — all six, the client's words required on each, never editable | A correction is a new record |
| `DesignRevision` | Master §19 | **EXISTS** (G-284) | `projects.design_revisions` — origin, from/to version, requested changes, status, frozen round number | The request, not the drawing |
| `Phase3Handoff` | Master §19 | **EXISTS** (G-285) | `projects.phase_three_handoffs` — frozen payload, readiness flag, approval evidence | `ai.handoffs` is the Phase 1→2 pattern |
| `UsageRecord` | Master §19, Designer §23 | **EXISTS** (G-297) | `ai.agent_runs` gains `project_id` and `phase`, derived from the subject and backfilled | Phase set only where unambiguous |
| `AuditEvent` | Master §19 | **EXISTS** | `audit.audit_log`, `core.record_audit`, append-only by trigger | — |

## C. The design work itself

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| UI Designer Agent exists | Designer §1 | **EXISTS** | `ui_designer` in `src/modules/agents/registry.ts` — L2, `mayVerify: false`, `moneyAuthority: 'none'` | Its only workflow is `ui.inventory` |
| Designer reads approved scope, never invents | Designer §4.1, §17 | **EXISTS** | `ui.inventory` is shown only `included`/`optional` items; the row rule refuses an excluded mapping | Extends to theme work |
| 2–3 meaningful theme directions | Master §7.5, Designer §4.2 | **EXISTS** (G-279) | `enforce_theme_option_ceiling` trigger + configurable `theme_option_limit` | Enforced at the row, per design context |
| 2–3 color combinations per direction | Master §7.6, Designer §4.3 | **EXISTS** (G-279) | `projects.color_options`, idempotent per (theme, index) | Tokens, not swatches |
| Figma-native artifacts | Master §5, Designer §4.4, §8 | **MANUAL** | — | **No integration exists.** CASE C: store refs, expose the step |
| Figma refs stored (file/page/node/version) | Master §20, Designer §24 | **EXISTS** (G-279) | `theme_options.figma_*` + `link_theme_figma` | A **half** reference is refused; `figma_linked_by` records who pasted it |
| Preview assets as *secondary* artifacts | Master §5, Designer §8 | **EXISTS** (G-279) | `preview_asset_url` beside the Figma columns; `theme_options_figma_is_whole` refuses a half-filled reference | A preview satisfies *something to show*, never the canonical artifact |
| Representative screens map to real screens | Designer §7, §17 | **EXISTS** (G-292) | NOT NULL FK, `on delete restrict`, and the door refuses a screen that is not approved | A sample mapping to nothing is the invention §17 forbids |
| Design-system primitives, Phase 3 level only | Designer §4.5 | **EXISTS** (G-295) | the boundary is the schema having nowhere to cross it — a column per primitive, closed vocabularies, no free-form structure | Explicitly *not* a full production system |
| Image generation optional, never canonical | Master §5, Designer §9 | **MISSING** | — | No image provider configured either |

## D. The three gates, in order

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| Gate order Designer → Internal → Admin → PM → Client | Master §16, PM §7 | **EXISTS** (G-280, G-282, G-287) | both halves refuse, and both gates now have a surface a person can use | Structural, and exercisable |
| Internal design review, PASS / CHANGES_REQUIRED | Master §7.7, Designer §14 | **EXISTS** (G-280) | `projects.design_reviews` + `submit_internal_design_review` | Only the **assigned** reviewer may run it |
| Internal PASS required before Admin | Master §16 | **EXISTS** (G-280) | `not_internally_passed` | The refusal the whole phase order rests on |
| Admin CONFIRM / EDIT with structured reason | Master §7.8, Designer §15 | **PARTIAL** | `approvals` has decide/reject with `decision_note` | EDIT is not reject: it returns for revision |
| Admin EDIT re-enters internal review | Master §16, PM §8 | **EXISTS** (G-280) | an edit sets `internal_review_status = 'changes_required'` too | *"Never skip internal re-review"* |
| Only Admin-approved options reach the client | Master §7.9, PM §4.4, PM3-I06 | **EXISTS** (G-282) | `record_design_share` refuses any option not Admin-approved, and names it | Deterministic, at the door |
| Designer cannot mark Admin approval | Designer §5, Master §21 | **PARTIAL** | Registry: `mayVerify: false`, `selfAssertionAllowed: false` (typed as the literal) | Needs the same structural refusal for design gates |
| PM cannot mark Admin approval | PM §5, §19 | **EXISTS** (G-280) | `core.is_admin()` on the Admin door | Reuses `project.sign_off`'s role set, which excludes delivery_lead by design |

## E. Client loop

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| PM announces Phase 3 | Master §7.1, PM §4.1 | **PARTIAL** (G-290, G-291) | the wording renders and is shown on the design page, ready to copy | It renders; a person still sends it (BLK-003, BLK-007) |
| Client messaging templates configurable | Master §25, PM §11 | **EXISTS** (G-290) | `projects.design_message_templates` overrides §11's four defaults, per language; §10's wording prohibitions refused at the row | Distinct from `crm.whatsapp_templates`, which is Meta's registry and holds no body |
| Record exactly which options were shared | Master §8, PM §4.4, §13 | **EXISTS** (G-282) | `projects.client_design_shares` — a frozen snapshot, numbered per round | *"without reading WhatsApp manually"* |
| Six client decision classifications | PM §12 | **EXISTS** (G-283) | `record_client_design_decision` — the six and no seventh, refused as `bad_decision` | `CLIENT_SELECTED`, `DESIGN_CHANGE_REQUEST`, `CLIENT_REFERENCE`, `POSSIBLE_SCOPE_CHANGE`, `CLARIFICATION_REQUIRED`, `FINAL_CONFIRMED` |
| Original client message preserved as evidence | Master §8, PM §4.5 | **EXISTS** | `crm.conversation_messages` is append-only | Needs linking |
| Client reference attachments | PM §4.5, §12 | **PARTIAL** (G-283) | `client_reference` carries a URL or a note, refused if it carries neither | No binary upload path yet |
| 2–3 client revision rounds, configurable | Master §7.10, §16, PM §4.7 | **EXISTS** (G-284) | `open_design_revision` moves `client_revision_count` **only** for client rounds, against a per-project `client_revision_limit` | An internal round must not cost the client one |
| Revision-limit escalation | Master §16, PM §4.8 | **EXISTS** (G-284) | passing the limit is a **state transition**: the phase stops in `revision_limit_escalation` with the count, limit and request in the reason | Not an error return — a refusal that changed nothing would leave the phase claiming work was underway |
| Explicit final confirmation, never assumed | PM §4.9 | **EXISTS** (G-283) | `final_confirmed` must name the exact theme **and** colour, and both must be in the frozen share snapshot | *"Do not rely on … 'seems okay'"* — `needs_both` and `not_shown` |
| Scope-change routing, not silent design | Master §17, Designer §17, PM §18 | **EXISTS** (G-283, G-284) | `possible_scope_change` **stops** the phase into `scope_escalation` with the client's own words in `blocked_reason`; nothing creates a change request automatically | G-284 refuses a revision citing one, so the rule is not left to whoever picks the id; the hand-off into `change_requests` is still ahead |
| No internal AI/provider disclosure to client | Master §21, PM §10 | **PARTIAL** | Existing client-facing composers do not name providers | Needs asserting for Phase 3 surfaces |

## F. Lock and handoff

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| Lock theme + color + Figma version | Master §7.11, §16 | **MISSING** | — | — |
| Final selection not silently overwritable | Master §16, Designer §4.9 | **EXISTS** (G-285, G-289) | the lock takes **no argument** about what to lock — it reads the confirmation — and neither does its form; one handoff per phase; the handoff cannot be edited | A picker on the form would put the rule back in the hands of whoever last touched it |
| History never overwritten | Master §8, Designer §20 | **MISSING** | — | The freeze-trigger pattern from G-256 applies |
| `Phase3Completed` / `Phase4Ready` | Master §7.12, §15 | **EXISTS** (G-285) | both declared; `phase_three_completed` always, `phase_four_ready` **only when true** | An event that fired regardless would be a faked completion with a name on it |
| Structured Phase 4 handoff payload | Master §19, Designer §19 | **EXISTS** (G-285) | frozen `payload` — screen baseline, theme, palette, Figma refs, approval evidence, revision rounds | PM §4.10: no reselecting in Phase 4 |
| Phase 4 cannot start early | Master §22, PM §20 | **MISSING** | — | Phase 4 does not exist; the gate must still refuse |

## G. Admin Panel — the locked AgencyOS-wide principle

Master §8 and Designer §20 both restate it: *"important work, decisions, outputs
and history from every phase must be visible from the Admin Panel."* Thirteen
required areas, all **MISSING** except where noted.

| Area | Status | Note |
| --- | --- | --- |
| Phase 3 overview | **MISSING** | |
| Project plan | **EXISTS** (G-274) | `/projects/[projectId]/plan` — built two days ago, and Master §9 requires exactly this |
| Screen list | **PARTIAL** | rows exist and are now versioned (G-278); no surface renders them yet |
| Screen content baseline | **PARTIAL** (G-278) | the columns and the frozen snapshot exist; no surface renders them yet |
| Theme options | **MISSING** | |
| Color options | **MISSING** | |
| Internal review | **PARTIAL** (G-280) | rows exist; no surface renders them yet |
| Admin decisions | **PARTIAL** (G-280) | rows exist; no surface renders them yet |
| Client shares | **EXISTS** (G-282, G-286, G-288) | frozen rows, rendered, and recordable by a PM — recorded, never sent |
| Client decisions | **EXISTS** (G-283, G-286, G-288) | classified, frozen, shown in the client's own words, and recordable from the round's own snapshot |
| Client feedback | **MISSING** | |
| Revision timeline | **EXISTS** (G-284, G-286, G-288) | origin, round and request; a client round opens from the decision that asked for it, once |
| Final selection | **MISSING** | |
| Phase 4 handoff | **PARTIAL** (G-285, G-286, G-289) | lockable from the Admin Panel; the row, its readiness flag and its note are rendered; no Phase 4 unit consumes them yet |
| Cost / usage | **PARTIAL** | `/usage` exists org-wide; no per-phase view |

## H. Cost control

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| Deterministic code for state/counting/IDs | Master §6, §18 | **EXISTS** | Every state machine in this repository is SQL, not LLM | Continue the pattern |
| Input version hashing → artifact reuse | Master §18, Designer §10 | **EXISTS** (G-279) | `projects.design_context_version` + `unique (project, context, index)` | Deterministic SQL; §6 forbids model tokens for comparison metadata |
| Retry does not regenerate | Master §18, Designer §26 | **PARTIAL** | `core.jobs` dedupe keys; `ai.agent_runs` idempotency | Not applied to design artifacts |
| 2–3 option ceiling enforced | Master §18 | **EXISTS** (G-279) | `enforce_theme_option_ceiling` | Per design context, so a revision is not refused forever |
| Model routing by complexity | Master §6, Designer §10 | **PARTIAL** | `src/lib/ai/router.ts` selects providers | No complexity tiering for design |
| Usage telemetry by project/phase/agent/task | Master §6, §19 | **EXISTS** (G-297) | `ai.project_usage_by_phase()`; attribution derived from the subject, so it applies to history too | No design agent has run yet, so the honest total is zero |
| Abnormal repeated generation visible to Admin | Designer §10 | **MISSING** | — | |

## I. Security

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| RBAC on design decisions | Master §21, Designer §25 | **EXISTS** | `core.can_write()`, capability list, `can()` | New capabilities needed |
| Tenant / project isolation | Master §21 | **EXISTS** | RLS on all 99 tables, `enforce_parent_org`, `freeze_organization_id` | Applies to new tables |
| Audit of every material mutation | Master §21 | **EXISTS** | `core.record_audit`, append-only | — |
| Provider secrets never in project data | Master §20, §21 | **EXISTS** | Secrets are Vercel env only; `scan:secrets` in `npm run check` | No Figma secret exists to protect yet |
| Server-side authorization on design APIs | Master §21 | **EXISTS** | Every door is `security definer` or RLS-backed | — |

---

## Decisions this matrix records rather than resolves silently

**D-1 — Screen status vocabulary (CONFLICTING).** `projects.screens.status` is
`draft / in_review / approved / superseded`; Master §13 asks for
`DRAFT / REVIEW / FINALIZED / BLOCKED`. These are not the same list and neither
is a superset. **Resolution: extend, do not rename.** `superseded` is load-bearing
for an existing versioning rule and `approved` is referenced by the coverage
trigger; renaming either would break Phase 1/2 behaviour the mandate forbids
breaking. `blocked` is added, and `finalized` is expressed by the Phase 3
screen-baseline version rather than by overloading the screen row. Recorded
because a later reader will otherwise see a mismatch and "fix" it.

**D-2 — Figma is MANUAL on this deployment.** No integration, no credential. The
assisted workflow stores the canonical references a person pastes in and exposes
the exact remaining step. **Nothing will report that a Figma file was created
automatically.** Master §20 and Designer §24 both require precisely this.

**D-3 — `src/ui/tokens.ts` is not a client design token set.** It is AgencyOS's
own product theme. Designer §23's `DesignTokenSet` is per client per theme
option. Reusing the product's tokens as a client's palette would be the
"same visual branding" mistake Master's design-system-reuse section names.

**D-4 — Admin review is `approvals`, internal review is not.** The approval
engine already carries the decider, the role requirement, the reason and the
evidence, and Master §19's `AdminDesignDecision` is that shape. Internal design
review is a *different* gate with a different audience and a different
vocabulary (PASS / CHANGES_REQUIRED, not approve/reject), and folding it into
`approvals` would make "who approved this" ambiguous.

**D-5 — `project_type` (CONFLICTING).** Designer §11's design-brief contract
lists `project_type`. **ADM-73, granted 2026-08-14, forbids it:** *"AgencyOS
must NOT restrict projects to a small hardcoded list of service categories…
model WHAT THE CLIENT PROJECT IS and WHAT HAS BEEN SOLD, rather than
artificially limiting what the agency is capable of selling."*

The mandate's precedence rule puts the Phase 3 PDFs above older
*specifications*. ADM-73 is not a specification — it is the owner's answer to a
question this system asked, and it answers the same question §11's field would
be asking. **Resolution: the brief carries what the project is by reference to
the approved scope items that were sold, and no type enum is created.** The
design context hash reads `service_type` and `target_users` from
`crm.qualification_coverage`, which is the client's own words rather than a
category somebody picked from a list.
