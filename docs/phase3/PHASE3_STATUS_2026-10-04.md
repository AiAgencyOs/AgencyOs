# Phase 3 (UI theme + colour finalization) - status, 2026-10-04

Sources: the three locked Phase 3 PDFs in `phase 3 documents/`. Requirement extract (659 rows, 19 contradictions, 30 soft/open values): [PHASE3_REQUIREMENTS_EXTRACT.md](PHASE3_REQUIREMENTS_EXTRACT.md). Older matrix: [AGENCYOS_PHASE3_TRACEABILITY.md](AGENCYOS_PHASE3_TRACEABILITY.md).

## What the 2026-10-04 audit found

Almost all of Phase 3 was already built (workspace + state machine, screen baseline, theme/colour options with the 2-3 ceiling, tokens, representative screens, internal review, Admin confirm/edit, the client share + decision + revision engine with a limit, scope-change protection, the lock and the Phase 4 handoff, Admin pages, cost attribution). Driving the whole flow end to end found what the unit-level work could not:

| Defect found by driving the flow | Fix |
| --- | --- |
| The screen list could not be opened or finalized from the app - `finalize_screen_baseline` had no caller, and it is the event that starts the designer's theme run. | `ScreenBaselinePanel` on the screens page: open the list, finalize it (the door still refuses an empty list or an uncovered requirement and says which). |
| The PM never told the client Phase 3 had begun (`project.phase_three_started` had no subscriber). | `projects:announcePhaseThree` - the organisation's template or PM §11 verbatim, sent once, row-authoritative. |
| A client's theme selection led nowhere - nobody asked for the explicit final confirmation. | `projects:askFinalDesignConfirmation` - asks once; only the recorded confirmation locks. |
| "Share with the client" only recorded a send somebody made elsewhere. | `shareDesignWithClient`: sends the approved options (names + Figma/preview links) to the project group and records the share with that message as evidence; the manual record remains for clients with no thread. |
| **A stopped phase had no way out.** Scope escalation, the revision limit and a blocked requirement stop the phase on purpose (Master §16-§17) but nothing ever resumed it - the only exit was SQL, and `open_design_revision` refuses while escalated. | `projects.resolve_phase_three_stop`: admin-only, a written reason, names which way the stop was answered, immutable history (`phase_three_stop_resolutions`); `ResolveStopForm` on the design overview. |

## Evidence

`scripts/verify-phase-three-e2e.mjs` (111 checks, in CI): Phase 2 kickoff -> Phase 3 starts once -> PM announcement (once, no provider/model named) -> designer drafts screens from the approved scope -> no theme before the list is finalized -> person finalizes -> three directions with palettes, the model asked once -> Figma node linked by a person -> an unapproved option cannot be shared -> Admin cannot decide before internal review -> reviewer sends back, passes -> Admin EDIT returns it through review and the edit stays on the record -> exact set shared is on the record -> a client cannot select what they were not shown -> a request for NEW features stops the phase (a change request opens) -> a member cannot resolve the stop, an admin can, with a reason -> selection makes the PM ask for confirmation once -> a selection alone does not lock -> final confirmation + primitives + approved sample screen -> locked, Phase 4 READY, exact Figma node in the handoff -> Phase 4 starts only after the lock -> no job died, nothing sent twice. Red-proved twice (removing the announcement subscription; removing the admin check from the resolution door) - 5 and 4 checks went red.

## Honest limits (not claimed)

- **Figma is read-only.** There is no create-file/create-node capability; a designer draws the frames and a person links the node (`link_theme_figma`). Nothing says "created in Figma" unless a person linked it. This is the PDFs' own CASE B/C ("expose the manual step, do not fake").
- Every model run used a **stub**. A real-model pass of the designer is outstanding (same blocker as Phase 1/2: a funded account).
- A client's reply is classified by a **person** (six classes, original words kept). The agent classifier exists for Phase 4 UI versions only; wiring it to Phase 3 replies is not done.
- No client portal path for design review - the client answers in the WhatsApp project group, a person records it.
- Design message templates are English + Hinglish; a Hindi client reads English.
- The browser-pane check of the three new controls (finalize list, send-and-record, resolve stop) has not been done; the local session expires within minutes (Docker clock skew).
- The older `verify-phase-three.mjs` cannot run locally for the same clock reason; it runs in CI.

## Still owner/human

Figma file access and the file/page for the project; the internal reviewer assignment (default reviewer is settable in Settings); the default client revision limit (3 today); provider keys for a real-model run.
