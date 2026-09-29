# AgencyOS Admin Panel — Design System

What actually exists in `src/ui/` and `app/globals.css` after the reskin, not
an aspiration. Every claim here was verified against the running app.

## Tokens (`app/globals.css`)

All color is CSS custom properties, mapped to Tailwind utilities via
`@theme inline` (Tailwind v4, CSS-first — there is no `tailwind.config.ts`).
Components consume only semantic classes (`bg-surface`, `text-muted`,
`border-line`, `bg-brand-soft`) — never a raw hex or a raw Tailwind palette
color — so re-theming is entirely a `globals.css` edit, verified by the fact
that the whole brand rebrand in this session touched only that file's
`:root`/dark blocks plus the two files (`nav.tsx`, `layout.tsx`) that apply
the sidebar's own token set.

- **Brand**: indigo (`--brand: #4F46E5`, `--accent: #6366F1`), replacing the
  prior teal-navy brand, per the reference screenshots in
  `admin panel ui single truth/`. Light and dark variants both defined.
- **Sidebar**: an isolated `--sidebar-*` namespace (`--sidebar-bg`,
  `-border`, `-fg`, `-muted`, `-hover`, `-active-bg`, `-active-fg`), defined
  only in `:root` (no dark-mode override) so the desktop rail and the mobile
  drawer stay permanently dark navy regardless of the canvas's light/dark
  state — mirroring the existing `--wa-*` (WhatsApp) isolation pattern for
  the same reason: a `sidebar-` token outside the rail is a bug you can grep
  for.
- **Semantic status tones**: `success`/`warning`/`danger`/`info` (green/
  amber/red/blue), unchanged from before the reskin — they already matched
  the reference screenshots' status-chip vocabulary.

## Shared primitives (`src/ui/primitives/`, exported from `src/ui/index.ts`)

| Primitive | What it does | Added/changed this session |
|---|---|---|
| `Button`, `Card`, `Badge`/`StatusBadge`, `PageHeader`, `Drawer`, `FilterBar` | Pre-existing, unchanged. | — |
| `DataTable` | Two renders from one column description: real `<table>` ≥`md`, stacked cards below. | Unchanged structurally; a `sticky` header was tried and **reverted** — see "Known limitations" below. |
| `Stat`/`StatGrid` | KPI tiles. | Added an optional colored icon chip (pastel rounded-square, tone-matched) and an optional `trend` delta badge. Purely additive — existing call sites with no icon/trend are pixel-identical to before. |
| `MonthGrid` (new) | A real month calendar grid — leading/trailing days grayed, today highlighted, entries as colored-dot links, "+N more" overflow. Navigation via `?month=YYYY-MM` links (GET-based, matching `FilterBar`'s convention — no client state). | New. Wired into Project Calendar (SCR-022) alongside the existing agenda list. |
| `KanbanBoard` (new) | Drag-and-drop columns, built on `@dnd-kit/core`. Deliberately owns only layout/dragging — the caller supplies `renderCard` and an `onMove(itemId, toColumnId)` callback, so every board built on it stays routed through whatever validated backend action the caller already has. Optimistic column reassignment, reconciled by the next server-revalidated `items` prop. | New. Wired into Project Board (SCR-020, task status) and Sales Pipeline (SCR-005, opportunity stage — restricted to the three open stages; `won`/`lost` stay on the Lead 360 panel's guarded flow). |
| `BarChart`, `DonutChart`, `TrendChart` (`src/ui/primitives/chart.tsx`, new file) | Recharts wrappers, colors drawn from the app's own CSS vars (never a separate chart palette). `BarChart` is the promoted, renamed `SimpleBarChart` that used to live in `app/(internal)/reports/`. `DonutChart` and `TrendChart` are new. | Formatting is a `currency?: string` prop, not a callback function — **required**, since these are `'use client'` components rendered from Server Component pages, and Next.js cannot pass a plain function across that boundary (this was a real, live-reproduced crash; see the test matrix). |
| `AutoRefresh` (new) | Client-side `router.refresh()` on an interval (visibility-aware: refreshes immediately on tab-focus rather than waiting out a stale interval). Renders "Updated Xs ago" + a manual Refresh link — never claims "LIVE", since there is no push transport backing it. | New. Wired into Dashboard, Approvals, Operations, Notifications, QA, Integrations (15–30s intervals, tuned per screen's urgency). |

## Known limitations (found by live testing, not by inspection)

- **No sticky table header.** The design source's shared-component rule
  ("sticky column headers on long lists") was attempted via `position:
  sticky` on the header `<tr>`. In a real browser this broke the table's own
  row-stacking — the first body row rendered overlapping the header instead
  of below it. Reverted. A real sticky header would need a non-table layout
  (CSS grid) to do safely; that is a bigger change than this reskin's scope.
- **Mobile drawer nav is dark-themed; no other client-facing surface is.**
  The reskin's dark-sidebar treatment was applied to the internal admin
  shell only (desktop rail + mobile drawer). The client portal (`app/
  (client)/`) was not touched and was not in scope.
- **`Stat`'s "disabled/read-only" Kanban path is currently unreachable by
  any real role.** Every internal role holding `project.read`/`lead.read`
  in `src/lib/authz/permissions.ts` also holds the matching write
  capability (`task.write`/`lead.write`) — there is no role today that can
  view a board but not drag on it. The defensive `canWrite`/`disabled` prop
  on `KanbanBoard` is still correct (server-side `can()` checks are the real
  enforcement regardless of what the UI shows), just not currently exercised
  by the permission matrix as it stands.
