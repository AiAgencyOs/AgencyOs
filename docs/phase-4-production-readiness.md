# Phase 4 production readiness — status as of 2026-10-06

**Not certified.** Certification needs P0 = 0 and P1 = 0, a full regression, and the manual checkpoint; none of that is complete.

## Verified this session (real Postgres, red-proven)
Phase 5 start gate; QA independence at the door; QA-defect fix loop (UI + prototype); Admin prototype EDIT loop; Designer activation rule; Phase 4 SQL E2E (71 checks); `npm run db:verify:phase4` chains all of them (wired into `.github/workflows/verify.yml`).

## Known open items
| # | Item | Severity | Note |
|---|---|---|---|
| 1 | `finance.verify_payment` / `verify_payment_submission` admit the service role (the "runner", no signed-in user) by deliberate owner-decision wording ("the runner is unchanged"). A server-side caller using the admin client could verify. TS test `no-ai-route-verifies-payment` guards the routes. | P1 candidate — **needs an owner decision** | Hardening = refuse when `auth.uid()` is null; would require re-pointing `verify-payment-verification.mjs`, `verify-finance-w1.mjs`, phase-two/three e2e off the service key. |
| 2 | `send_prototype_for_client_review` lets the *owner* override the QA+Admin gate with an audited reason. | P2 | Spec says never share unreviewed; this is an owner-governed, audited exception. Confirm intended. |
| 3 | Design QA checks coverage only (not consistency/token usage/usability); findings are JSON, not a `qa.defects` row linked to a version. | P2 | |
| 4 | Duplicate/orphan client-feedback classification → Change Request routing on the **prototype** path not confirmed. | P2 (verify) | |
| 5 | "Received into the wrong account" is a free-text mismatch reason, not a structured check. | P2 | |
| 6 | Dedicated Admin screens for Design QA defects/retest, PM communication, Finance M2 are not separate pages (data present in panel/generic pages). | P2 | |
| 7 | Browser/device smoke of the prototype and the stub-model E2E (`verify-phase-four-e2e.mjs` sibling of Phase 3's) were not run here. | open | needs PostgREST + Next + model stub. |
| 8 | `scripts/verify-r2-roles-and-gates.mjs` was changed for the new gate but not executed (needs PostgREST). | open | |
| 9 | Figma write | MANUAL_FIGMA_REQUIRED | truthful state; not faked. |
