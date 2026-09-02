-- A memory outlives all but its tenant — G-190.
--
-- ── the contradiction, found by a cleanup that silently failed ────────────
--
-- Doc 05 §32: *a memory is superseded, never deleted.* `refuse_memory_rewrite`
-- enforced it as an absolute — every DELETE raises, for every caller, service
-- role included.
--
-- `ai.memory_records.organization_id` is declared `on delete cascade`. The two
-- cannot both be true: an organization that had ever been remembered about
-- could not be deleted at all, because the cascade raises. **Tenant
-- offboarding was impossible**, and nothing said so.
--
-- It surfaced as a test-fixture problem, which is how these usually arrive.
-- G-189's new section in `verify-memory` creates a second agency, writes ten
-- memories under it and deletes it in a `finally` — the delete raised, the
-- `.catch(() => {})` swallowed it, and two later scripts in the CI chain
-- failed on the leftover organization: `verify-first-owner` requires exactly
-- one, and `verify-milestone-unlock` picked the wrong one and hit a tenancy
-- guard.
--
-- ── what the rule actually protects ───────────────────────────────────────
--
-- §32 is about REWRITING history: a person or an agent must not remove what
-- was remembered, because a memory that can be deleted is a memory that can be
-- made convenient. **It says nothing about the tenant ceasing to exist.** When
-- the organization goes, everything it owned goes with it, which is what the
-- foreign key already declared.
--
-- ── how the two are told apart ────────────────────────────────────────────
--
-- During a cascade the parent row is **already gone** by the time this trigger
-- runs — measured on this database rather than assumed. A direct delete has
-- its organization present, and is refused exactly as before.
--
-- REGENERATED FROM THE LIVE DEFINITION, not retyped: the three other refusals
-- this trigger holds — a superseded memory stays superseded, a superseded
-- memory is history, an agent-authored memory cannot become explicit — are
-- untouched because nothing here was written from memory (G-126).

CREATE OR REPLACE FUNCTION ai.refuse_memory_rewrite()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $$
begin
  if tg_op = 'DELETE' then
    /**
     * Except when the organization itself is going — G-190.
     *
     * Doc 05 §32's rule is about REWRITING history: a person or an agent must
     * not remove what was remembered. It was enforced as an absolute, and
     * `memory_records.organization_id` is declared `on delete cascade`, so the
     * two contradicted each other: a tenant that had ever been remembered
     * about could not be deleted at all. Found when a verification script's
     * own fixture organization would not go away, and its `.catch(() => {})`
     * swallowed the refusal — two later scripts in the chain then failed on
     * the residue.
     *
     * During a cascade the parent row is already gone by the time this runs,
     * which is what tells the two apart. A memory outlives everything except
     * the organization it belongs to.
     */
    if not exists (
      select 1 from core.organizations o where o.id = old.organization_id
    ) then
      return old;
    end if;

    raise exception 'a memory is superseded, never deleted (Doc 05 §32)'
      using errcode = 'check_violation';
  end if;

  if old.superseded_by is not null then
    if new.superseded_by is distinct from old.superseded_by then
      raise exception 'a superseded memory stays superseded (Doc 05 §32)'
        using errcode = 'check_violation';
    end if;

    if new.fact is distinct from old.fact
       or new.confidence is distinct from old.confidence
       or new.source_kind is distinct from old.source_kind
       or new.source_id   is distinct from old.source_id then
      raise exception 'a superseded memory is history; write a new one instead (Doc 05 §32)'
        using errcode = 'check_violation';
    end if;
  end if;

  -- An agent cannot raise its own row's confidence after the fact either. The
  -- CHECK covers `verified`; this covers the walk upward through the others.
  if old.authored_by_agent is not null
     and new.confidence = 'explicit' and old.confidence <> 'explicit' then
    raise exception 'an agent-authored memory cannot become explicit; a client or Admin states a fact, an agent infers one'
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

comment on function ai.refuse_memory_rewrite() is
  'Doc 05 §32 as a trigger: a memory is superseded, never deleted, and a superseded one is history. G-190 adds the single exception the foreign key already implied - when the ORGANIZATION is deleted its memories cascade with it, told apart from a direct delete by the parent row already being gone. Without it a tenant that had ever been remembered about could not be offboarded at all.';
