# AgencyOS Admin Panel — Realtime Architecture

## What exists: polling, not push

There is no realtime transport anywhere in this codebase — no Supabase
Realtime channel subscription, no WebSocket, no SSE. A targeted grep across
every admin route, `src/modules/**`, and `src/lib/**` for `supabase.channel`,
`realtime`, `websocket`, `EventSource` returned zero matches before this
session, and nothing added one.

**This was a deliberate choice, not an oversight.** When asked to choose
between polling, real Supabase Realtime channels, or skipping realtime
entirely for this pass, the explicit answer was polling — full push-based
realtime is a real architectural addition (new subscription lifecycle,
reconnect/catch-up handling, cache-invalidation design per entity) that was
judged bigger than this reskin's scope.

## What "polling" means here

`src/ui/primitives/auto-refresh.tsx` — a client component that:

1. Calls `router.refresh()` on an interval while the tab is visible
   (`document.visibilityState === 'visible'`), re-running the page's own
   server-side reads.
2. Refreshes immediately on returning to a hidden tab, rather than waiting
   out whatever fraction of the interval elapsed while it was away.
3. Renders an honest "Updated Xs ago" caption plus a manual "Refresh" link —
   **never** a "LIVE" badge, since there is no push transport backing it and
   claiming otherwise would be a fake-optimistic-status violation of the
   same kind the finance/approval screens already guard against for actions.

## Where it's wired in, and why those screens

| Screen | Interval | Why |
|---|---|---|
| Dashboard (Command Center) | 20s | The one page an owner leaves open all day. |
| Approvals | 20s | A decision inbox — staleness here is a person waiting longer than they need to. |
| Operations | 15s | Job/queue health; the screen this session's own SCR-067 traceability entry says exists specifically to catch a stopped scheduler. |
| Notifications | 20s | Same "action queue" shape as Approvals. |
| QA | 30s | Defect queue; less time-sensitive than an approval or an incident. |
| Integrations | 30s | Health-monitoring surface, not an action queue — a slower interval is appropriate. |

Every other screen (Client 360, Project Board, Sales Pipeline, the finance
pages, etc.) relies on `revalidatePath` after a write (the Kanban drag, the
note-add, the stage-change) — each of *those* mutations correctly
revalidates its own page's cache, so the acting user sees their own change
immediately; only *other users'* concurrent changes to the same page would
need polling to surface without a manual navigation, and that gap is
accepted for this pass.

## What a real push-based implementation would need, if built later

1. **Transport choice**: Supabase Realtime (Postgres logical replication →
   websocket) is the natural fit since the whole stack is already Supabase —
   no new infrastructure, just a new client subscription per entity.
2. **Per-entity subscription design**: which tables/rows a given screen
   subscribes to (e.g. Project Board would subscribe to `projects.tasks`
   filtered by `project_id`), and how that maps to targeted
   cache-invalidation rather than a full-page refetch storm.
3. **Reconnect/catch-up**: what happens to a screen that was open during a
   dropped connection — the same "no stale UI after an important state
   transition" requirement the original brief calls out, which polling's
   focus-triggered immediate refresh already partially satisfies for free.
4. **A visible connection-state indicator** (`LIVE` / `RECONNECTING` /
   `DEGRADED`) — only meaningful once there is an actual channel whose state
   it reflects; adding one on top of polling would be exactly the "fake
   LIVE dot" the original brief explicitly prohibits.

None of this was built. This document exists so the *next* pass that does
build it starts from an accurate picture of what's here today, not from an
assumption that some realtime plumbing already exists to extend.
