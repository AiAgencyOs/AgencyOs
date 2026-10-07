# Phase 4 UI Designer and Prototype: round 4 gap-closure log (2026-12-01)

Scope: the remaining buildable PARTIAL/MISSING rows of the `P4-UID-*` and `P4-PROTO-*` clusters named in `phase-4-ui-prototype-gaps-log.md` ("Still PARTIAL and buildable later"), plus the revised-prototype gap found while wiring. Migration `20261201000000_p4r_*` (every object is `p4r_`-prefixed except three existing doors it re-defines with the same signature), verifier `scripts/verify-p4r-ui-prototype.sql` (84 live checks, in `db:verify:phase4`), red-proof driver `scripts/redproof-p4r.py` (16 mutations of live definitions, all red, all restored), `tests/p4r-ui-prototype.test.ts` (17) and additions to `tests/p4ui-orchestration.test.ts`.

## The revised-prototype gap (fixed)

`revise_prototype_build` makes a NEW artifact (and deliverable) for the same locked UI version, but the p4ui build is planned only when the UI version locks (`ui_prototype:planBuild`). A revised artifact therefore found the latest build already holding the artifact it revised, `attachBuiltPrototype` answered "the build is X" and skipped, the revised artifact never had a p4ui build, and `p4ui_record_build_revision` could fire only for a build someone planned by hand.

Fix, one connection:

- `projects.p4r_plan_revision_build(artifact)` plans the build from the build that was sent back (QA changes, client changes, or a failed self-check): it inherits the plan, the test data and the already-passed input validation (same locked UI, same plan), supersedes the sent-back build, and leaves the new build `building`. It decides no gate. It refuses (named outcomes) an artifact a build already holds, a prior build that was not sent back, one with no artifact, and one that is not a later deliverable.
- `attachBuiltPrototype` (the `projects:attachP4uiBuild` handler, already wired on `project.prototype_build_ready`) calls it when the latest build holds a different artifact, re-reads the new build for the job organization, attaches, assembles the handoff and records the lineage on the build it planned.
- Positive proof: `verify-p4r-ui-prototype.sql` section 4 (failed-first-build path and QA-sent-back path, three builds, lineage origin `qa_defect` with the QA finding as evidence) and `tests/p4ui-orchestration.test.ts` (the attach door receives the NEW build id; the revision record receives it; removing the call fails the test). Negatives: replay plans nothing more; a build not sent back plans nothing (savepoint probe).
- A second defect found by driving it, fixed in the same migration: `p4ui_sync_build_status` read "superseded" before "QA sent it back", and the machine has no `qa_review` to `superseded` edge, so a build whose corrected round had already superseded its deliverable stayed in `qa_review` and the sync failed on every retry. A QA send-back is now reflected first (red-proved).

## Rows

| Row | Now | What closed it |
|---|---|---|
| P4-UID-015 | EXISTS | planning and brand inputs (`p4r_design_inputs`, `p4r_record_design_inputs`), given to the Designer in the draft prompt, editable in the design panel |
| P4-UID-016 | EXISTS | the same input contract (brand assets, accessibility targets, device targets, planning note) beside scope version and change set |
| P4-UID-021 | EXISTS | `p4r_check_token_consistency`, run by `detailUiVersion`, one `token` QA defect per finding |
| P4-UID-054 | EXISTS | `no_content_change` at `revise_ui_version` and `p4ui_start_governed_revision`; the revise workflow fails the job instead of succeeding |
| P4-UID-055 | EXISTS | export-leak assertions (client notice allow-list and vocabulary scan; every `p4ui_`/`p4r_` table RLS-forced, internal-only read, no write policy) |
| P4-PROTO-028 | EXISTS | `p4r_follow_build_state` writes `prototype_review` / `prototype_locked`, only from a working state |
| P4-PROTO-066 | EXISTS | screens/navigation (009) and states/validation (010 vocabulary + report) |
| P4-PROTO-087 | EXISTS | live assertion at the prototype QA-fix limit |
| P4-PROTO-088 | EXISTS | `p4r_prototype_artifact_content_frozen` plus live assertions on the artifact, the approved deliverable and the locked build |
| P4-PROTO-097 | EXISTS | responsive variants now in the vocabulary and the report |
| P4-UID-035 | PARTIAL (narrower) | provider/export leak asserted; fabrication against a real model is not |
| P4-UID-057 | PARTIAL (narrower) | the asset-missing path is opened by the design inputs; nothing opens `locked_scope_conflict` |
| P4-PROTO-010 | PARTIAL (narrower) | states, responsive, validation in the vocabulary; the report is informational, not a gate; role differences are not modelled |
| P4-PROTO-072 | PARTIAL (narrower) | deep links checked; mock reset is not testable without a runtime |
| P4-PROTO-033, -046 | EXISTS (note added) | now fed by real revisions |

`P4-PROTO-088` found a real hole rather than only missing a test: the artifact row had no write policy for end users, but the service role holds the table's default grants and bypasses RLS, so the screens of an approved prototype could be rewritten. Nothing writes those columns after insert, so they are frozen outright.

## Wiring done (one connection each, each fails a test if removed)

1. `src/modules/projects/p4ui.ts` `attachBuiltPrototype`: plan the revision build (above). Tests: `p4ui-orchestration` (2 new), `p4r-ui-prototype` (order plan, attach, lineage).
2. `detailUiVersion`: Design QA's token check before the lineage is derived. Tests: `p4ui-orchestration`, `p4r-ui-prototype`.
3. `app/api/jobs/run/workflows.ts` `ui.version_draft`: the recorded inputs join the Designer's message; an unreadable record fails the job (retry) rather than drafting without the brief. Test: `p4r-ui-prototype` (wiring) and `designInputsLine` behaviour.
4. `ui.version_revise`: `no_content_change` is a failed job with its own reason. Test: `p4r-ui-prototype`.
5. Prototype build prompts and `prototypeBuildSchema` carry the optional state, responsive and validation fields (an older build still validates; still strict, no field can become markup).
6. Design panel: `DesignInputsForm`, `recordDesignInputsAction`, `recordDesignInputs`, `loadP4uiDesignView` reads the inputs with `unreadable`.

No change to `route.ts`, `catalog.ts` or the event vocabulary: the existing `projects:attachP4uiBuild` / `projects:syncP4uiBuild` subscriptions carry both new behaviours.

## What stays open, and why

- `MANUAL_EXTERNAL` / `environment_missing`, unchanged: a funded model (every workflow here is proved against stand-ins and the database; no real-model run happened), Figma write (references and capability state only), image generation, hosting/APK/iOS/desktop packages.
- `P4-UID-035` fabrication assertions, `P4-UID-057` `locked_scope_conflict` opener, `P4-PROTO-010` role differences and a QA that gates (rather than reports) on missing states, `P4-PROTO-072` mock reset: not built. The state report is deliberately not a gate: making it one would fail every existing prototype that predates the vocabulary.
- The failed-prior-build path of `p4r_plan_revision_build` and the QA-sent-back path are both proved live; a client-changes-requested revision uses the same door but its lineage (`client_change` with the PM's classification) is still proved only by `verify-p4ui-prototype.sql` on a hand-planned build, not through the new door.
- Not rendered in a browser: the design-inputs form type-checks and lints; nothing was loaded in a running app.

## Verification

- Scratch Postgres 16.14 on port 55471 (copy of `apply-migrations-locally.sh`, `KEEP=1`): all 588 migrations apply; `verify-p4r-ui-prototype.sql` prints PASS; the whole `db:verify:phase4` chain (53 files) replays in ONE `psql -v ON_ERROR_STOP=1` session with exit 0 and no failure; `core.unguarded_org_fks()` returns 0.
- `scripts/redproof-p4r.py`: 16 of 16 mutations red, each restored; the verifier is green afterwards.
- `npm run typecheck`, `npm run lint`, `npm run scan:secrets`, full `npm test` (11,297 tests) pass; `npm run check:record` passes after the derived counts in `docs/roadmap/roadmap.json` are updated.
- Helper names in the verifier are `pg_temp.p4r_*`; the only `session_replication_role` is the top-level fixture precedent for the Phase 3 hand-off row (never in a function or DO block); table-wide counts are scoped to the verifier's own project, build or version.
