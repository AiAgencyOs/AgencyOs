-- ═════════════════════════════════════════════════════════════════
-- Phase 8D: the handoff edges the Phase 8 specs imply and the 8A roster lacked.
--
--   support          -> customer_success  (a ticket that is really a relationship problem), sales (an out-of-scope request is a new need)
--   customer_success -> support           (a client reports a fault during a check-in), finance (a billing question during a check-in)
--   sales            -> customer_success  (the return handoff once an expansion is accepted or lost)
--
-- Mirror of the literal `handoffTargets` arrays of those three definitions in src/modules/agents/registry.ts (ADM-83: the receiver must be a declared target in
-- the SENDER's definition, and Postgres cannot read TypeScript). `npm run check:record` section 16 counts the literal arrays against the seeded pairs, so
-- this file and the registry edit travel together. Additive; a handoff still needs the receiver to be enabled and every other ai.handoffs guard.
-- ═════════════════════════════════════════════════════════════════
insert into ai.agent_handoff_targets (from_agent, to_agent)
values ('support', 'customer_success'), ('support', 'sales'),
       ('customer_success', 'support'), ('customer_success', 'finance'),
       ('sales', 'customer_success')
on conflict (from_agent, to_agent) do nothing;

notify pgrst, 'reload schema';
