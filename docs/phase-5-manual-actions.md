# Phase 5 manual / external actions

| # | Item | Why manual | Unblocks |
|---|---|---|---|
| P5-M001 | A funded model key for the specialist agents (`ai.agents` rows are disabled) | provider account/billing is the owner's | any specialist actually running |
| P5-M002 | Repository + CI binding (`projects.repositories`, a CI token) | credentials | build pipeline, base commit, real builds |
| P5-M003 | Provider credentials/sandboxes for each project integration (WhatsApp, payments, OTP, Firebase…) | third-party accounts | `record_integration_check` can only verify with real adapter results |
| P5-M004 | Decide ADM-113 activation order and the first project to run | business decision | enabling any specialist |
| P5-M005 | Owner decision: close the service-role exemption in `finance.verify_payment*` | policy | removes the last non-human path to a verified payment |
| P5-M006 | Android emulator / Xcode for mobile projects | tooling not exercised here | mobile device tests (none claimed) |
