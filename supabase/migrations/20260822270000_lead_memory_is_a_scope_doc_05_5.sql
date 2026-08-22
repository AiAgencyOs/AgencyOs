-- ═══════════════════════════════════════════════════════════════════════════
-- Lead memory is a scope. Document 05 §5 says so and the column did not.
--
-- `ai.memory_records` was built with Doc 05 §22's visibility model as a column:
-- organization, client, project, agent, task. Document 05 §5 is a section
-- called **Lead Memory**, and there is no scope for it.
--
-- That is not a cosmetic gap. It is where almost all of this deployment's
-- memory would live: an agency with 1,200 inactive leads has one durable fact
-- per lead worth keeping — who actually decides, what they were burned by
-- last time, when they said they could start — and every one of them belongs
-- to a lead that has never become a client.
--
-- ── and the layer had no producer at all ────────────────────────────────
--
-- The table, its constraints and `ai.recall` have existed since 2026-08-21
-- and **nothing in the application writes or reads one**. That is the
-- tables-with-no-code state G-011 exists to prevent, and the reason it was
-- left is honest: writing memory means deciding what an agent may permanently
-- record about a client, and Doc 05 §17 ends with *"Never allow an AI
-- hallucination to silently become a permanent client fact."*
--
-- The existing constraints already answer it, which is why this is safe to
-- build now rather than a decision to take:
--
--   `memory_agent_cannot_verify`           an agent may never write `verified`
--   `memory_claimed_provenance_is_recorded` a row claiming to be `explicit`
--                                          must name the row it came from
--
-- So an agent may say *the client said this* only by pointing at the message
-- where they said it. A fact nobody can check is not representable — and the
-- one that is, is checkable by opening the thread.

alter table ai.memory_records
  drop constraint if exists memory_records_scope_check;

alter table ai.memory_records
  add constraint memory_records_scope_check check (
    scope in ('organization', 'client', 'lead', 'project', 'agent', 'task')
  );

comment on column ai.memory_records.scope is
  'Document 05 section 22''s visibility model, plus section 5''s Lead Memory - which the first version of this column omitted, and which is where almost all of this deployment''s memory lives: a lead that has never become a client still has one durable fact worth keeping.';

notify pgrst, 'reload schema';
