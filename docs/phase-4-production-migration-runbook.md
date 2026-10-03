# Phase 4 production migration runbook

The Phase 4 code (`106c008` on `main`) is already deployed. The 7 migrations
below shipped in the same commit under `supabase/migrations/` but have **not**
been applied to the production database yet — this repo has no CI step that
runs `supabase db push` automatically on merge, so it's a manual step.

Apply these **in order**, one at a time, via the Supabase SQL Editor
(`https://supabase.com/dashboard/project/<project-ref>/sql/new`). Each
migration is idempotent (`create table if not exists`, `create or replace
function`, `on conflict do nothing`), so re-running one that already applied
is safe — but still apply in order, since later ones depend on earlier ones
(e.g. migration 2 references the `projects.phase_four` table migration 1
creates).

Before starting, confirm which of these, if any, already ran:

```sql
select version from supabase_migrations.schema_migrations
where version >= '20260923100000'
order by version;
```

If a version is listed, skip that file — move to the next one.

## Apply order

1. `supabase/migrations/20260923100000_phase_four_begins_where_phase_three_locks.sql`
   — creates `projects.phase_four` + the `start_phase_four` door.
   Verify: `select to_regclass('projects.phase_four');` returns non-null.

2. `supabase/migrations/20260923110000_the_ui_version_designs_the_locked_screens.sql`
   — creates `projects.ui_versions` + `record_ui_version_draft`.
   Verify: `select to_regclass('projects.ui_versions');` returns non-null.

3. `supabase/migrations/20260923120000_qa_cannot_pass_its_own_design.sql`
   — adds `qa_findings`/`qa_reviewed_at` + `record_ui_version_qa_verdict`.
   Verify: `select column_name from information_schema.columns where table_schema='projects' and table_name='ui_versions' and column_name='qa_findings';` returns a row.

4. `supabase/migrations/20260923130000_admin_review_reuses_the_engine.sql`
   — extends `approvals.approval_requests`/`approval_policies` subject_type
   CHECK to include `ui_version` + `request_ui_version_admin_review` +
   `sync_ui_version_decision`.
   Verify: `select conname from pg_constraint where conname like '%subject_type%' and conrelid = 'approvals.approval_policies'::regclass;` — then confirm the constraint definition includes `ui_version` (`select pg_get_constraintdef(oid) from pg_constraint where conname = '<name from above>';`).
   **This is the one that unblocks `/settings/approvals` showing `ui_version` in the dropdown** — the original trigger for this whole runbook.

5. `supabase/migrations/20260923140000_the_client_confirms_the_locked_ui.sql`
   — creates `projects.ui_version_client_decisions` + `share_ui_version_with_client` / `record_ui_version_client_decision` / `lock_ui_version`.
   Verify: `select to_regclass('projects.ui_version_client_decisions');` returns non-null.

6. `supabase/migrations/20260923150000_the_prototype_reuses_the_deliverable.sql`
   — creates `projects.prototype_artifacts` + `record_prototype_build` / `record_prototype_qa_verdict`.
   Verify: `select to_regclass('projects.prototype_artifacts');` returns non-null.

7. `supabase/migrations/20260923160000_m2_and_the_gate_it_actually_needs.sql`
   — adds `emit_event` calls into `submit_deliverable`/`sync_deliverable_decision` + `complete_phase_four` + `phase_five_gate_status`.
   Verify: `select proname from pg_proc where proname = 'complete_phase_four';` returns a row.

After all 7 apply cleanly, run once more:

```sql
select version from supabase_migrations.schema_migrations
where version >= '20260923100000'
order by version;
```

All 7 versions should now be listed. Then, as the org owner, go to
`/settings/approvals` and confirm `ui_version` appears in the subject-type
dropdown — that was the concrete symptom that started this (see chat context:
`skillkhojo@gmail.com` couldn't configure a `ui_version` approval policy
because the constraint hadn't shipped to production yet).

## Why this is a runbook, not an automated push

The only production DB access available in this session was a browser driving
the Supabase dashboard's SQL editor (Claude in Chrome), signed in as the org
owner. That session became unresponsive partway through (screenshots and page
reads started timing out) before the migrations could be verified as applied,
so rather than guess at partial state, this runbook exists for a human (or a
resumed session) to apply the remaining SQL directly, checking each step.
