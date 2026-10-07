# Phase 6 manual / external actions

| # | Item | Why manual | Unblocks |
|---|---|---|---|
| P6-M001 | ~~Supply `P604_Functional_Test_Agent.pdf`~~ **Supplied 2026-10-07 and reconciled** | the Functional agent's prompt now carries the P604 rules; see `docs/phase-6-implementation-traceability.md` (P6-P604-*) | nothing |
| P6-M002 | A funded model key and an isolated QA tenant/data for the nine QA specialists | provider billing and test-data authority are the owner's | any specialist running |
| P6-M003 | Browser/device access (real devices for "device" claims), load environment, security tooling | third-party/physical resources | UI/E2E, compatibility, performance, security evidence beyond manual entry |
| P6-M004 | Provider sandboxes/credentials for each integration | third-party accounts | API/integration tests that are not BLOCKED |
| P6-M005 | **Decision: `release_payment_overrides`.** An owner can override an unverified final milestone in the older release tab. P601 §41 says only Admin-verified M4 satisfies the Phase 7 gate. The new gate ignores the override; the old table and tab still exist | policy | removing or re-pointing the override |
| P6-M006 | Decision: the service-role exemption in `finance.verify_payment*` (carried from Phase 4) | policy | no non-human path to a verified payment |
| P6-M007 | Phase 7 owns production credentials, signing, DNS and store actions | outside Phase 6 by design | production launch |
