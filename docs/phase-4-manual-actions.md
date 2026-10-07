# Phase 4 manual actions (QA, PM, Finance, Orchestrator)

Things the code cannot do for itself. Each is an owner or operator step; none is faked by the system.

## Wording pending owner approval

| Template | Where it is used | Wording lives in | State |
|---|---|---|---|
| `prototype-qa-blocked` (PM4-QA-BLOCKED, version 1) | Internal channel announcement when Prototype QA could not reach a verdict (`project.p4q_prototype_qa_blocked`). Never sent to a client. | `prototypeQaBlockedAnnouncementFor` in `src/modules/crm/schema.ts`; the template version is in `src/modules/p4q/pm4-templates.ts` | **Pending owner approval.** The wording is deliberately neutral and factual: it says QA did not reach a verdict, which of the two causes it was (a locked UI version is missing, or something outside the build was not available), that a blocker with an owner is recorded, and that the build is neither approved nor shown to the client. If the owner changes the text, raise the template version in the same change. |

## Steps that need a person or an account

| Item | Why the system cannot do it | What to do |
|---|---|---|
| Rendered layout, visual fidelity and role variants of a prototype (QAP-010, 011, 012, 078) | They need a headless browser run or a funded vision model; the structured build cannot answer them. They are recorded `not_verifiable`, never a pass. | Provide a funded vision-capable model or a browser-run environment, then a separate change adds the checks. |
| A model-backed prototype feedback classifier (P4-PM-010) | The keyword classifier is the stub-model proof only. Without a funded model the handler fails as `environment_missing`. | Fund the model provider. |
| Sending a prototype or receipt to a client over WhatsApp (P4-PM-005) | Needs WhatsApp credentials and an owner decision on the template. | Configure the WhatsApp number and approve templates. |
| Tax rate constant, credit notes, payment gateway, provider credentials (P4-FIN-019, 021, 049, 072) | Owner decisions and third-party accounts. | Owner decisions first; accounts second. |
| An agent fallback for a disabled specialist | The system considers and records a fallback (`projects.fallback_records`) and keeps the `disabled_specialist` escalation open. It does not hand the work to another agent. | A person enables the specialist or routes the work, then resolves the escalation. |
| A delivery recorded `unknown` | The provider did not answer, so the message may have gone out. | Check the client's WhatsApp (or the provider dashboard), then retry knowingly from Operations, or leave it. |
| Deferring a defect | Deferral is an Admin decision with a reason; an agent never defers. Deferring does not change the QA verdict. | An owner or ops admin uses the Defer control on the Phase 4 records page. |
| End-to-end run with PostgREST, Next and a stub model (P4-ORCH-047) | Needs infrastructure this work did not stand up. | Run the browser/PostgREST end-to-end check on a deployed preview. |
