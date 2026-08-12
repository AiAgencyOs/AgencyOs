# scripts

Purpose: Utility scripts for setup, local development, database migrations, and maintenance tasks. Keep scripts idempotent and documented here.

| Script | What it does |
| --- | --- |
| `scan-secrets.mjs` | Refuses credentials and `.env`-family files in what git tracks (G-051) |
| `check-record.mjs` | Refuses to let the plan, `roadmap.json`, the README and the repository disagree (G-094) |
| `verify-target.mjs` | Guards the live scripts against a database that is not the one under test (G-083) |
| `verify-*.mjs` | Live verification against a real database — see `AGENCYOS_OPERATIONS.md` §3.2 |
