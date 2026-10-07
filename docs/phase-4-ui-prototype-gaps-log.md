# Phase 4 UI Designer and Prototype: gap-closure log (2026-10-07)

Scope: the PARTIAL and MISSING rows of the UI Designer (`P4-UID-*`) and Prototype (`P4-PROTO-*`) clusters in `phase-4-implementation-traceability.md` that can be closed without a funded model, Figma write access, provider credentials or a real third-party account. Migrations `20261125000000` and `20261125100000`; verifiers `scripts/verify-p4ui-ui-designer.sql` (128 live checks) and `scripts/verify-p4ui-prototype.sql` (103 live checks); red-proof driver `scripts/redproof-p4ui.py` (29 mutations of the live definitions, all red, all restored); `tests/p4ui-orchestration.test.ts` (18, stand-in model and database) and `tests/p4ui-structure.test.ts` (66, text checks of the shape).

Row accounting: 94 rows were re-read and re-stated in the traceability file. UI Designer: 29 now EXISTS, 20 stay PARTIAL with a narrower stated gap. Prototype: 34 now EXISTS, 11 stay PARTIAL. Eight older summary rows (`P4-UID-ENTITIES`, `P4-UID-EVENTS`, `P4-UID-BOUNDARY`, `P4-UID-ADMINUI`, `P4-PROTO-SM`, `P4-PROTO-TRACE`, `P4-PROTO-ADMINUI`, `P4-PROTO-BOUNDARY`) were pointed at the row-level section. Every changed row keeps its previous status and evidence in a trailing "(was ...)".

## What was built

| Area | Objects |
|---|---|
| Designer activation | `projects.p4ui_design_jobs` (UIDesignJob), `p4ui_request_design_job` (every activation records reason, source version, scope version, change set, idempotency key; every NON-activation is a `refused` row with its owner; locked UI is never overwritten; coverage-gap, QA-defect, Admin-edit, client-classification, approved-scope-change and confirmed-source-defect reasons each have their precondition), `p4ui_complete_design_job` |
| Lineage | `p4ui_version_meta` (parent, reason, origin, scope version, changed/added/removed screens, summary, Figma references), `p4ui_revisions` (append-only, with evidence: defect ids, the Admin's note, the client's own words and their classification), `p4ui_derive_version_meta` (derived from the two versions, so a model cannot forget to say what changed) |
| Screen content | `p4ui_screen_specs` (purpose, entry/exit, data, actions, validation, 16 states, platform variants, role variants, tokens, Figma node), `p4ui_design_completeness`, `p4ui_requirement_trace`, `p4ui_coverage_gaps` |
| Stops | `p4ui_design_blockers` (+ open/resolve; resolving is a person and restores the stopped state), clarifications for ambiguity |
| Design QA | `p4ui_qa_defects` (found, fix_ready is a claim, verified needs a QA verdict on the fix version and a different person), `p4ui_import_qa_findings` |
| Scope guard | `p4ui_feedback_routes` + `p4ui_route_ui_feedback` (a correction is a revision; a scope change is a Change Request and a `scope_escalation` stop; a new direction escalates; a clarification asks), `p4ui_post_lock_requests` (Admin only), `p4ui_start_governed_revision` (a NEW draft version; the locked row is untouched) |
| Prototype stage | `p4ui_prototype_design_issues` (a code bug leaves the Designer asleep; only a person-confirmed source-UI defect wakes it) |
| Prototype record | `p4ui_prototype_builds` (plan before review + PLANNED..LOCKED machine, post-QA states only behind the real artifact/deliverable rows), `p4ui_route_coverage`, `p4ui_test_data` (mock only, secret-shaped refused), `p4ui_artifact_records` (a native package can never be marked uploaded by an agent), `p4ui_prototype_blockers` (external flag), `p4ui_prototype_revisions`, `p4ui_prototype_feedback_routes`, `p4ui_qa_handoffs` (immutable package) |
| Prototype doors | `p4ui_plan_prototype_build`, `p4ui_validate_build_inputs`, `p4ui_attach_build_artifact` (self-check; a failed self-check is FAILED, never BUILD_READY), `p4ui_fail_build`, `p4ui_compute_route_coverage`, `p4ui_record_test_data`, `p4ui_record_build_artifact`, `p4ui_report_prototype_request`, `p4ui_assemble_qa_handoff`, `p4ui_sync_build_status`, `p4ui_record_build_revision`, `p4ui_route_prototype_feedback`, `p4ui_build_share_eligibility`, `p4ui_prototype_client_notice` (client-safe label) |
| TypeScript | `src/modules/projects/p4ui.ts` (schemas, prompts, `detailUiVersion`, `planPrototypeBuild`, `attachBuiltPrototype`, `syncBuildForDeliverable`, next-gate wording), `p4ui-handlers.ts`, `app/api/jobs/run/p4ui-workflows.ts` (`ui.design_detail`, `prototype.plan`), `p4ui-queries.ts`, `p4ui-service.ts`, `p4ui-actions.ts` |
| UI | `/projects/[projectId]/p4ui` (new page), `p4ui-design-panel.tsx`, `p4ui-prototype-panel.tsx`, `p4ui-forms.tsx` |

Human gates are untouched and never bypassed: Design QA, Admin review, client share/decision and lock are the existing doors; this change only reads them. Every decision that waives a human step (resolve a blocker, classify a prototype issue, record Figma references, decide a post-lock request) answers `person_required` / `admin_required` to the service role.

## Not done, and why

- Everything that needs a funded model: the two new workflows and the three orchestration functions are proved against a stand-in model only (order of calls, refusals, writes). No real-model run happened. `MANUAL_EXTERNAL`.
- Figma write (P4-UID-015 refs, -022 layer naming, -030 write, -043 write, P4-PROTO-015 write): needs Figma credentials. References and a capability state are recorded; `figma_write_state` has no value that claims a write (CHECK, red-proved). `MANUAL_FIGMA_REQUIRED` stands.
- Image generation (P4-UID-031): funded image model. `MANUAL_EXTERNAL`.
- Hosted prototype URL, APK, iOS package, desktop package (P4-PROTO-008, -067, -095): no hosting, signing or distribution accounts. A native package from an agent becomes `environment_missing` and opens an EXTERNAL `credential_missing` blocker that only an Admin clears.
- Still PARTIAL and buildable later: planning/brand inputs for the Designer (P4-UID-015/016), token-consistency QA (-021), prevention of a no-content new version (-054), export-leak and provider-leak assertions (-035/-055), a design-side asset-missing path and a `locked_scope_conflict` opener (-057), prototype state/validation vocabulary (P4-PROTO-010, -066), `phase_four.state` prototype_review/prototype_locked writes (-028), responsive prototype checks (-097), mock-reset and deep-link tests (-072), live assertions of the prototype revision limit and of mutating an approved artifact (-087, -088).
- Rows whose control exists at the door but is NOT enforced on the live event path until the wiring below: P4-UID-008, -009, -025, -026, -027 and P4-PROTO-013, -027, -058, -086.
- Not rendered or clicked in a browser: the new page, panels and forms type-check and lint, and the queries are guarded, but nothing was loaded in a running app (it needs a signed-in session and a seeded project).
- Not done by choice: `docs/roadmap/roadmap.json` derived counts (shared file); re-derive with `npm run check:record` after merging (two migrations, two verifiers, one driver, two test files are new).

## Wiring lines for the lead (shared files this pass did not edit)

1. `package.json`, `db:verify:phase4`: append `-f scripts/verify-p4ui-ui-designer.sql -f scripts/verify-p4ui-prototype.sql` after the last `-f`.
2. `app/api/jobs/run/workflows.ts`: `import { P4UI_WORKFLOWS } from './p4ui-workflows';` and append `...P4UI_WORKFLOWS` to `RUNNABLE_WORKFLOWS`.
3. `src/lib/events/catalog.ts`:
   - `HANDLERS`: add `'ui_designer:detailUIVersion'`, `'ui_prototype:planBuild'`, `'projects:attachP4uiBuild'`, `'projects:syncP4uiBuild'`.
   - `HANDLER_JOB_KIND`: `'ui_designer:detailUIVersion': 'ui.design_detail'`, `'ui_prototype:planBuild': 'prototype.plan'`, `'projects:attachP4uiBuild': 'p4ui.attach_build'`, `'projects:syncP4uiBuild': 'p4ui.sync_build'`.
   - `SUBSCRIPTIONS`: `'project.ui_version_drafted'` add `'ui_designer:detailUIVersion'`; `'project.ui_version_locked'` add `'ui_prototype:planBuild'`; `'project.prototype_build_ready'` add `'projects:attachP4uiBuild'`; add `'projects:syncP4uiBuild'` to `'project.prototype_qa_reviewed'`, `'project.prototype_admin_decided'`, `'project.deliverable_submitted'`, `'project.deliverable_decided'`.
   - To make the classification gate and the activation record live: in the handler behind `'ui_designer:reviseUIVersion'` and `'ui_prototype:reviseBuild'`, call `projects.p4ui_request_design_job` (reason `client_visual_revision` / `admin_edit` / `design_qa_defect`) and `projects.p4ui_route_prototype_feedback` before the model call and skip when the door answers `classification_required`, `not_a_design_revision`, `phase_blocked` or `locked`. After a revision is recorded call `p4ui_derive_version_meta` / `p4ui_record_build_revision`.
4. `app/api/jobs/run/route.ts`: import `handleP4uiAttachBuild`, `handleP4uiSyncBuild` from `@/modules/projects/p4ui-handlers` and drain them with the same `runEventJobs(admin, HANDLER_JOB_KIND['projects:attachP4uiBuild'], handleP4uiAttachBuild, 'runP4uiAttachJobs')` block `handleReviewPrototypeBuild` uses (and the sync handler the same way).
5. Event vocabulary: the seven new event types are declared in the migrations (letters and underscores only, so `tests/event-vocabulary.test.ts` reads them): `project.ui_design_job_requested`, `ui_coverage_gap_confirmed`, `ui_scope_change_approved`, `prototype_design_issue_confirmed`, `ui_post_lock_revision_decided`, `ui_design_blocker_opened`, `prototype_build_blocked`. None has a subscriber yet; add catalog entries only when one exists.
6. `app/(internal)/projects/[projectId]/page.tsx`: optional link `/projects/${projectId}/p4ui` ("UI design and prototype"), or mount `<P4uiDesignPanel projectId={projectId} view={await loadP4uiDesignView(projectId)} />` and `<P4uiPrototypePanel projectId={projectId} view={await loadP4uiPrototypeView(projectId)} />` (from `./p4ui-design-panel`, `./p4ui-prototype-panel`, `@/modules/projects/p4ui-queries`).
7. Client prototype page: call `projects.p4ui_prototype_client_notice(deliverableId)` and render its `label` and `limitations` (P4-PROTO-013/052). `projects.prototype_send_gate` may also read `p4ui_build_share_eligibility` (P4-PROTO-058).
8. `db:push` after merge: both migrations are additive (new tables and functions, new event types, no change to an existing constraint), so they are safe to apply ahead of the code.

## How it was verified

- Scratch Postgres 16 on port 55451 (`apply-migrations-locally.sh` copy, KEEP=1): all migrations apply; both verifiers run with `psql -v ON_ERROR_STOP=1` and print PASS; they use top-level `set local session_replication_role = replica` only for the single Phase 3 hand-off and scope fixtures (the same precedent as `verify-phase-four-e2e.sql`), never inside a function; table-wide counts are scoped to the verifier's own project.
- `scripts/redproof-p4ui.py` mutates the live definition of one function (or drops one constraint) at a time and requires the verifier to go red on the expected check; a mutation whose target text is not found exactly once raises. 29 of 29 red, definitions restored, both verifiers green afterwards.
- `npm run typecheck`, `npm run lint`, `npm run scan:secrets` and the full `npm test` (10,733 tests) pass in the worktree.
- A real bug the verifier found in the first draft and the fix: a build in `qa_review` could not move to `changes_requested` (sync now walks only as far as the real rows support before taking the sideways edge); a retried artifact upload collided with its own failed attempt (now replaces it).

## Honest limits

- The DB-level controls are red-proved. The wiring-dependent rows above are NOT live until the lead applies the lines.
- Role gates were exercised with the roles the test fixture can create (owner = admin, member = writer, service role, another organization). A client-role caller was not exercised against these doors; they are internal-only by `p4ui_caller` and RLS.
- `tests/p4ui-structure.test.ts` is a text check and says so; the behaviour is in the SQL verifiers.
