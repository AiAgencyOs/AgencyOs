# Phase 2 — final report (2026-10-04)

Phase 2 converts a WON client into an operationally ready project: the Project Manager Agent talks to the client, the Finance Agent invoices and delivers, the Project Planning Agent drafts the blueprint, and two humans hold the gates (someone creates the WhatsApp group; the **owner** confirms the money). Source: the four locked PDFs in `phase 2 documents/`; the requirement-by-requirement matrix is [AGENCYOS_PHASE2_TRACEABILITY.md](AGENCYOS_PHASE2_TRACEABILITY.md) (2026-09-17, now partly superseded by this report).

## 1. What was found on 2026-10-04

Phase 2 had been built mid-September as a gate-and-record backbone. Re-auditing it against the PDFs, almost nothing acted on its own: no invoice was sent, the PM never contacted the client, nothing drafted a plan, the kickoff was a record not a message, and the project never left `planning`.

## 2. What was built (all merged, each CI-green)

| PR | Result |
| --- | --- |
| #544 | An issued invoice is **delivered** without a person: WhatsApp group → client thread → deal's direct thread fallback, or email. Idempotent claim/settle doors. |
| #545 | The PM talks to the client: welcome, GST/Non-GST question, GST-details request, payment status — code-written templates in English, Hinglish and Devanagari, sent once each under a stable reference. Billing mode stays a person's act. |
| #546 | The **Project Planning Agent** (`project_planning`): `invoice.paid` for the advance (or a manual request) → a draft blueprint; clarifications go to the client through the PM one at a time; **activation stays human**. |
| #547 | Free-maintenance ₹0 document; the Phase 2 state ladder follows the facts; GST advance invoice follows its details; "advance verified" is said only on `invoice.paid`; `verify-phase-two-e2e` (58 checks). |
| #548 | The owner sets how long the PM waits before reminding a client (Settings › Communication; ≤2 reminders). |
| #549 | **Only the owner confirms that money arrived** (`payment.verify`), enforced in the capability model, every screen, and the database. |
| #550 | **Per-project encrypted vault for client secrets** (ADM-106): ciphertext only, owner/ops admin, every opening audited. The PM now tells clients never to send secrets in chat. |
| #551 | Two mailboxes, two lanes: `care@` for everything a client is owed, `info@` for outreach only; neither borrows the other. |

## 3. Defects only driving the whole flow found

1. Milestones M1–M4 were off by one (the installer numbers plan positions from 0, the generators assumed 1 — so "M1" billed 20%). Now "the Nth **priced** milestone by order".
2. The project never left `planning`, so `start_project` refused every kickoff.
3. A GST project's first milestone job dead-lettered.
4. `verify_payment_submission` (the claims queue) did **not** mark the invoice paid — a checked claim is not money (G-272). The screen and the PM wording now say so.
5. The ADM-22 price trigger refused the system's own invoice/reminder messages.
6. The kickoff gate looked at the wrong requirement table.

Each was invisible to unit tests and regex checks; all were found by running the real chain.

## 4. Evidence

- `npm run check` (typecheck, lint, 8,280 unit tests, secret scan, record check) passes on main.
- Live verifiers, all in CI: `verify-invoice-delivery`, `verify-pm-client-comms` (27), `verify-planning-agent` (45), `verify-free-maintenance`, `verify-phase-two-e2e` (58), `verify-client-secrets` (32). The vault verifier was red-proved: removing the audit write turned four checks red.
- UI, in a real browser against the local stack: the kickoff button, the "Have the Planning Agent draft" button, and storing a client secret (encrypted, decrypts back to the typed value, hint shown). **Not completed in the browser:** the vault's *Show* and *Revoke* buttons — the local Docker VM's clock runs hours behind and expires a signed-in session within seconds; both doors are proved live through the database instead.
- All of the above ran against a **stub model**. No real-model pass of Phase 2 has been run.

## 5. What remains, and who owns it

| Item | Owner |
| --- | --- |
| Set the SMTP variables in Vercel (`SMTP_HOST=smtp.hostinger.com`, 465, `SMTP_SECURE=true`; `SMTP_USER/PASS/EMAIL_FROM` for `care@`; `SMTP_OUTREACH_USER/PASS` and `EMAIL_OUTREACH_FROM` for `info@`) and add SPF/DKIM/DMARC in Hostinger ("Fix this"). | Owner |
| Production WhatsApp number (BLK-003): Meta business verification, then the steps in `docs/phase1/OWNER_UNBLOCK_GUIDE.md` §4. | Owner |
| Read and approve `docs/phase1/OWNER_REVIEW_TRANSLATED_TERMS.md` before `quotation_translate_standards` is enabled. | Owner |
| Set `onboarding_followup_days = 2` in production Settings › Communication (the local database has it; production does not). | Owner |
| Real-model live pass of Phase 1 + 2 (needs a funded model account; OpenRouter key already configured locally). A Monday 2026-10-05 11:00 IST retest task is scheduled. | Owner funds, then Claude |
| An outreach **campaign** (the `info@` lane exists; nothing sends through it). | Not scheduled |
| `Phase3Ready` has no subscriber — Phase 3 begins from a person's action, not an automatic announcement. | By design until Phase 3 is specified |

## 6. Manual steps Phase 2 will always need

A person creates the WhatsApp group and links it; a person chooses GST vs Non-GST on the client's answer; the **owner** confirms the money; a person approves and activates the blueprint; a person records the kickoff. These are the PDFs' own human gates and are deliberately not automated.
