# W1 — Finance: build report

Theme: SCR-050 to SCR-056, section 7 finance items, the finance-number disagreements. Migrations `20261006100000` to `20261006100400`. Live verifier `npm run db:verify:finance-w1` (scripts/verify-finance-w1.mjs, 37 checks, green). Tests: tests/finance-w1-presentation.test.ts, tests/finance-verified-basis.test.ts.

## The numbers: one verified-payment basis

`src/modules/finance/verified-basis.ts` (pure, tested): received = `invoices.verified_minor` (the database's own `net_verified_minor`: verified captured payments less recorded refunds); recorded-but-unverified is shown beside, never inside; outstanding = live invoiced − received; net = received − expenses. Used by Finance Overview, /invoices tiles and export, /finance/tax (register "Verified paid", P&L received from verified payments by verified date), the tax PDF and CSV, Expenses (net, margin), the project margin (`margin-queries.ts`), payments tiles. Local books now read: Total Received ₹7,500, Net ₹2,700 on overview, tax and payments (before: ₹21,000 / ₹7,500 / ₹9,999.99 and 16,200 / 2,700 / −6,600). The −6,600 that remains is the named per-project margin (after AI and time cost), not a third "net". Invoices whose stored paid amount no payment row backs are named in a callout (4 in the seed) instead of being summed. Not yet moved to the basis: clients overview / client commercials / dashboard "revenue this month" (`paid_minor`), listed as a follow-up.

Finance role parity: migration 100000 widens SELECT on the finance tables the screens read (receipts, claims, billing profiles, accounts, bank lines, reconciliation, locks, sends, refunds) to `is_finance()`; 100400 adds `finance.ai_cost_buckets()` (totals only, no prompt/output) so the AI term of a margin is the same for every role. Verified live and by screenshot: finance sees 3 receipts and the same tax page as the owner.

## Rows

| Row | Result |
|---|---|
| 050 Date filter | BUILT custom From/To range (overview + CSV); rendered |
| 050 Top project revenue | BUILT verified basis; unassigned invoices pool as "No project" |
| 050 Totals use verified records | BUILT (basis above) |
| 051 Type column/filter/creation paths | BUILT `invoices.kind` (trigger-written), column, chips, CSV; creation: milestone, change request, maintenance (existing) + composer (new service) |
| 051 PDF preview | BUILT inline preview on the invoice (iframe), row menu "Preview PDF" |
| 051 Send email + WhatsApp | NOT-BUILDABLE locally: no WhatsApp token / EMAIL_FROM; doors and forms exist on the invoice, row menu "Send or resend" links there |
| 051 Issue reminder | NOT-BUILDABLE (real send needs the same credentials); row menu links to the reminder section where it is recorded |
| 051 Void from list | BUILT row menu "Void…" to the invoice's void flow (reason, audited) |
| 051 Bulk select | BUILT selection + "Export selected (CSV)"; no bulk write by design |
| 051 Export | BUILT Export CSV with filters, logged |
| 052 Composer | BUILT /invoices/new: project (client, billing profile, tax mode from the confirmed profile), lines, live totals, review step, door `create_composed_invoice` |
| 052 Issue date | BUILT tile |
| 052 Tax calculation | BUILT CGST/SGST or IGST by place of supply (existing `splitTax`), reason stated for zero/unsplit tax |
| 052 PDF preview / Generate / review | BUILT (preview; composer = Generate; review step in composer and a pre-issue checklist on drafts) |
| 052 Resend | NOT-BUILDABLE (credentials) |
| 052 Attach client proof upload | OWNER-QUESTION |
| 052 Controlled billing change | BUILT link "Change billing details (a new confirmed version)" to the project's billing section |
| 052 Secret account credentials | BUILT masked account number, reveal only for invoice.issue (PDF to client unchanged) |
| 053 Payment detail | BUILT /finance/payments/[id]: payment, invoice match, proof/evidence, receipt, bank lines, reconciliation notes, verify button |
| 053 Proof/evidence | BUILT via claims linked by payment or reference |
| 053 Send to verification | BUILT as the detail page's "recorded, not verified" state + verify door; claims enter the queue on creation (accepted) |
| 053 Reject with reason | BUILT on the queue (seeded claim rendered) |
| 053 Filters / export | BUILT method, verification, client, dates, status + CSV |
| 054 Header/proof/reference/preview/context | BUILT and rendered with a seeded claim (amount, client, project, invoice, proof link/image, invoice totals and still-owed inline, bank cross-check) |
| 054 PAYMENT VERIFIED | BUILT dedicated button |
| 054 Reject / need more evidence | BUILT `request_payment_evidence` door + status `evidence_requested` (still decidable) |
| 054 Verification note | BUILT labelled note field, meaning per button |
| 054 Immutable audit data | BUILT guard freezes verified_by/at/evidence/reason once settled; verifier proves an owner cannot rewrite |
| 054 Search/filtering | BUILT search (client, invoice, reference, payer, amount in rupees) + status chips |
| 055 KPI row | BUILT total expenses, project margin, cost categories, budget vs actual |
| 055 Project profitability | BUILT one margin definition per project (verified revenue − expenses − AI − time) |
| 055 AI/tooling costs | BUILT list by agent (runs, tokens, cost) from totals only |
| 055 Attach receipt upload | OWNER-QUESTION (link-only file model decision; storage unreachable locally) |
| 055 Filters | BUILT category, project/overhead, vendor, dates + CSV |
| 056 Report status | BUILT tile: open / locked / exported |
| 056 Export history | BUILT every CSV/PDF logged (`report_exports`) beside GSTR, merged list |
| 056 GST configuration fields | OWNER-QUESTION |
| 056 Finance role parity | BUILT (above) |
| §7 Invoice numbering/terms | BUILT Settings › Finance: prefix, default terms days, terms note (door `set_invoice_numbering`, audited); numbering threaded through all invoice creators; note printed on the PDF |
| §7 won_requires_payment_evidence | BUILT switch (existing whitelisted door) |
| §7 Expense categories | OWNER-QUESTION only |

Counts: BUILT 36, OWNER-QUESTION 4 (+1 category), NOT-BUILDABLE 3.

## Owner questions

1. Attach client proof / receipt by upload: reverse the link-only file model for invoices and expenses?
2. GST configuration: which registration type, period basis and filing frequency values are valid for this agency (business/tax rule not in the specs)?
3. Expense categories: should the fixed list (infrastructure, ai, tooling, vendor, contractor, other) become editable, and with what vocabulary?
4. Should the finance role also read client names (core.client_accounts)? Today money screens show "Unknown client" to it by the G-314 design.
5. Should client-facing PDF "Paid / Balance due" use verified money (today: recorded)?

## Notes

Seeded rows (marker zzbuild-w1 / one claim and bank line on the ZZTEST G078 invoice) to be deleted at the end. The composer, payments detail and invoice detail could not be re-rendered at the end because another stream's design page was mid-edit; they rendered earlier and the doors are proven by the verifier.
