# Owner decisions on the reference gaps (2026-10-03)

Answered one by one by the owner. Each row is the decision, not a recommendation.

| # | Question | Decision |
|---|---|---|
| 1 | What is a sprint? | Per project, fixed length. A task can be placed in one sprint of its project. No capacity tracking. |
| 2 | Member department / Online? | Department only, from a fixed list. No Online indicator; the Team tab keeps "last active". |
| 3 | Communication tab name | Rename to **Discussion** (route may stay). |
| 4 | Project type, technology, tags | Type from a fixed list; technology and tags are free-text chips. |
| 5 | Requirement Priority and Assignee | Both, editable even after the scope is frozen (the frozen wording never changes). |
| 6 | Requirement attachments | Yes, by linking existing project files. |
| 7 | Files: New Folder and Grid/List | Both. Folders become real records; Grid/List toggle. |
| 8 | Thread classification | Client and Internal only. No Team tab. |
| 9 | QA phase | Yes, derived from QA runs (In QA = an open test run and no release). No manual status. |
| 10 | Contracts | Simple record linked to a won deal: title, file link, signer name, signed date, status draft/sent/signed. No e-signature. |
| 11 | Lead files | Yes, as links; they carry over to the project when the deal is won. |
| 12 | Add Agent | No. Agents stay in code. |
| 13 | Quotation Share before approval | No. Only after the owner approves. |
| 14 | Hot lead / No response | Hot = stage Qualified or beyond AND the lead replied in the last 7 days (no numeric score). No Response = 3 or more days of silence. |

## Build status, stream R2 (migration 20261005200000)

| # | Status | Where |
|---|---|---|
| 9 | Built | `src/lib/admin/qa-stage.ts` (pure, tested), Command Center pipeline "In QA" stage, "In QA" chip and `?status=in_qa` filter on Projects; lifecycle phase QA now means an open run |
| 10 | Built | `sales.contracts` + doors; `/contracts` (SCR-072, Sales & CRM tab); list on Lead 360 (won deal) and Client 360 Quotations tab |
| 11 | Built | `crm.lead_files` + doors; Lead 360 Files tab; carried once to the project from `convertToProject` via claim door |
| 12 | Nothing to build | No Add Agent control exists; agents stay in code |
| 13 | Nothing to build | Quotation Share is only offered after approval (internal link) |
| 14 | Built | Hot Leads / No Response in Leads rail Quick Filters (`src/modules/crm/lead-quick-filters.ts`); No Response counts silence from last inbound message or creation, only for new/qualifying/qualified leads |

## Round 2 — answers to the questions the PDF build left open (2026-10-01)

| # | Question | Decision |
|---|---|---|
| 1 | Lead numeric score | No number: show a Hot / Warm / Cold label from reasons (stage, recent reply, budget recorded). Matches ADM-88. |
| 2 | Payment schedule | Free plan stays; 30/20/30/20 tied to Phases 2, 4, 5, 6 is the pre-filled default when a quotation starts. |
| 3 | Group-name pattern | Fixed (four parts + one trailing word as today). |
| 4 | Blocker kinds | Confirmed: client answer, payment, dependency, decision, access, outside service, other. |
| 5 | Invoice proof / expense receipts | Upload allowed, under the project file rules and credentials guard; links still allowed. |
| 6 | Expense categories | Owner-editable list, starting from infrastructure, ai, tooling, vendor, contractor, other. Old expenses keep theirs. |
| 7 | Finance role and client names | Finance sees the client's name only (no contacts or other client data). |
| 8 | Client-facing PDF "Paid / Balance due" | Verified payments only. |
| 9 | GST setup | Regular taxpayer, monthly filing (GSTR-1 and GSTR-3B), period = calendar month. |
| 10 | Automation workflows | Stay in code. |
| 11 | Audit log | Keep forever; owner and ops admin may export; every export is itself logged. |
| 12 | Plan activation | Requires internal approval, enforced in the database. |
| 13 | Contract and migration checks | A GitHub workflow dispatched from the panel; the result is recorded. |
| 14 | AI / semantic search | Yes, over everything searchable. |
