-- ═══════════════════════════════════════════════════════════════════════════
-- QA cannot pass its own design.
--
-- QAP header, §7; UID §19; ADM-82. `docs/phase-4-gap-analysis.md` step 3's
-- Design QA increment.
--
-- ── this is not a new verification mechanism — it is the existing one ────
--
-- ADM-82: *"no agent may declare another agent's work complete, and none may
-- declare its own."* `src/modules/agents/verification.ts` (`decideVerdict`)
-- already enforces exactly this — producer ≠ verifier, the producer's
-- DECLARED verifier only, and only an agent `mayVerify` — and
-- `ui_designer.verification.verifiedBy` has named `quality_assurance` since
-- the registry was written. The workflow this migration's door serves calls
-- that same function; this migration only gives its verdict somewhere to
-- land.
--
-- ── what "coverage" means here, and what it deliberately does not judge ───
--
-- The Design QA spec (UID §19, QAP §7) lists many things: requirement
-- coverage, screen coverage, states, consistency, token usage, visual
-- hierarchy, accessibility, usability. Of those, screen coverage and state
-- coverage against the LOCKED baseline are objective — every `screenKey` the
-- baseline names either appears in the draft or it does not, and every state
-- the baseline declared either is addressed or it is not. Consistency, token
-- usage and usability are judgment calls this migration's door does not make
-- and this increment does not build a model call for — recorded as a
-- deliberate, named scope boundary rather than a silent gap (`qa_findings`
-- carries only what was actually checked).
--
-- ── additive, not a rewrite ────────────────────────────────────────────────
--
-- `qa_findings`/`qa_reviewed_at` extend `projects.ui_versions`
-- (20260923110000) rather than a new table, because a QA verdict is a fact
-- ABOUT that row, not a separate entity with its own lifecycle yet — the same
-- reasoning that kept `design_token_sets`' status on the token set itself.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.ui_versions
  add column if not exists qa_findings   jsonb,
  add column if not exists qa_reviewed_at timestamptz;

comment on column projects.ui_versions.qa_findings is
  'What the deterministic Design QA coverage check found (missing screens, missing states, and the ADM-82 verdict reasons from src/modules/agents/verification.ts). Null until reviewed. Does NOT cover consistency, token usage or usability - those remain a named, undone part of the Design QA spec (see migration header).';

alter table projects.ui_versions
  add constraint ui_versions_qa_reviewed_is_dated
    check (status = 'draft' or qa_reviewed_at is not null);

insert into core.event_types (type, description, canonical) values
  ('project.ui_version_qa_reviewed',
   'QAP section 7 / UID section 19. Design QA reached a verdict on a Task 2 UI version draft: qa_pass or qa_changes_required. Decided by quality_assurance, never by the agent that drafted the version (ADM-82).',
   true)
on conflict (type) do nothing;

-- ── the door ───────────────────────────────────────────────────────────────

create or replace function projects.record_ui_version_qa_verdict(
  p_ui_version_id uuid,
  p_outcome       text,
  p_findings      jsonb
)
returns table (
  -- 'recorded' | 'already_reviewed' | 'unknown_version' | 'wrong_state'
  -- | 'bad_outcome' | 'no_actor' | 'forbidden'
  outcome       text,
  ui_version_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_version projects.ui_versions;
  v_org     uuid;
begin
  -- The service role reviews because the trigger is the quality_assurance
  -- WORKFLOW reacting to `project.ui_version_drafted` — the same shape every
  -- event-triggered door in this migration set uses. A person may also record
  -- one, which is why the actor path exists at all.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if p_outcome not in ('qa_pass', 'qa_changes_required') then
    return query select 'bad_outcome'::text, null::uuid; return;
  end if;

  select v.* into v_version
    from projects.ui_versions v
   where v.id = p_ui_version_id
   for update;

  if v_version.id is null then
    return query select 'unknown_version'::text, null::uuid; return;
  end if;

  v_org := v_version.organization_id;

  if v_actor is not null
     and (v_org is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_version.status <> 'draft' then
    -- Master §22's idempotent-replay shape: a redelivered
    -- `project.ui_version_drafted` event must not overwrite an existing
    -- verdict with a second, possibly different one.
    return query select 'already_reviewed'::text, v_version.id; return;
  end if;

  update projects.ui_versions
     set status = p_outcome,
         qa_findings = p_findings,
         qa_reviewed_at = now()
   where id = v_version.id;

  perform core.record_audit(
    v_org, 'project.ui_version_qa_reviewed', 'ui_version', v_version.id, null,
    jsonb_build_object('projectId', v_version.project_id, 'outcome', p_outcome)
  );

  perform core.emit_event(
    v_org, 'project.ui_version_qa_reviewed',
    'ui_version', v_version.id,
    jsonb_build_object('projectId', v_version.project_id, 'phaseFourId', v_version.phase_four_id, 'outcome', p_outcome)
  );

  return query select 'recorded'::text, v_version.id;
end;
$$;

comment on function projects.record_ui_version_qa_verdict(uuid, text, jsonb) is
  'QAP section 7. Records quality_assurance''s verdict on a Task 2 UI version draft, under the version''s own row lock. Refuses a version not in draft (already_reviewed), the same idempotent-replay shape Master section 22 asks every door for. Does not decide the verdict - the caller (the quality_assurance workflow) is where src/modules/agents/verification.ts''s producer-is-not-verifier rule is actually applied.';

revoke all on function projects.record_ui_version_qa_verdict(uuid, text, jsonb) from public, anon;
grant execute on function projects.record_ui_version_qa_verdict(uuid, text, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
