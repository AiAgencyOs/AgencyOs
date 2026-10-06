-- ═══════════════════════════════════════════════════════════════════════════
-- The Phase 9 Finance Agent additions are installed, DISABLED - ADM-115 (Phase 9, cross-phase finance)
-- ═══════════════════════════════════════════════════════════════════════════
-- The Finance Agent of the specification IS `finance` (installed, ADM-82's operations layer; it generates invoices from approved milestones and verifies
-- nothing). The specification names responsibilities `finance` does not cover as separate, reviewable identities. Three are installed here, each with
-- the narrowest job, none holding a tool, none able to verify a payment, change an amount, issue a refund, decide a waiver, close a book or message a
-- client. A definition is not an activation: every row is enabled = false. What each may PROPOSE is a record a person accepts or rejects
-- (finance.finance_proposals); creator != reviewer is enforced in the database.
--   finance_reconciliation - reconciliation findings and anomaly flags with evidence (drift is identified, never rewritten).
--   finance_communication  - reminder / payment-status DRAFTS only; sending stays with the existing reminder flow and a person.
--   finance_close          - close-readiness notes and exception classifications for a project's financial close; closes nothing.
insert into ai.agents (key, display_name, description, autonomy_level, enabled, default_model, default_effort, max_steps, max_cost_minor, disabled_reason)
values
  ('finance_reconciliation', 'Finance Reconciliation Agent', 'Compares what AgencyOS recorded with what the project and period books show and PROPOSES findings and anomaly flags with evidence. Rewrites nothing, verifies nothing.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-115. Needs a funded model key. Activation is a separate decision.'),
  ('finance_communication', 'Finance Communication Agent', 'Drafts payment reminders and payment-status messages from the invoice''s real outstanding balance. Drafts only: never sends, never promises a discount, waiver, refund or deferral.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-115. Needs a funded model key. Activation is a separate decision.'),
  ('finance_close', 'Finance Close Agent', 'Reads a project''s financial position and PROPOSES close-readiness notes and exception classifications. Closes nothing; the close is a person''s act.', 'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Granted by ADM-115. Needs a funded model key. Activation is a separate decision.')
on conflict (key) do nothing;

-- the mirror of the registry's handoffTargets: each hands work back to `finance` and to nobody else
insert into ai.agent_handoff_targets (from_agent, to_agent)
values ('finance_reconciliation', 'finance'), ('finance_communication', 'finance'), ('finance_close', 'finance')
on conflict (from_agent, to_agent) do nothing;

insert into ai.agent_verifiers (producer, verifier)
values ('finance_reconciliation', 'quality_assurance'), ('finance_communication', 'quality_assurance'), ('finance_close', 'quality_assurance')
on conflict (producer) do nothing;

notify pgrst, 'reload schema';
