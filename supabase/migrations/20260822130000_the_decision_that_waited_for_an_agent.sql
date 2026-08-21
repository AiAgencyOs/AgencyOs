-- ═══════════════════════════════════════════════════════════════════════════
-- The decision that waited for an agent.
--
-- **ADM-16, granted 2026-08-13:** *"The breakdown from approved requirements
-- into modules, features and tasks is **automatic** — the AI does it without
-- proposing it for review."*
--
-- `projects.break_down_requirement` was written for that decision on the same
-- day. It validates the plan rather than trusting it, records the requirement
-- version on every row it writes, refuses a version that is not accepted,
-- refuses one belonging to another project's lead — *"which would otherwise
-- produce a plausible breakdown of the wrong client's scope"* — and answers
-- rather than duplicating when the same version arrives twice, because, in its
-- own words, *"a retrying agent is the ordinary case."*
--
-- **No agent ever called it.** The chain stopped one step short: an agent
-- proposes a requirement, a person accepts it, and then nothing happens. The
-- function has sat there for nine days waiting for the caller its comments
-- describe.
--
-- ── what this adds, and how little it is ────────────────────────────────
--
-- One event and one flag. The acceptance already exists; the write path
-- already exists and is already proved; the transaction, the provenance and
-- the wrong-client refusal are all somebody else's work. The only thing that
-- was missing is the sentence that says *when* to do it, and the plan itself.
--
-- ── `ScopeApproved` — Doc 23 §7's sixth ─────────────────────────────────
--
-- A requirement version becoming `accepted` **is** the scope being approved:
-- it is the moment the client's stated needs stop being a proposal and become
-- the thing the project is measured against. That is §7's `ScopeApproved`, and
-- it is emitted from the row whose change it describes, like the other seven.
-- Eight of twenty-six.
--
-- ── and what the agent may not put in the plan ──────────────────────────
--
-- The schema it answers with carries a module name, a feature name, a task
-- title, a description, a priority and an estimate. It has **no status**, so
-- Doc 10 §25 holds by construction — *"a project should be marked BLOCKED when
-- work cannot safely continue, not when an agent merely feels uncertain"* —
-- and every task lands on the column's own `todo` default. It has **no
-- assignee**, because Doc 10 §9 makes specialist assignment its own act. It
-- has **no due date**, because a date on a task reads as a commitment and
-- nothing lets an agent make one. And it names **no milestone**, because Doc
-- 10 §18 ties milestones to the payment plan, which ADM-22 keeps with a human.
--
-- Four absences, one pattern, and the same one as the last three changes: the
-- capability is not guarded, it does not exist.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('requirement.accepted',
   'A person accepted a requirement version, so the scope is agreed (ADM-16).',
   'ScopeApproved')
on conflict (type) do nothing;

update core.canonical_events
   set emitted_as = 'requirement.accepted'
 where name = 'ScopeApproved';

create or replace function crm.emit_requirement_accepted()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    perform core.emit_event(
      new.organization_id, 'requirement.accepted', 'requirement_version', new.id,
      jsonb_build_object(
        'conversation_id', new.conversation_id,
        'version', new.version
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_requirement_accepted on crm.requirement_versions;
create trigger emit_requirement_accepted
  after update of status on crm.requirement_versions
  for each row execute function crm.emit_requirement_accepted();

comment on function crm.emit_requirement_accepted() is
  'Doc 23 section 7''s ScopeApproved, emitted where the acceptance lands. The subscription in src/lib/events/catalog.ts turns it into a plan.breakdown job, which is the caller projects.break_down_requirement has described in its own comments since ADM-16 was granted and never had.';

-- ── the third agent, enabled because there is now something it can do ────

update ai.agents
   set enabled = true,
       disabled_reason = null
 where key = 'project_manager';

notify pgrst, 'reload schema';
