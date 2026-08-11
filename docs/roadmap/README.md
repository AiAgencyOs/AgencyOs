# roadmap

Purpose: Product roadmap, milestones, and release planning.

## Current

The roadmap lives in two places, and they must be kept in step:

- [`../../AGENCYOS_MASTER_DEVELOPMENT_PLAN.md`](../../AGENCYOS_MASTER_DEVELOPMENT_PLAN.md)
  — authoritative. Baseline, gap matrix, Admin decisions, phase order.
- [`roadmap.json`](./roadmap.json) — the same content, machine-readable.
  Regenerate it whenever the plan changes.

`roadmap.json` carries the gap ids (`G-nnn`), the Admin decision ids (`ADM-nn`),
the dependency edges between them, and the phase each belongs to, so tooling can
answer "what is unblocked right now" without parsing prose.
