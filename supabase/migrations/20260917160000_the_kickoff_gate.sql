-- ═══════════════════════════════════════════════════════════════════════════
-- The kickoff gate.
--
-- Master §5.10, §5.11, §9, P2-08; PM §6 PM-08/09, §11, §15; Planning §12.
--
-- ── the list is the document's, not mine ─────────────────────────────────
--
-- §5.10 names the gates exactly: *"verify required onboarding data, WhatsApp
-- mapping if required, payment VERIFIED, planning ready and required
-- approvals."* Nothing is added to that list here. **Billing mode is
-- deliberately absent** even though §5.6 is part of Phase 2 — the payment gate
-- already implies an invoice, and an invoice already implies a confirmed mode
-- (G-255 refuses to issue without one), so adding it would be a second lock on
-- the same door rather than a new one.
--
-- ── the circularity that had to be cut ───────────────────────────────────
--
-- "Required onboarding data" is the checklist, and the checklist contains
-- `kickoff_sent` and `project_activated` — two items the kickoff ITSELF
-- completes. A gate demanding them would never open. They are excluded by
-- name, with `whatsapp_group_mapped` excluded too because the group gate below
-- covers it properly and reading it twice would let a stale checklist row
-- overrule the actual state.
--
-- That exclusion is the one judgement in this file, and it is written here
-- rather than inferred from the code.
--
-- ── no override, because §16 says so in words ────────────────────────────
--
-- `projects.start_project` has an override: ADM-13's three conditions may be
-- waived by somebody who says why. **This gate has none.** PM §15: *"Kickoff
-- gate fails → do not announce kickoff; surface missing gates."* An override
-- here would announce a kickoff to a client for a project that is not ready,
-- and unlike a status change that is not a thing anybody can take back.
--
-- ── and it does not send the message ─────────────────────────────────────
--
-- §5.11 is *"PM sends short official kickoff message in project WhatsApp
-- group"* and *"record kickoff timestamp/evidence"*. This records the
-- evidence; it does not send, because on this deployment there is nothing to
-- send through — the production WhatsApp number is BLK-003 and there is no
-- email channel at all (BLK-007). So the evidence reference is REQUIRED: a
-- kickoff with no evidence would be this system claiming a client was told
-- something nobody can show them being told.
--
-- When a channel exists, the sender fills that argument with a real message
-- id and nothing else here changes.
--
-- ── one path to ACTIVE ───────────────────────────────────────────────────
--
-- §5.11 also says *"set project ACTIVE and Phase 2 COMPLETED"*. The status
-- write goes through `projects.start_project`, the door that already owns it,
-- rather than an UPDATE here — a second way for a project to become active is
-- a second set of conditions to keep honest.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.phase_two_completed',
   'Master section 9 Phase2Completed - onboarding, payment, the group and the operational plan are all settled and the client has been told the project is starting. The project is ACTIVE.',
   true),
  ('project.phase_three_ready',
   'Master section 9 Phase3Ready - the structured handoff out of Phase 2. Nothing consumes it yet, exactly as Phase 1 emitted opportunity.handed_off with no receiver until Phase 2 existed.',
   true)
on conflict (type) do nothing;

-- ── the evaluator ────────────────────────────────────────────────────────
--
-- Returns the gaps rather than a bare boolean, because §5.10's second line is
-- "create explicit blocker/owner for any missing gate" and a gate that says no
-- without saying which is a gate somebody has to go and investigate.

create or replace function projects.pre_kickoff_readiness(p_project_id uuid)
returns table (
  ready                boolean,
  unmet                text[],
  onboarding_settled   boolean,
  group_ready          boolean,
  payment_verified     boolean,
  plan_ready           boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_onboarding boolean;
  v_group      boolean;
  v_payment    boolean;
  v_plan       boolean;
  v_unmet      text[] := '{}';
  v_start      record;
begin
  -- Every checklist item except the three the kickoff itself settles.
  --
  -- The checklist must EXIST as well as be settled. `not exists (... pending)`
  -- alone is true for a project with no checklist at all, so a project nobody
  -- ever onboarded would sail through the gate that exists to check it was —
  -- the absence-only assertion this repository has been caught by before.
  -- Found by driving it: a bare fixture reported `onboarding_settled` true.
  select
    exists (select 1 from projects.onboarding_items oi where oi.project_id = p_project_id)
    and not exists (
      select 1
        from projects.onboarding_items oi
       where oi.project_id = p_project_id
         and oi.status = 'pending'
         and oi.key not in ('kickoff_sent', 'project_activated', 'whatsapp_group_mapped')
    )
  into v_onboarding;

  -- "WhatsApp mapping IF REQUIRED": required exactly when a card was raised
  -- for this project. A project whose Phase 2 began before G-253 has no card,
  -- and demanding a state that nothing can produce would block it forever.
  select coalesce(
    (select gs.state in ('mapped', 'verified') from projects.group_setups gs where gs.project_id = p_project_id),
    true
  ) into v_group;

  -- Reused, not re-derived. `start_readiness.advance_verified` already follows
  -- `verified_minor` rather than `paid_minor` (G-007), which is the rule
  -- Finance §6 states as "proof never auto-verifies".
  select * into v_start from projects.start_readiness(p_project_id);
  v_payment := v_start.advance_verified;

  select exists (
    select 1 from projects.project_plans pp
     where pp.project_id = p_project_id and pp.status = 'active'
  ) into v_plan;

  -- THERE IS DELIBERATELY NO OPEN-QUESTION GATE HERE, and its absence was
  -- found by driving this rather than by reading it.
  --
  -- The first version of this function counted unresolved clarifications on
  -- the active plan. That count can never be anything but zero: a
  -- clarification may only be raised against a DRAFT plan (the door refuses
  -- `not_draft`, and `refuse_write_to_settled_plan` refuses the direct write),
  -- and G-257 already refuses to activate a plan carrying one. So the gate
  -- could not fail, while reading as though the kickoff checked for open
  -- questions — an absence-only assertion, one layer too late.
  --
  -- The rule is held where it can actually bite. If clarifications are ever
  -- made raisable against a live plan, this gate has to come back.

  if not v_onboarding then v_unmet := v_unmet || 'onboarding_incomplete'::text; end if;
  if not v_group     then v_unmet := v_unmet || 'whatsapp_group_not_mapped'::text; end if;
  if not v_payment   then v_unmet := v_unmet || 'advance_not_verified'::text; end if;
  if not v_plan      then v_unmet := v_unmet || 'no_active_plan'::text; end if;

  return query select
    array_length(v_unmet, 1) is null,
    v_unmet, v_onboarding, v_group, v_payment, v_plan;
end;
$$;

comment on function projects.pre_kickoff_readiness(uuid) is
  'Master section 5.10. Returns the gaps rather than a bare boolean, because section 5.10 asks for an explicit blocker for any missing gate. The list of gates is the document''s: billing mode is deliberately absent, because the payment gate already implies an invoice and an invoice already implies a confirmed mode.';

-- ── the kickoff ──────────────────────────────────────────────────────────

create or replace function projects.record_kickoff(
  p_project_id uuid,
  p_evidence_ref text
)
returns table (
  -- 'kicked_off' | 'already_done' | 'not_ready' | 'no_phase_two'
  -- | 'no_evidence' | 'unknown_project' | 'needs_person' | 'forbidden'
  -- | 'project_would_not_start'
  outcome text,
  unmet   text[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_phase   projects.phase_two;
  v_ready   record;
  v_started record;
  v_evidence text := nullif(btrim(coalesce(p_evidence_ref, '')), '');
begin
  -- §5.11's "record kickoff timestamp/evidence", enforced. A kickoff with no
  -- evidence is this system claiming a client was told something nobody can
  -- show them being told. Refused before the lock.
  if v_evidence is null then
    return query select 'no_evidence'::text, '{}'::text[]; return;
  end if;

  -- A PERSON. PM-09 is the PM sending a message to a client; on this
  -- deployment a person sends it, and the same person records that they did.
  if v_actor is null then
    return query select 'needs_person'::text, '{}'::text[]; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, '{}'::text[]; return;
  end if;

  if v_project.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, '{}'::text[]; return;
  end if;

  select pt.* into v_phase from projects.phase_two pt where pt.project_id = v_project.id;
  if v_phase.id is null then
    -- Phase 2 never started, so there is no phase to complete. Announcing a
    -- kickoff for one would be announcing the end of something that never
    -- began.
    return query select 'no_phase_two'::text, '{}'::text[]; return;
  end if;

  if v_phase.state = 'completed' then
    return query select 'already_done'::text, '{}'::text[]; return;
  end if;

  select * into v_ready from projects.pre_kickoff_readiness(v_project.id);
  -- No override. PM §15: "kickoff gate fails - do not announce kickoff;
  -- surface missing gates." The gaps come back so a person can act on them.
  if not v_ready.ready then
    return query select 'not_ready'::text, v_ready.unmet; return;
  end if;

  -- §5.11's "set project ACTIVE", through the door that already owns the
  -- status rather than an update here. A second way to become active is a
  -- second set of conditions to keep honest.
  select * into v_started from projects.start_project(v_project.id, null);
  if v_started.outcome not in ('started', 'already_active') then
    return query select 'project_would_not_start'::text, coalesce(v_started.unmet, '{}'::text[]); return;
  end if;

  -- PM §11's ladder, both steps, because the moment the message went out and
  -- the moment the phase closed are different facts even when they are one
  -- second apart.
  update projects.phase_two
     set state = 'kickoff_sent', kickoff_at = now()
   where id = v_phase.id;

  update projects.phase_two
     set state = 'completed', completed_at = now()
   where id = v_phase.id;

  perform core.emit_event(
    v_project.organization_id, 'project.phase_two_completed', 'project', v_project.id,
    jsonb_build_object('phase_two_id', v_phase.id, 'evidence_ref', v_evidence, 'kicked_off_by', v_actor),
    null
  );

  -- §9's structured handoff out. Nothing subscribes to it yet, which is the
  -- same shape Phase 1 shipped `opportunity.handed_off` in and for the same
  -- reason: the receiver is the next phase, and the next phase does not exist.
  perform core.emit_event(
    v_project.organization_id, 'project.phase_three_ready', 'project', v_project.id,
    jsonb_build_object('phase_two_id', v_phase.id, 'handoff_id', v_phase.handoff_id),
    null
  );

  perform core.record_audit(
    v_project.organization_id, 'project.phase_two_completed', 'project', v_project.id,
    jsonb_build_object('state', v_phase.state, 'project_status', v_project.status),
    jsonb_build_object('state', 'completed', 'project_status', 'active',
                       'evidence_ref', v_evidence, 'kicked_off_by', v_actor),
    null
  );

  return query select 'kicked_off'::text, '{}'::text[];
end;
$$;

comment on function projects.record_kickoff(uuid, text) is
  'Master section 5.11. Records that the kickoff message went out and closes Phase 2. It does not SEND: the production WhatsApp number is BLK-003 and there is no email channel (BLK-007), so the evidence reference is required rather than produced. No override: section 15 says a failed gate must not announce a kickoff, and unlike a status change that cannot be taken back.';

revoke all on function projects.pre_kickoff_readiness(uuid) from public;
revoke all on function projects.record_kickoff(uuid, text) from public;

grant execute on function projects.pre_kickoff_readiness(uuid) to authenticated, service_role;
grant execute on function projects.record_kickoff(uuid, text) to authenticated;

notify pgrst, 'reload schema';
