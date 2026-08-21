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
   -- No score. ADM-88 declined a numeric lead score, and until this change the
   -- seed carried 82 here with three invented reasons beside it - so every
   -- fresh environment showed an operator a scoring feature that does not
   -- exist. `crm.leads` now refuses both columns.
   'qualified', null, null,
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
   'disqualified', null, null,
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
--
-- MOVED to supabase/migrations/20260821150000_the_agent_registry_reaches_production.sql.
--
-- The roster, the handoff-target mirror and the verifier mirror used to live
-- here, and that is exactly why production had none of them: seed.sql is
-- applied by `supabase db reset` and by nothing else, while production is
-- migrated with `db push`. `quality_assurance` was absent from the production
-- registry, and both mirrors were empty tables, for as long as the rows lived
-- in this file.
--
-- They are reference data (Doc 21 §45), and reference data must be "versioned
-- and environment-safe". A migration is; a dev seed is not.
--
-- Deliberately not duplicated here. Two copies of a mirror are the drift the
-- mirror exists to prevent, and migrations run before this file, so `db reset`
-- already has the rows by the time seed.sql is read.
