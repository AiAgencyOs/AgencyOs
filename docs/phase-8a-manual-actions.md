# Phase 8A manual actions

Everything here needs a person, a provider, a deployment or a decision that code cannot make. Nothing below was done by the build, and nothing claims it was.

## M-1 Confirm the numbers (owner or ops admin)

Open any project in Phase 8, then "Thresholds" at the bottom of the Phase 8 panel. These defaults apply until a value is saved. They are a starting point, not a business rule:

| Setting | Default | Meaning |
|---|---|---|
| `sla_response_hours_p1..p4` | 4, 8, 24, 72 | calendar hours from the raise time to the first reply a person records |
| `sla_resolution_hours_p1..p4` | 24, 72, 168, 336 | calendar hours to close |
| `health_open_tickets_watch` / `_at_risk` | 3 / 6 | open tickets that move health to WATCH / AT RISK |
| `health_sla_breaches_at_risk` | 2 | tickets that missed a target in 90 days for AT RISK (one is WATCH) |
| `health_overdue_invoices_at_risk` | 1 | overdue invoices on the project for AT RISK |
| `renewal_window_days` | 45 | days before a plan ends that a renewal review opens |
| `checkin_post_handover_days` | 7 | days after start that the first check-in is due |
| `checkin_min_gap_days` | 14 | minimum days between check-ins before another relationship message is allowed |

SLA hours are calendar hours; there are no business hours or holidays in the model. The critical rule (an open P1 past its resolution target) is not a setting: it is critical.
There is no weighted score: the spec's "configurable weights" were deliberately not built (earlier decisions refuse to invent weights; the signals and their thresholds are shown instead).

## M-2 Communication cadence, message categories and provider templates

Phase 8A sends nothing to a client. Before any operational message (ticket received, fix released, renewal reminder) is automated:
1. decide the message categories and the cadence per category (the spec's section 11);
2. have the WhatsApp templates for those messages approved by the provider (Meta);
3. configure quiet periods and message caps (not built: only the minimum gap and consent exist).

## M-3 Schedule the sweeps (needs a deploy change in the job runner)

The doors exist and are idempotent; nothing calls them on a schedule yet. As the service role:

```
select * from projects.sweep_support_sla();                 -- stamps missed SLA targets once, escalates to ops_admin, emits SLA events
select * from projects.sweep_maintenance_renewals();        -- flags plans inside the window, opens a renewal check-in, expires lapsed plans; never renews
select * from projects.record_health_snapshot(<project>, 'scheduled', <organization>);   -- per active workspace; writes only when the status changed
```

Suggested cadence: SLA hourly, renewals and health daily. Add them to the cron handler (`app/api/cron/*`) or the job runner; both take an injectable `p_now` for a rehearsal.

## M-4 Apply the four migrations

`20261105000000` to `20261105300000` are additive: new tables, new functions, one added column constraint on `projects.support_tickets` (which they create). They use the existing `projects` and `sales` schemas, so no PostgREST schema list change is needed. Review, then `npm run db:push`. Run `scripts/verify-phase-eight-a.sql` against a scratch copy first (see the log). Production code that is already deployed is unaffected.

## M-5 Feed client messages into tickets

`projects.open_support_ticket(p_organization_id, p_project_id, p_title, p_description, p_source, p_source_ref)` is the door; a repeated delivery with the same `p_source_ref` (the provider message id) returns `duplicate`. Nothing calls it from the inbound WhatsApp/email handlers yet. Wire the existing inbound handler for a project conversation to call it as the service role, only for a project whose Phase 8 has started.

## M-6 Swap in Phase 7's frozen completion handoff

When Phase 7 lands its snapshot table: edit only `projects.p8_build_intake` to read it (set `source = 'phase_seven_handoff'` and `phase_seven_handoff_ref` to its id), keep the gate ids, and subscribe `projects.fill_phase_eight_intake` to Phase 7's completion event. The gate, the workspace and the panel need no change. Until then, a person refreshes the intake from the project page, and writes the known limitations on the completion record (P8-GATE-007).

## M-7 Agent activation (a separate decision, not made here)

`support` and `customer_success` are enabled at L1 in the roster; `upsell` is off by the owner's activation answer. The three workflows in `app/api/jobs/run/phase-eight-cs-workflows.ts` are not yet in `RUNNABLE_WORKFLOWS`, and nothing enqueues them: running them needs the parent to spread `PHASE_EIGHT_CS_WORKFLOWS`, a funded model key, and a decision to enqueue. They are proved only against a stand-in model. Before enabling, check the agents' handoff edges (the log lists the ones the specs imply and the roster lacks).

## M-8 Acceptance with real data

1. Complete a real project; record its known limitations on the completion record; open the project page; refresh the intake; confirm each gate reads true.
2. Start Phase 8 with a real warranty window. Confirm the first check-in is due after the configured days.
3. Open a ticket, classify it, run it to a client confirmation you record with evidence; confirm it cannot close without it.
4. Make a deliberate overdue invoice or an old P1 on a test project; confirm health becomes AT RISK / CRITICAL with its reasons and a recovery plan opens.
5. Record an opportunity; confirm it is held while the account needs recovery, qualifies after, and hands a deal to Sales with no value.
6. Wording: read the five internal-channel announcements (PM8-M01, A01, A02, RECOVERY, RENEWAL-DUE) and approve the copy.

## Not built, and who decides

Maintenance plan CRUD and pricing, accepting a plan and its payment gate, the usage ledger, overage, renewal proposals and payment, cancellation and churn reasons, retention reports and value reports, VIP criteria, a service catalog, a knowledge base, client feedback capture, retention/deletion policy and the Admin dashboard charts: not in 8A. The VIP flag and a stored health score are refused on purpose: no criteria or weights have been configured and an agent may not decide them.
