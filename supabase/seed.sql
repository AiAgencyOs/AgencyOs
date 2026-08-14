-- ═══════════════════════════════════════════════════════════════════════════
-- Seed data for development.
--
-- Idempotent: fixed UUIDs plus ON CONFLICT DO NOTHING, so it can be re-run
-- against an existing database without duplicating or erroring.
--
-- Deliberately creates NO auth users. Identities belong to Supabase Auth and
-- are created by the signup/invite flows in Feature 3; fabricating rows in
-- auth.users here would drift from whatever that flow actually produces.
-- Consequently every user reference below is left null.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Organization ──────────────────────────────────────────────────────────
insert into core.organizations (id, name, slug, currency)
values ('00000000-0000-4000-8000-000000000001', 'Demo Agency', 'demo-agency', 'INR')
on conflict (id) do nothing;

-- ── Client accounts ───────────────────────────────────────────────────────
insert into core.client_accounts (id, organization_id, name, billing_email, currency)
values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001',
   'Northwind Retail', 'accounts@northwind.example', 'INR'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001',
   'Kestrel Logistics', 'finance@kestrel.example', 'INR')
on conflict (id) do nothing;

-- ── Contacts ──────────────────────────────────────────────────────────────
insert into crm.contacts (id, organization_id, client_account_id, full_name, email, phone, company, job_title)
values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000101', 'Priya Raman', 'priya@northwind.example',
   '+919876543210', 'Northwind Retail', 'Head of Digital'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000102', 'Arjun Mehta', 'arjun@kestrel.example',
   '+919812345678', 'Kestrel Logistics', 'COO'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000001',
   null, 'Sana Qureshi', 'sana@brightleaf.example',
   '+919900112233', 'Brightleaf Foods', 'Founder')
on conflict (id) do nothing;

-- ── Leads, one per pipeline state so every UI branch has data ─────────────
insert into crm.leads (
  id, organization_id, contact_id, title, summary, source, source_ref,
  status, score, score_reasons, tags, requirements, qualified_at
)
values
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000203',
   'Brightleaf — D2C storefront rebuild',
   'Inbound via WhatsApp. Wants to replace a Shopify storefront with a custom stack.',
   'whatsapp', 'wa_919900112233_001',
   'qualifying', null, null, array['ecommerce','inbound'],
   '{"budget_band":"unknown","timeline":"Q4","platform":"unclear"}'::jsonb,
   null),

  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000201',
   'Northwind — loyalty programme app',
   'Referral from an existing client. Native mobile plus an admin console.',
   'referral', null,
   'qualified', 82,
   '{"reasons":["Budget confirmed","Decision maker engaged","Clear timeline"]}'::jsonb,
   array['mobile','loyalty','high-intent'],
   '{"budget_band":"15-25L","timeline":"10 weeks","platform":"iOS + Android"}'::jsonb,
   now() - interval '3 days'),

  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000202',
   'Kestrel — fleet tracking dashboard',
   'Web form enquiry. Real-time vehicle telemetry dashboard.',
   'web_form', null,
   'new', null, null, array['dashboard','logistics'],
   '{}'::jsonb, null),

  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000001',
   null,
   'Unnamed enquiry — budget mismatch',
   'Scope far exceeded the stated budget.',
   'web_form', null,
   'disqualified', 18,
   '{"reasons":["Budget below minimum engagement","No decision maker identified"]}'::jsonb,
   array['disqualified'],
   '{}'::jsonb, null)
on conflict (id) do nothing;

update crm.leads
   set disqualified_reason = 'Budget below minimum engagement size'
 where id = '00000000-0000-4000-8000-000000000304'
   and disqualified_reason is null;

-- ── Lead activity timeline ────────────────────────────────────────────────
insert into crm.lead_activities (id, organization_id, lead_id, kind, body, actor_type, occurred_at)
values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000301', 'message_in',
   'Hi, we need a new online store. Can you help?', 'client', now() - interval '2 days'),
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000301', 'message_out',
   'Happy to help. What is driving the move away from your current platform?',
   'agent', now() - interval '2 days' + interval '4 minutes'),
  ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000302', 'status_change',
   'Lead qualified with a score of 82.', 'agent', now() - interval '3 days')
on conflict (id) do nothing;

-- ── Agent registry ────────────────────────────────────────────────────────
-- Model ids and cost caps per ARCHITECTURE.md §6.2 / §6.4.
-- max_cost_minor is in paise: 500 = ₹5.00.
insert into ai.agents (key, display_name, description, autonomy_level, enabled,
                       default_model, default_effort, max_steps, max_cost_minor,
                       disabled_reason)
values
  -- Disabled by ADM-82: folded into the sales agent, which is layer 2 and not
  -- yet built. The definition is preserved rather than deleted, per the same
  -- decision, and `disabled_reason` is required by the constraint added in
  -- 20260814120002 — an agent off for an unrecorded reason is one somebody
  -- turns back on.
  ('lead_qualifier', 'Lead Qualifier',
   'Scores and tags inbound leads. Writes only to lead records; never contacts a client.',
   'L2', false, 'claude-sonnet-5', 'medium', 6, 500,
   'Folded into the sales agent by ADM-82; not an independent runtime agent. Definition preserved rather than deleted, per the same decision.'),

  -- The one agent that actually runs: reachable through AGENT_KEY in
  -- app/api/jobs/run/route.ts, and defined in src/modules/agents/registry.ts.
  ('requirement_collector', 'Requirement Collector',
   'Interviews a lead to gather structured project requirements. Proposes; a human sends.',
   'L1', true, 'claude-sonnet-5', 'medium', 20, 2000, null),

  -- Defined in the registry since F4 so the verification contract can exist:
  -- verdictFor refuses a verdict from an undefined agent, so with no QA
  -- definition the contract could not be exercised even in a test. Seeded
  -- DISABLED because a definition is not an activation — ADM-82 granted which
  -- agents exist and withheld implementation, and Phase 5 is a separate
  -- decision.
  ('quality_assurance', 'QA',
   'Decides whether submitted work amounts to completion. Rejects a claim that lacks evidence, and may not write the work it reviews.',
   'L2', false, 'claude-sonnet-5', 'high', 12, 2000,
   'Defined for the verification contract (ADM-83). Activation is Phase 5 and a separate decision under ADM-82.'),

  -- Disabled by ADM-82, and its description corrected. It read "Drafts scope,
  -- timeline, and pricing" — and ADM-22 with business rules 08 section 5.1
  -- forbid an agent inventing a price at ANY level, stating that approval does
  -- not make it permissible. "Requires owner approval" did not rescue it. A
  -- disabled row still misinforms an Admin reading the registry, so the text is
  -- corrected whatever the agent's state.
  ('proposal_drafter', 'Proposal Drafter',
   'Drafts scope and timeline from a qualified lead. Pricing is never an agent''s: ADM-22 and business rules 08 section 5.1 forbid an agent inventing a price at any level, and approval does not make it permissible.',
   'L1', false, 'claude-opus-5', 'high', 12, 3000,
   'Folded into the sales agent by ADM-82; not an independent runtime agent. Definition preserved rather than deleted, per the same decision.')
on conflict (key) do nothing;
