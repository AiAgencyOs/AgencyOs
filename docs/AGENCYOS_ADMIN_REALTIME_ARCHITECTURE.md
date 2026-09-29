# AgencyOS Admin Panel — Realtime Architecture

**Status (2026-09-29): push-based, built.** The previous version of this
document recorded a deliberate choice of interval polling and listed what a
push implementation would need. Every item on that list is now in the
repository; this document describes what exists.

## The chain

```
committed row change
  → Postgres logical replication (supabase_realtime publication)
  → Supabase Realtime (websocket, postgres_changes, RLS-evaluated per subscriber)
  → src/lib/realtime/use-live.ts  (a signal, payload discarded)
  → 400 ms debounce → router.refresh()
  → the page's own RSC server reads run again, under the user's JWT
  → the screen shows the authoritative state
```

**Authority never moves.** The browser never renders anything from a
realtime payload. A change is a reason to ask the database again through
the same RLS-scoped readers that always drew the page. This is what lets
the feature satisfy the brief's *no fake optimistic success* rule for free:
a governed action (verify payment, approve, refund) still goes
command → pending → backend → authoritative result; realtime only makes the
*other* open screens learn the result at once.

## Pieces

| File | Role |
|---|---|
| `supabase/migrations/20260929100000_the_panel_hears_the_database.sql` | Adds 39 tables to the `supabase_realtime` publication, idempotently (skips tables already published; no-op on a FOR ALL TABLES publication; refuses a table that does not exist). No policy is loosened: Realtime evaluates each subscriber against the table's SELECT policies with that subscriber's own JWT, so a tenant is told only about rows it could already read. |
| `src/lib/realtime/topics.ts` | Screens name **topics** (`leads`, `approvals`, `finance`, `jobs`, …); this maps them to tables. `tests/realtime-topics.test.ts` asserts every table a topic names is one the migration publishes and one a migration created, so the two lists cannot drift. |
| `src/lib/realtime/connection.ts` | The status machine, pure: `connecting → live`, drop → `reconnecting`, three consecutive failures → `degraded`, no transport → `polling`. Every re-subscribe after the first counts a **catch-up**. `tests/realtime-connection.test.ts`. |
| `src/lib/realtime/use-live.ts` | The subscription (client). Loads the session, `realtime.setAuth(access_token)` so the socket joins as the user rather than `anon`, one channel per topic set with one `postgres_changes` listener per table, reducer-driven status. Fires `onChange` on every event, on every catch-up, on return to a hidden tab, and on the status-appropriate poll interval. |
| `src/lib/realtime/live-refresh.tsx` | `LiveRefresh` — the control a page header carries. Replaces `AutoRefresh` (deleted). Shows `● Live / Reconnecting / Degraded / Polling` with the word beside the dot, "Updated Xs ago", and a manual Refresh. |
| `app/(internal)/action-bell.tsx` | The header bell subscribes to the Action Center's topics and re-counts through a server action; the layout itself makes no database read. |

## Where it is wired

| Screen | Topics |
|---|---|
| Command Center | approvals, finance, jobs, leads, projects, agents |
| Notifications & the header bell | approvals, finance, jobs, qa, tasks, conversations |
| Approvals | approvals |
| Operations | jobs, conversations, followUps |
| QA | qa, deliverables |
| Integrations | jobs |
| Design dashboard (portfolio) | deliverables, projects |
| Development dashboard (portfolio) | tasks, deliverables, projects |

Every other screen refreshes on its own writes (`revalidatePath` after each
server action — the acting user sees their change immediately) and on
navigation. Adding a screen is one line: `<LiveRefresh topics={[…]} />` in
its `PageHeader` actions.

## Reconnect, catch-up, and "no delay"

- **Reconnect** is the Supabase client's own backoff; the reducer reports
  it. While reconnecting the screen polls every 20 s, degraded 30 s — never
  slower than the polling it replaced.
- **Catch-up:** a rejoin increments `catchUps`; the component refreshes when
  it moves, because changes between the drop and the rejoin were not heard.
  Returning to a hidden tab refreshes for the same reason.
- **Safety net:** even while live, a 120 s poll guarantees a single lost
  event cannot leave a screen stale for more than two minutes.
- **No refetch storms:** a burst of row changes inside one transaction is
  one `router.refresh()` (400 ms debounce); a refresh re-runs only the
  current page's reads, not every cached page.
- **Deliberately not subscribed:** `core.cron_heartbeat` (a write per
  minute) and, for operational screens, `audit.audit_log` (a write per
  action) — each would be a refresh per heartbeat, i.e. polling again. The
  audit log is its own topic, used only by the audit screen.

## Consistency

Because the payload is discarded and the page refetches, none of the
duplicate-row / out-of-order / regressed-status hazards of client-side
patching can occur: the screen always shows exactly what the authoritative
query returns at the time of the refetch. Versions, event IDs and dedupe
are therefore unnecessary at the client — the database's own row is the
version.

## Honest indicator

`Live` is shown only after the channel reported `SUBSCRIBED`. Before that
the pill says `Connecting`; the word is always beside the dot so the state
is readable without colour; `title` carries the sentence ("The live channel
dropped; retrying. Data refreshes on reconnect.").

## What was verified, and what was not

- Verified: the status machine (unit tests), the topic ↔ publication
  correspondence (unit test reading the migration), typecheck, lint,
  production build.
- **Not verified in this environment:** the migration applying to a live
  Postgres and a two-session "create in A, see in B" run — the container
  has no Docker daemon and no Supabase project. `npm run verify:db:up` then
  opening two browsers is the procedure; the test matrix records this as
  the open item.
