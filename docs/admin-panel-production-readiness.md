# Admin Panel — Verification Pass Notes

Scope: the screens built in this session's admin-panel program (Stage 3-6
work, 2026-09-22), checked against the PDF's §39 "definition of complete"
before the broader 38-screen EXISTS set.

## Finding 1 — audit coverage gap on two new tables (fixed)

`audit.record_row_change()` writes `audit.audit_log` from a table trigger and
refuses (raises) any table attached to it without matching vocabulary. The
two tables added this session — `projects.project_files` (SCR-024) and
`projects.repositories` (SCR-042) — had neither the trigger nor a vocabulary
branch, so an add/edit to either left no audit trail.

Fixed in `supabase/migrations/20260922120000_two_more_tables_learn_to_speak.sql`:
added `project_file.added`/`.updated` and `repository.added`/`.updated`
branches, attached the trigger to both tables (INSERT/UPDATE only, matching
every other table in this trigger's family — none of them audit DELETE
either).

**Near-miss caught during this fix:** the first draft of the migration
redefined `audit.record_row_change()` from the *original* 2026-08-13
migration's body. Six later migrations had each added their own vocabulary
branch to that same function (`communication_consent`, `onboarding_baseline`,
`follow_up_sequences`, `follow_up_sends`, `proposals`, plus refinements to
`lead_activities`) — a `create or replace function` from the wrong base would
have silently deleted all five. `scripts/apply-migrations-locally.sh`'s own
seed step exercises `onboarding_baseline` and failed loudly, which is what
caught it before it reached the repo. Corrected by locating the true chain of
six redefinitions (`grep -l "create or replace function audit.record_row_change"`)
and merging from the latest one instead.

**Verified, not just read:** applied all 287 migrations to a scratch Postgres
(`apply-migrations-locally.sh`), then via `psql` confirmed: a `project_files`
insert produces `project_file.added`, a `repositories` insert produces
`repository.added`, and two pre-existing branches (`client_account.created`,
`project.created`) still fire correctly after the merge.

## Finding 2 — pre-existing audit gap on `deliverables` and `approval_requests` (fixed, on confirmation)

Neither `projects.deliverables` nor `approvals.approval_requests` had ever
had the `audit_row_change` trigger attached — confirmed by grep across every
migration. This predated this session; it was not something the Prototype
(SCR-037) or Builds (SCR-043) screens introduced, only something they made
more reachable by adding UI on top of `addDeliverable`/`submitDeliverable`.

The master prompt's own audit list names "design approved" and "prototype
approved" explicitly, and `deliverables.status` (draft → in_review →
approved/changes_requested → superseded) carries exactly that decision.
Confirmed with the owner (2026-09-22) before extending the trigger, given the
approval engine's broader blast radius than the first fix.

Fixed in `supabase/migrations/20260922130000_the_gate_and_the_thing_it_gates.sql`:
added `deliverable.added`/`.<status>` and `approval.requested`/`.<state>`
branches (status/state itself is the action name, matching the existing
`proposals` and `defects` branches), attached the trigger to both tables
(INSERT/UPDATE only, same boundary as every other table here).

**Verified, not just read:** applied all 288 migrations + seed to a fresh
scratch Postgres, then via `psql` — using `submit_deliverable`'s own
precondition (a deliverable moving to `in_review` must carry a live
`approval_request_id`, enforced by the pre-existing `deliverables_guard`
trigger, caught on the first test attempt) — confirmed: a deliverable insert
produces `deliverable.added`, an approval-request insert produces
`approval.requested`, moving the deliverable to `in_review` (with its
approval linked) produces `deliverable.in_review`, deciding the approval
produces `approval.approved`, and the previously-merged `project.created`
branch still fires. Ordering the check queries by `audit_log.id` rather than
`created_at` was necessary — two rows written in the same transaction can
share a millisecond timestamp, which the first version of the test read as
"no second row was written" when a second row had in fact been written.

## Finding 3 — capability/RLS asymmetry (checked, not a bug)

`core.can_write()` (RLS) admits `owner, ops_admin, delivery_lead, member`.
The app-level `project.write` capability (`src/lib/authz/permissions.ts`)
admits only `owner, ops_admin, delivery_lead` — `member` is excluded, even
though `member` holds `task.write`. This looked at first like an
inconsistency between the two new screens (Files, Repository, both gated on
`project.write`) and the DB's broader RLS.

It is not a gap: `addDeliverable` (pre-existing, `service.ts`) uses the same
`project.write` gate, excluding `member` the same way. The two-layer model is
working as designed — RLS is the coarse backstop, the app capability is the
finer-grained UI gate, and a mismatch always runs in the safe direction (app
layer more restrictive than DB layer, never less). No change made.

## Verified for the 9 new screens (Quotations, Follow-ups, Team, Board,
Activity, Files, Prototype, Builds, Repository) plus the Command Center and
Quick Create additions

- Route exists and builds (`next build`, confirmed each stage).
- Permission gate present and matches the capability the destination data
  actually needs (`lead.read`/`project.read`/`project.write`), cross-checked
  against RLS on the underlying tables.
- RLS-scoped reads throughout — no raw/service-role client used from a page.
- Empty and error states present on every list (`EmptyState`, `DATA
  UNAVAILABLE` via `unreadable()`/`Avail<T>` where applicable).
- No fabricated numbers — every count/stat traces to a real query.
- G-054 structural test (`tests/read-failure-semantics.test.ts`) passes for
  every touched `queries.ts`.
- Full suite (5,798 tests) and `next build` clean after every change.

## Not yet checked

- Loading states (`loading.tsx`) — none of the new routes have one; Next.js
  Server Components stream by default, but a slow query has no skeleton.
- Keyboard/focus audit beyond native HTML semantics — not manually tested
  with a screen reader.
- The remaining ~29 pre-existing EXISTS screens against this same checklist.
