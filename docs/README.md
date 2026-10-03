# docs - Project Documentation

This folder contains architecture notes, business context, database documentation, agent designs, API documentation, frontend and backend guides, testing plans, deployment guides, roadmap, sprint plans, and decision records.

Each subfolder contains a README.md to start documenting topics.

## Admin panel program (living evidence)

| Document | What it is |
|---|---|
| `AGENCYOS_UI_SOURCE_AUDIT.md` | The design source folder, every file, the visual language taken from it, conflicts and how they were resolved |
| `AGENCYOS_ADMIN_MASTER_SCREEN_INVENTORY.md` | The 71 screens with permanent `SCR-` IDs, route, guard, data, live topics, status |
| `AGENCYOS_ADMIN_UI_IMPLEMENTATION_MATRIX.md` | Route → component → data → policy mapping and the classification history |
| `AGENCYOS_ADMIN_DESIGN_SYSTEM.md` | Tokens, shell, primitives, states, accessibility — as built |
| `AGENCYOS_ADMIN_REALTIME_ARCHITECTURE.md` | The push chain, topics, reconnect/catch-up, what is and is not verified |
| `AGENCYOS_ADMIN_CONFIGURABILITY_AUDIT.md` | Every hardcoded business value, classified A–E, with what moved to Settings |
| `AGENCYOS_ADMIN_TEST_MATRIX.md` | What was run, real results, and the open items |
| `admin-panel-screen-traceability.md` | The per-screen decisions (DECLINED / PARTIAL reasoning) |
