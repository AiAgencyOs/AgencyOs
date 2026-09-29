# AgencyOS Admin Panel — Test Matrix

What was actually run against this reskin, and what wasn't. Written after
the fact from real tool output, not a plan — every "✓" below has a
corresponding command or screenshot earlier in this work's history.

## Automated

| Check | Result | Scope |
|---|---|---|
| `tsc --noEmit` | ✓ clean | Whole repo, run after every change in this session. |
| `eslint .` | ✓ clean (4 pre-existing unrelated warnings in `tmp/demo-meeting.mjs`) | Whole repo. |
| `npm test` (`node --test`) | ✓ 6,240 / 6,240 pass | Whole repo. One real regression was found and fixed mid-session (a source-scanning test's regex was too strict for the new icon-chip prop; the underlying guarantee it checks was unaffected). |
| `node scripts/verify-tenancy-guards.mjs` | ✓ 15/15 checks pass | Live, against a real local Postgres. Found and fixed two pre-existing gaps unrelated to this reskin (`finance.receipts`, `projects.ui_version_client_decisions.conversation_id`) — see `20260928140000_a_receipt_and_a_decision_learn_their_tenant.sql`. |

## Live browser verification (real Supabase, real signed-in sessions)

Done as the Owner role (full capability set) unless noted:

- Dashboard: dark sidebar, indigo active-state, KPI icon chips, `AutoRefresh`
  ("Updated Xs ago") all confirmed rendering correctly.
- Mobile viewport (375px): stacked KPI cards, bottom tab bar, and the
  dark-themed slide-over drawer all confirmed legible and functional.
- Client 360: added a real note end-to-end — RLS accepted the write, the
  server action revalidated, the UI re-rendered with the correct author
  email and timestamp.
- Project Board: dragged a real card with the mouse; the task's status
  changed via `setTaskStatusAction` and the column counts updated correctly.
- Sales Pipeline: dragged a real card through a legal stage transition
  (`discovery` → `proposal`) via `setOpportunityStageAction`.
- Project Calendar: month grid and agenda list confirmed to agree on the
  same dates after a real bug (see below) was fixed.
- Usage & costs: a seeded 7-day cost trend rendered correctly as a line
  chart after a real crash (see below) was fixed.
- Clients list: confirmed no data-row/header overlap after a real bug (see
  below) was fixed.
- Security boundary: a `client_admin` role test account was created and
  confirmed to be redirected to `/portal` — both via the login page's own
  redirect logic *and* via direct URL access to `/projects/.../board` and
  `/clients/...` (routes this session added Kanban/notes to) — never
  reaching the internal shell at all.

## Bugs found only by live testing (none catchable by static analysis)

1. **Sticky table header broke row layout** — `position: sticky` on a
   `<thead>` row caused the first data row to render overlapping the header
   in a real browser. Reverted; see the design system doc's "Known
   limitations."
2. **Calendar date off-by-one** — a pre-existing timezone round-trip bug (not
   introduced this session) in the agenda list's date heading, exposed by
   comparison against the new month grid showing the correct date for the
   same row. Fixed with a timezone-safe formatter.
3. **Chart crash on real data** — `TrendChart`/`BarChart`/`DonutChart`
   accepted a `valueFormatter` callback prop; Next.js refuses to pass a
   plain function from a Server Component to a `'use client'` component.
   Fixed by replacing it with a serializable `currency` string prop.

## Explicitly not done

- **Full role-matrix testing.** Only Owner (full capability set) and one
  `client_admin` boundary check were exercised. The other seven internal
  roles (`ops_admin`, `delivery_lead`, `member`, `contractor`, `finance`,
  plus `client_member`) were not signed in and clicked through. Note: per
  `src/lib/authz/permissions.ts` as it stands, every internal role holding
  `project.read`/`lead.read` also holds the matching write capability, so
  the Kanban boards' read-only/disabled path has no role to exercise it with
  today regardless.
- **Accessibility audit.** No screen-reader pass, no keyboard-only
  navigation pass, no contrast-ratio check beyond what the existing design
  system's own token choices already carry over from before this reskin.
- **Systematic responsive testing.** Only the Dashboard was checked at a
  375px viewport; the other ~70 screens were not spot-checked at
  tablet/mobile widths.
- **Multi-session E2E** (the "create in session A, see it update in session
  B without refresh" style tests the original brief asked for). Not
  attempted — this reskin explicitly chose polling over push-based realtime,
  so the premise of an instant cross-session update doesn't hold anyway; a
  polling-interval-bounded version of this test was not run either.
- **Visual QA against the 42 reference screenshots**, screen by screen. This
  session verified the *token/component system* matches the reference
  language (dark sidebar, indigo accent, KPI chip pattern) on the handful of
  screens actually opened live; it did not do a systematic side-by-side
  comparison for the other ~65 screens.
