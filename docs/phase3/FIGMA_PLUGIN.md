# AgencyOS Design Import - the Figma plugin

AgencyOS cannot create nodes in Figma: Figma's REST API reads files and writes comments, nothing more. So the writing is done by a small
plugin that runs **inside Figma**, in the open file, with the Admin's own Figma session. AgencyOS never holds the Admin's Figma login.

## What it does

1. The Admin opens **Project › Design › Figma** and presses **Create plugin code**.
2. In Figma the Admin runs the plugin, pastes the address, project id and code, and presses **Import screens**.
3. The plugin reads (from AgencyOS) the project's **finalized** screen list and the client's selected design direction.
4. It adds one new **page**: a Direction frame (palette swatches, type and shape tokens), then one wireframe frame per screen -
   header, purpose, a block per required datum, component and action - plus a smaller frame for each state the screen must handle
   (empty, loading, error, success). Every frame is named with its screen key (`SCR-001 - Order medicines`).
5. It reports back which frames it created (`file`, `page`, `[{key, screenId, name, nodeId}]`). AgencyOS keeps that as a record.

It draws **structure in the client's own colours and fonts**. It does not invent a visual design; a designer takes it from there.

## What it deliberately does not do

- It **links nothing**. A frame becomes a screen's (or a theme's) Figma reference only when a person links it on the Screens / Themes
  tab, where AgencyOS asks Figma that the node exists. "Figma is the source of truth" is never asserted on a plugin's say-so.
- It sends **no client contact detail, price or message** - the export is design structure only.
- It never overwrites: each run is a new page.

## Security

- The plugin has no AgencyOS login. It carries a **signed code** that names ONE project of ONE organization, expires in 24 hours, and
  is good for exactly two calls: `GET /api/design/figma/<project>` (read the export) and `POST /api/design/figma/<project>/report`.
- The code is signed with the deployment's vault key and cannot be edited into another project (the HMAC covers the payload).
- The routes read **no cookie**, so a web page cannot ride a signed-in Admin's session into them; the code in the `Authorization`
  header is the only authority. They answer CORS for any origin because the plugin runs in an iframe with none.
- The report is recorded under the **code's** organization, never one named in the body, validated (node ids, file key, at most 400
  frames, at most 200 KB) and written by a service-role-only function. The record is immutable history.
- Issuing a code and every import are audited (`figma_plugin.code_created`, `figma_plugin.imported`).

## Installing it (once)

In the Figma **desktop** app: Plugins → Development → **Import plugin from manifest…** → choose `figma-plugin/manifest.json` from this
repository. Before you share the plugin with anyone else, replace `"*"` in the manifest's `networkAccess.allowedDomains` with your
deployment's address (for example `https://agency-os.vercel.app`).

## Files

| File | Role |
|---|---|
| `figma-plugin/manifest.json`, `code.js`, `ui.html` | the plugin. Plain JavaScript, no build step. `buildSpec` (the layout, pure) is separate from `render` (the only part that touches the Figma API), so the layout is tested in Node |
| `src/modules/projects/figma-export.ts` | builds the export from the database |
| `src/modules/projects/figma-export-token.ts` | signs and verifies the plugin code (pure) |
| `app/api/design/figma/[projectId]/route.ts`, `report/route.ts` | the two routes |
| `supabase/migrations/20261014200000_figma_plugin_imports.sql` | the record table and its single writer |
| `app/(internal)/projects/[projectId]/design/figma/` | the Admin tab: instructions, create a code, what the plugin has built |
| `tests/figma-plugin.test.ts`, `scripts/verify-phase-three-e2e.mjs` § 13b | the proof |

## Proved inside Figma (2026-10-05)

Run in the Figma desktop app against a local AgencyOS (`http://localhost:3000`, which the manifest allows through `devAllowedDomains`) on a
project with two finalized screens and the "Calm Clinical" direction: the plugin reported **11 frames** and created a page with the
Direction frame (palette swatches and type) and, for each screen, its wireframe plus an Empty / Loading / Error / Success frame
(`orders - Orders (Error)` and so on). AgencyOS recorded the report (`projects.figma_plugin_imports`: 11 frames, linked to nothing).

Against the **live** deployment the same plugin authenticated, reached the API and was correctly told "This project has no finalized
screens yet" - the only project there is a cancelled test project whose design phase is locked.

## Trying it without a real project

Create a plugin code with the deployment's signing key for any local project that has finalized screens, run the dev server, and give the
plugin `http://localhost:3000`. A project from `verify-phase-three-e2e` works. Nothing in a deployed environment is touched.

## Still not done

- Importing a real client's project from the live deployment (none has reached a finalized screen list yet).
- Linking a created frame to its screen is still a person's act on the Screens tab.
