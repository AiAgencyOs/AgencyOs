# AgencyOS Admin Panel — Design System

What actually exists in `src/ui/`, `app/globals.css` and the admin shell,
not an aspiration. Every claim here is checked against the code; the
reference for the visual language is `admin panel ui single truth/` (see
`AGENCYOS_UI_SOURCE_AUDIT.md` §2 for what was taken from it).

## Tokens (`app/globals.css`)

All colour is CSS custom properties mapped to Tailwind utilities via
`@theme inline` (Tailwind v4, CSS-first — no `tailwind.config.ts`).
Components consume only semantic classes (`bg-surface`, `text-muted`,
`border-line`, `bg-brand-soft`) — never a raw hex or a raw Tailwind palette
colour — so re-theming is a `globals.css` edit.

- **Canvas:** the reference's cool light grey (`--background: #f5f7fb`,
  `--surface-sunken: #f8fafc`) with slate ink (`--foreground: #0f172a`,
  `--muted: #475569`, `--faint: #5b6b7d` — 5.2:1 on white). Dark theme
  unchanged.
- **Brand:** indigo (`--brand: #4F46E5`, `--accent: #6366F1`), from the
  reference screenshots. Light and dark variants defined.
- **Sidebar:** an isolated `--sidebar-*` namespace, defined only in `:root`
  (no dark override) so the rail stays dark navy regardless of the canvas
  theme — the same isolation pattern as `--wa-*` (WhatsApp).
- **Semantic tones:** `success` / `warning` / `danger` / `info`, mapped from
  status words in `src/ui/tokens.ts` (`statusTone`), so two screens showing
  the same status agree on its colour. Status is always word + colour, never
  colour alone.
- **Elevation:** four shadow steps plus the bubble shadow. **Motion:** every
  animation and transition collapses under `prefers-reduced-motion`.
- **Focus:** one `:focus-visible` ring everywhere, brand-coloured.

## The shell (`app/(internal)/layout.tsx`, `nav.tsx`, `nav-config.ts`)

- **Fifteen sectioned modules** in the rail, in the screen architecture's
  order, each collapsible; the module containing the current page opens
  itself; single-item modules and Command Center render flat. Contents are
  decided on the server (`visibleModulesFor(role)`), so the rail, the phone
  drawer, the bottom tabs, the ⌘K palette and the breadcrumb all read one
  capability-filtered list.
- **Current item** is the longest matching href at a segment boundary, so
  `/finance` and `/finance/payments` can both be in the rail with only one
  lit (`currentItem`, tested).
- **Global header** (`shell-controls.tsx`): the scoped search field with ⌘K,
  a dark **+ Create** button (raises `agencyos:open-create`; the palette
  opens on the first create the role may perform), the bell with a live
  count (`ActionBell`), a **?** help menu, and the signed-in person as an
  avatar · name · role chip whose menu holds Team & profile, Settings and
  the same sign-out form. The rail's foot is the organisation tile (name
  from `readOrganizationName`, the layout's one row read). The breadcrumb
  reads module › page › *record name*: a detail page renders
  `<TrailLabel name>` and the crumb echoes it (`agencyos:trail-label`).
- **Skip link** to `#main` for keyboard users; `main` is focusable.
- **Phone:** slide-over drawer (portalled, focus-managed, Escape) and a
  bottom tab bar with the four most-used destinations.

## Shared primitives (`src/ui/primitives/`, exported from `src/ui/index.ts`)

| Primitive | What it does | Notes |
|---|---|---|
| `Button`, `Card`, `Badge`/`StatusBadge`, `PageHeader`, `Drawer`, `FilterBar`/`FilterSearch`/`FilterChips`, `Field`, `EmptyState`, `PermissionDenied`, `StaleDataWarning`, `Callout` | The vocabulary every screen is built from. | `Drawer` is a native `<dialog>` (focus trap, inert background, Escape). |
| `DataTable` | One column description → a real `<table>` ≥ `lg`, stacked cards below. Sortable headers carry `aria-sort`. | **Sticky header now works:** `position: sticky` on each `<th>` (never the `<tr>`) inside a wrapper that becomes the table's own scroll box (`max-h-[calc(100vh-11rem)] overflow-y-auto`) when a table is longer than `STICKY_FROM_ROWS` (12). Pass `stickyHeader={false}` for a table inside a drawer. |
| `Stat` / `StatGrid` | KPI tiles with an optional pastel icon chip and trend badge — the reference KPI vocabulary. | Trend tone must be set when "up" is bad. |
| `KanbanBoard` | Drag-and-drop columns on `@dnd-kit`; the caller supplies `renderCard` and `onMove` so every move is a validated backend action. | Used by Project Board and Sales Pipeline. |
| `MonthGrid` | A real month calendar with `?month=` navigation. | Project Calendar. |
| `BarChart`, `DonutChart`, `TrendChart` | Recharts wrappers on the app's own CSS variables. | `currency` is a string prop, not a callback (server → client boundary). |
| `Skeleton*`, `SkeletonPage`, **`SkeletonDetail`** | Loading shapes. `SkeletonDetail` (new) is the 360-page shape: entity header, tab strip, two-column body. | Every route under `app/(internal)` — top-level *and* nested (`[leadId]`, `[projectId]`, `[clientId]`, `[invoiceId]`, `[requestId]`, `[meetingId]`, `[agentKey]`, `[batchId]`, `[opportunityId]`, `/design`, `/development`, the finance/agents/security sub-routes) — now has a `loading.tsx`. |
| `Pagination`, `paginate`, `sortRows`, `DecisionTimeline`, `StatusStepper` | List mechanics and history views. | — |
| **`Avatar`, `AvatarStack`** | Initials in a tint chosen from the name — stable per person across screens. `square` for a project/organisation. | No photos exist in the data model. |
| **`ProgressBar`** | Bar + printed percentage (`role="progressbar"`). | The number is always printed; the bar alone is colour-only. |
| **`EntityHeader`, `HeaderFigure`** | The 360 header: tile, name + status chip, subtitle, icon fact row, actions, boxed figure ("53% Overall progress", "Next follow-up"). | Reads nothing; the page passes facts from its own readers. |
| **`TabStrip`** | Icon-led underline tabs; current tab from the URL. | `ProjectSubNav` renders it for the fifteen project tabs. |
| **`DetailPanel` / `DetailFields`** | Right-rail key/value card with an Edit action. | — |
| **`QuickActions`** | Two-column action grid; a link for a page, a `node` for a governed write (the page's own server-action form). | Never fakes a result. |
| **`ActivityFeed`, `ViewAll`** | Icon chip · sentence · time; the brand "View all →" header link. | Items are timestamped facts the page read. |
| **`PipelineStrip`** | Chevron funnel of count-over-label stages, each linking to its list. | — |
| **`StatusList`** | "System Status" rows: icon, name, state word in tone. | Word + colour, never colour alone. |
| **`Timeline`** | Horizontal milestone dots (done / current / upcoming). | — |
| **`Gantt`** | Milestone windows as bars on one date axis with month ticks and a Today line. | Scales the caller's dates only; invents no duration. |
| `KanbanBoard` (extended) | Tinted column header with icon, count pill, `renderColumnAction` and `renderColumnFooter`. | Still owns dragging and layout only. |
| `DataTable` (`dense`) | Tighter rows and 13px type for a table inside a dashboard card. | — |
| `LiveRefresh` (`src/lib/realtime`) | The live-data control, replacing the deleted `AutoRefresh`. | Lives in `lib/realtime` because it needs the Supabase client; `src/ui` stays presentation-only. |

## Icons (`src/ui/icons.tsx`)

Inline SVG, `currentColor`, one `size` prop. Added for the sectioned rail:
`IconPalette` (Design & Prototype), `IconCode` (Development), `IconBell`
(notifications), `IconWifi` (reserved for connection state).

## States every data screen has

Loading (`loading.tsx`), empty (`EmptyState`, with the reason and the next
action), error (`app/(internal)/error.tsx`, "the page is wrong rather than
empty", with a digest for support), permission denied
(`PermissionDenied`), stale (`StaleDataWarning`, on screens whose reads
carry a known age), degraded transport (`LiveRefresh`'s status pill).
`DATA UNAVAILABLE` is rendered as prose, never as a `0`.

## Accessibility (verified in code, not yet by a screen-reader pass)

- Landmarks: `nav[aria-label]` ×3 (Sections, Primary, Breadcrumb), `main#main`.
- `aria-current="page"` on the current nav link; `aria-expanded`/`aria-controls`
  on collapsible modules; `aria-sort` on sorted headers; `role="status"
  aria-live="polite"` on the live pill; `aria-busy` on skeletons; icons
  `aria-hidden` unless labelled; every icon-only button has `aria-label`.
- Reduced motion honoured globally; focus ring on every focusable element.
- Status conveyed by word + colour everywhere (`StatusBadge`).

## Known limitations

- **Sticky header is bounded-height, not viewport-sticky.** A long table
  scrolls inside its own box under the page header. Viewport-sticky would
  require the wrapper to stop being a scroll container, which would remove
  the horizontal scroll a wide table needs. Bounded-height is the standard
  enterprise pattern and what the reference screenshots' long lists do.
- **Client portal** (`app/(client)/`) keeps the previous light theme; the
  dark shell is the internal admin's only.
- **axe-core (WCAG 2.1 AA): 10/10 screens clean** on 2026-09-29; `--faint`
  was raised to #536f7c for it (tertiary text was 3.0:1). No screen-reader
  pass yet — see the test matrix. Landmarks, labels, skip link and sticky header were confirmed
  in a real browser on 2026-09-29 (`scripts/local-qa/`).
- **Settings** sections are cards in a bounded column (`settings/layout.tsx`);
  the forms themselves keep their single-column field stacks.
