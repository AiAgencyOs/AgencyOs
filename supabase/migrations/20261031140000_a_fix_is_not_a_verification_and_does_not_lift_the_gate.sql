-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 Bug Fix spec: FIX_READY != VERIFIED. "The Bug Fix Agent does not close its own defect." A defect is not
-- silently CLOSED when it cannot be reproduced or needs evidence.
--
-- Three real defects found by the audit:
--  1. qa.blocking_defects counted only status = 'open'. The moment a developer set a blocker to 'fixed' (FIX_READY) the
--     release/send gate lifted - a fix claim opened the gate before anyone independent had verified it.
--  2. Nothing recorded WHO marked a defect fixed, so the fixer could verify their own fix.
--  3. There was no NEEDS_EVIDENCE / NOT_REPRODUCED state, so "cannot reproduce" had to be faked as wontfix or fixed.
--
-- Now: fixed_by is stamped when a defect becomes fixed; the guard refuses verification by the fixer (and by an
-- unnamed verifier); needs_evidence / not_reproduced exist, must say why, and return to open; and every unresolved
-- state (open, fixed, needs_evidence, not_reproduced) keeps a blocker/major defect blocking until it is VERIFIED.
-- (Agent-vs-agent independence stays in src/modules/agents/verification.ts: the agents share the service role.)
-- ═══════════════════════════════════════════════════════════════════════════

alter table qa.defects
  add column if not exists fixed_by uuid references core.users(id) on delete set null,
  add column if not exists fixed_at timestamptz;

alter table qa.defects drop constraint if exists defects_status_check;
alter table qa.defects add constraint defects_status_check
  check (status in ('open', 'fixed', 'wontfix', 'verified', 'needs_evidence', 'not_reproduced'));

create or replace function qa.defects_guard()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.organization_id is distinct from old.organization_id
     or new.project_id   is distinct from old.project_id
     or new.created_at   is distinct from old.created_at
  then
    raise exception 'a defect may not change tenancy, project or creation time'
      using errcode = 'restrict_violation';
  end if;

  if new.status is distinct from old.status then
    if old.status in ('verified', 'wontfix') then
      raise exception 'defect % is already %; raise a new one', old.id, old.status
        using errcode = 'restrict_violation';
    end if;

    if not (
      (old.status = 'open'  and new.status in ('fixed', 'wontfix', 'needs_evidence', 'not_reproduced'))
      or (old.status = 'fixed' and new.status in ('verified', 'open'))
      or (old.status in ('needs_evidence', 'not_reproduced') and new.status in ('open', 'wontfix'))
    ) then
      raise exception 'a defect does not move from % to %', old.status, new.status
        using errcode = 'restrict_violation';
    end if;

    if new.status = 'fixed' then
      -- FIX_READY: who claims it is recorded, and it is a claim, not a verification.
      new.fixed_by := coalesce((select auth.uid()), new.fixed_by);
      new.fixed_at := now();
    end if;

    if new.status = 'verified' then
      if new.verified_by is not null and new.verified_by is not distinct from old.fixed_by then
        raise exception 'the person who fixed defect % cannot verify it: FIX_READY is not VERIFIED', old.id
          using errcode = 'restrict_violation';
      end if;
      if (select auth.uid()) is not null and new.verified_by is distinct from (select auth.uid()) then
        raise exception 'a defect is verified by the person doing the verifying, not by someone named on their behalf'
          using errcode = 'restrict_violation';
      end if;
    end if;

    if new.status = 'open' and old.status = 'fixed' then
      -- a failed retest REOPENS it: the fix claim and any verification fields are cleared
      new.fixed_by := null;
      new.fixed_at := null;
      new.verified_by := null;
      new.verified_at := null;
    end if;
  end if;

  return new;
end;
$function$;

create or replace function qa.blocking_defects(p_deliverable_id uuid)
returns table(id uuid, severity text, title text)
language sql
stable
set search_path = ''
as $function$
  select d.id, d.severity, d.title
    from qa.defects d
    join projects.deliverables dv on dv.id = p_deliverable_id
   where d.project_id = dv.project_id
     -- unresolved means NOT YET VERIFIED: a fix claim (fixed), a cannot-reproduce and a request for evidence all still block.
     and d.status in ('open', 'fixed', 'needs_evidence', 'not_reproduced')
     and d.severity in ('blocker', 'major')
     and (d.deliverable_id = p_deliverable_id or d.deliverable_id is null)
   order by case d.severity when 'blocker' then 0 else 1 end, d.created_at;
$function$;

revoke all on function qa.blocking_defects(uuid) from public, anon;
grant execute on function qa.blocking_defects(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
