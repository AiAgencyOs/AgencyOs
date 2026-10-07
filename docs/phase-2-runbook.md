# Phase 2 manual runbook

Phase 2 takes a WON deal to an officially started project. The happy path runs by itself; this is what a person does where the process says a person must, and what to do when it stops. It closes the "manual runbook" line of the Phase 2 Master Flow definition of done (P2-FLOW-031).

Who does what, in one line each: the **PM agent** talks to the client and owns onboarding; **Finance** owns the first invoice and the payment gate; **Project Planning** drafts the operational blueprint only; an **Admin** does the WhatsApp group step and everything marked "a person"; **only the owner** confirms that money arrived (migration `20261011390000`). Nothing here asks you to bypass a gate. If a step is blocked, the screen says which gate and who owns it.

Where to look first when a project is stuck: `/operations/phase-blockers` lists every Phase 2 and Phase 3 project that is waiting, who it is waiting on, why, and for how many days. `/operations/incidents` lists anything that failed and needs a person.

## What you need before you start

- A project that came from a WON deal. If the WON handoff was incomplete, Phase 2 does not start and says so; fix the deal (accepted quotation, billing preference), not the project.
- A WhatsApp number connected to the organization. **Not yet done in production (BLK-003):** until it is, every send in this runbook is recorded as not sent, and you do the step by hand and record it (each step says how).
- An email provider with SPF and DKIM set up, for the invoice email. Without it the email channel is recorded as skipped and the WhatsApp channel carries the invoice.
- The owner signed in for step 6.

## 1. Check the start

Open the project (Projects, then the project). The Phase 2 panel shows the state (`context_loading`, `waiting_client`, `waiting_admin`, `waiting_finance`, `waiting_planning`, `pre_kickoff_check`, `kickoff_ready`, `kickoff_sent`, `completed`, `blocked`).

1. The PM agent has been assigned and has read the context the deal already holds. It asks the client only for what is missing: if the client already told you something in Phase 1, it is not asked again.
2. The onboarding checklist on the project page shows each item as required, optional, received, verified, waiting on the client or not applicable. Mark an item received or not applicable yourself when the client sent it another way.
3. Anything the client sends in confidence (a credential) goes into the client-secrets panel, which stores it encrypted. Never ask a client to paste a password or key into WhatsApp; the welcome message tells them so.

If the state is `blocked`, open the panel: it names the reason. A missing handoff is fixed on the deal; a missing accepted quotation is fixed on the quotations screen.

## 2. The WhatsApp project group (a manual step, by design)

AgencyOS does not create WhatsApp groups. The platform does not offer it and the product never claims it did. The PM raises a manual-action card on the project page ("Group setup") and waits.

1. Open the project. On the **Group setup** card read the suggested group name, the client's numbers and the default internal team numbers. The default team is kept in Settings, Team (a roster you can edit); you can add or remove people for this project before you confirm.
2. In WhatsApp, create the group with that name and add those numbers. Use "Copy name and members" on the card if you want the name and member list on your clipboard.
3. Back on the card press **I have created the group**. That freezes the member list as a snapshot (a later change to the default team does not rewrite history).
4. Press **Map it** and give the supported reference for the group, then **I have checked it — the right people are in** once you have seen the group working. The card moves through `pending`, `created`, `mapped`, `verified`; each move records who and when.

If the group number is wrong, revise the setup before it is mapped; after that, correct it by mapping again with a note. If you never create the group, the project stays in `waiting_admin` and the kickoff gate names the group as the missing item.

## 3. Billing mode and the first invoice

1. The PM asks the client whether they need a **GST invoice** or a **Non-GST invoice**. A client's reply is never taken as the answer by itself: a person records it on the **Billing** panel (confirm billing mode). It is remembered for later milestones.
2. For GST, record the registered business name, GSTIN, billing address and state. The GSTIN is checked; a bad one is refused with the reason.
3. When billing is confirmed, Finance creates the **first milestone invoice (30 percent advance)** from the accepted quotation, once. Asking again returns the same invoice; a retry never makes a second one.
4. The invoice is delivered to the client's email and to the project group. Each channel records its own result. If a channel failed, the invoice screen shows it and offers a retry; the retry keeps the same invoice.

If no invoice appears: the billing panel says what is missing (usually GST details). If the invoice exists but delivery failed, retry the delivery from the invoice screen. If a job went dead, requeue it from `/operations` (dead letters) with a reason.

## 4. Payment: evidence is not money

1. The client pays and sends proof (a screenshot, a reference). Record it against the invoice: it becomes a **claim** in the state *pending verification*. A screenshot or a message never opens the gate on its own.
2. The claim appears on **Payment verification** (`/invoices/verify`) with the proof, the amount and the invoice, and a cross-check against any imported bank line.
3. **The owner** checks the money in the bank account and presses Confirm (or Reject with a reason, or Mismatch if the amount or reference does not agree). Confirm records who, when, how much and which invoice, and only then does the invoice count as paid and the finance gate open. An ops admin can prepare everything but cannot press Confirm.
4. A rejection or a mismatch keeps the gate closed and tells the PM, who tells the client in neutral words ("we could not match the payment details yet; a colleague will get in touch"). Resolve it with the client and record a fresh claim.

Never confirm a payment from a screenshot alone, and never record a confirmation on someone's behalf.

## 5. Planning and the pre-kickoff gate

1. When the advance is verified, Project Planning drafts the **operational blueprint** (deliverables, phases, dependencies, risks, readiness gates). It does not write code or database tasks. If something in the scope is ambiguous it flags it instead of guessing, and the PM puts a plain question to the client.
2. A person reviews the blueprint on the project's plan screen and activates it.
3. The **pre-kickoff readiness** check lists the gates: required onboarding items, the group mapped, the advance verified, the plan ready, and the requirement approved. Each unmet gate is named with an owner. There is no override: if a gate is unmet, the kickoff is refused and says which.

## 6. Kickoff

1. When the panel shows `kickoff_ready`, press **Send the kickoff to the project group, complete Phase 2**. The system re-checks every gate first, sends the short official message to the group through the governed send (consent, the 24-hour window and the kill switch still apply), and records the sent message as the evidence. Pressing twice does not send twice.
2. **If the WhatsApp number is not connected yet**, the send is refused and nothing is recorded. Send the message by hand in the group, then use the by-hand form on the same panel and paste the message's reference. The reference is required; a kickoff is never recorded without evidence.
3. Recording the kickoff sets the project active, marks Phase 2 completed and emits the Phase 3 handoff once. Phase 3 (design) starts from that handoff.

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Project stays in `waiting_client` | The client has not answered a question | Wait for the reminder, or contact the client yourself. The PM reminds on the schedule the owner set, inside the sending window, and never in the night. |
| Project stays in `waiting_admin` | The group is not confirmed and mapped, or a claim is waiting | Do step 2 or step 4. |
| Project stays in `waiting_finance` | The advance is not verified | Step 4; the owner confirms. |
| An invoice exists but the client says they never got it | A delivery channel failed or was skipped | Invoice screen, delivery history, retry the channel. |
| A message was held, not sent | Consent, the sending window, a quiet period or a kill switch refused it | The held message says which. Fix that cause; do not send it another way that skips the check. |
| A job is in dead letters | It ran out of attempts | `/operations`, read the error, requeue with a reason if the cause has passed, cancel if it will repeat. |
| The kickoff is refused | A gate is unmet | The refusal names it. Fix the gate; there is no override. |
| A task failed or may have had an effect | An agent task needs a person | `/operations/incidents`, and follow the runbook beside the row. |

## What is still manual or external

- The production WhatsApp number and approved templates (BLK-003): every live send.
- Email provider credentials and SPF/DKIM: the email channel.
- Creating the WhatsApp group: always a person.
- Confirming that money arrived: always the owner.
- A funded model for the planning blueprint: until one is configured the blueprint is not drafted by an agent and a person writes it.

## Evidence this runbook matches the product

The flow is exercised end to end against a real database by `scripts/verify-phase-two-e2e.mjs` (start, group, billing, first invoice, delivery, payment claim, owner confirmation, planning, early kickoff refused, kickoff, Phase 3 handoff), and the group step, the payment gate and the kickoff gate each have their own tests (`tests/the-group-is-a-manual-action.test.ts`, `tests/a-claim-is-not-a-payment.test.ts`, `tests/the-kickoff-gate.test.ts`). The sends were never exercised against a live WhatsApp number or a live email provider.
