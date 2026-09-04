-- ═══════════════════════════════════════════════════════════════════════════
-- Twelve hundred at once — G-219
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Everything the reactivation campaign needs now exists, and there is no way
-- to run it. `crm.add_lead_to_reactivation_pilot` takes ONE lead id, and the
-- Admin surface calls it one lead at a time, so a campaign against twelve
-- hundred people is twelve hundred separate decisions by a person who has
-- already made the decision once.
--
-- ── and a rule that was only ever SHOWN ───────────────────────────────────
--
-- G-210 answered "who is this contact to us already?" and G-211 put the
-- answer in front of an operator before a campaign: `client`, `active_deal`
-- and `nurture` are NOT contactable, because a sales opening would damage a
-- live relationship or break a date the agency agreed.
--
-- `crm.relationship_is_contactable` is called in exactly one place: the
-- PREVIEW. Nothing enforces it. A contact who became a client last month,
-- and who has consent because they wrote to this agency, can be enrolled in a
-- cold reactivation campaign today — and the screen that says they should not
-- be is the same screen the operator used to decide.
--
-- That is a rule held by one layer and tested through another. The brief this
-- work came from names it first: *"Existing clients must NOT accidentally
-- enter cold-sales outreach."* So enrolment enforces it now, on BOTH paths —
-- the single lead and the batch — and the preview goes back to describing
-- something that is true.
--
-- ── what a bulk enrolment is allowed to be ────────────────────────────────
--
-- A ceiling, not a faucet. `p_limit` is the caller's own bound and
-- `MAX_PER_CALL` is the one they cannot raise: a mistyped number cannot enrol
-- an entire database in one statement, and an operator who means to enrol
-- twelve hundred does it in deliberate passes they can watch.
--
-- The pilot gate stays exactly where ADM-87 put it. Bulk enrolment REFUSES
-- while the gate is off, because enrolling everybody into a campaign nobody
-- has turned on is how a campaign turns itself on.
--
-- And it sends NOTHING. Enrolment is eligibility; the window (G-214), the
-- approved template (G-213) and the outreach limits (G-216) still stand
-- between a cohort and a message.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the exclusion, enforced where it was only described ───────────────────
create or replace function crm.add_lead_to_reactivation_pilot(p_lead_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid;
  v_contact uuid;
  v_in      boolean;
begin
  -- Tenant is DERIVED from the row, never a parameter.
  select l.organization_id, l.contact_id, l.in_reactivation_pilot
    into v_org, v_contact, v_in
    from crm.leads l
   where l.id = p_lead_id
     and l.deleted_at is null
   for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text; return;
    end if;
    if v_org is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text; return;
    end if;
  end if;

  -- Consent-eligibility: a lead enters the cohort only if its contact holds a
  -- GRANTED whatsapp consent row — the same test crm.send_outbound_message
  -- applies at the chokepoint. No contact, or a withdrawn/absent row, is
  -- refused. This is a data rule, not an authority rung: it is NOT
  -- service-role-exempt.
  if v_contact is null
     or not exists (
       select 1 from crm.communication_consent cc
        where cc.organization_id = v_org
          and cc.contact_id      = v_contact
          and cc.channel         = 'whatsapp'
          and cc.status          = 'granted'
     )
  then
    return query select 'no_consent'::text; return;
  end if;

  /**
   * EDIT (G-219): and who this contact already is.
   *
   * G-210 decided that `client`, `active_deal` and `nurture` are not
   * contactable — a sales opening damages a live relationship or breaks a
   * date this agency agreed — and G-211 showed an operator exactly that
   * before a campaign. Nothing enforced it. A contact who became a client
   * last month, and who has consent because they wrote in, could be enrolled
   * in a cold campaign by the same screen that said they should not be.
   *
   * Consent and relationship are different questions and both must pass:
   * consent is whether they agreed to be messaged, and this is whether a
   * sales campaign is the right thing to message them about.
   */
  if not crm.relationship_is_contactable(crm.contact_relationship(v_contact)) then
    return query select 'not_contactable'::text; return;
  end if;

  if v_in then
    return query select 'already_in'::text; return;   -- idempotent
  end if;

  -- Audited by the existing crm.leads row-change trigger (before/after diff
  -- carries in_reactivation_pilot false->true).
  perform set_config('crm.reactivation_pilot_write', 'on', true);
  update crm.leads set in_reactivation_pilot = true where id = p_lead_id;

  return query select 'added'::text;
end;
$$;

comment on function crm.add_lead_to_reactivation_pilot(uuid) is
  'Enrolls a lead in the reactivation pilot cohort (G-012, G-140/ADM-87). SECURITY DEFINER; owner/ops_admin, tenant derived from the lead row. REFUSES unless the lead''s contact has a granted whatsapp consent row, and since G-219 also unless the contact''s RELATIONSHIP is contactable — G-210 excluded client, active_deal and nurture, and until G-219 that exclusion was shown in a preview and enforced nowhere. Audited via the crm.leads row-change trigger.';

-- ── and the same decision, made once, for a batch ─────────────────────────
create or replace function crm.enrol_reactivation_batch(
  p_batch_id uuid,
  p_limit int default 100
)
returns table (
  outcome           text,
  enrolled          int,
  already_in        int,
  no_consent        int,
  not_contactable   int,
  uncommitted       int,
  remaining         int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- The bound the caller cannot raise. An operator who means to enrol twelve
  -- hundred does it in passes they can watch; a mistyped number cannot enrol
  -- a database.
  c_max            constant int := 500;
  v_actor          uuid := (select auth.uid());
  v_org            uuid;
  v_gate           boolean;
  v_limit          int := least(greatest(coalesce(p_limit, 100), 1), c_max);
  v_lead           uuid;
  v_result         text;
  v_enrolled       int := 0;
  v_already        int := 0;
  v_no_consent     int := 0;
  v_not_contact    int := 0;
  v_uncommitted    int := 0;
  v_remaining      int := 0;
begin
  select b.organization_id into v_org
    from crm.import_batches b where b.id = p_batch_id;
  if v_org is null then
    return query select 'not_found'::text, 0, 0, 0, 0, 0, 0; return;
  end if;

  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text, 0, 0, 0, 0, 0, 0; return;
    end if;
    if v_org is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text, 0, 0, 0, 0, 0, 0; return;
    end if;
  end if;

  -- ADM-87's gate, obeyed rather than worked around. Enrolling everybody into
  -- a campaign nobody has turned on is how a campaign turns itself on.
  select o.reactivation_pilot_enabled into v_gate
    from core.organizations o where o.id = v_org;
  if not coalesce(v_gate, false) then
    return query select 'pilot_off'::text, 0, 0, 0, 0, 0, 0; return;
  end if;

  -- How many of this batch's records never became a lead. Counted rather than
  -- silently ignored: an operator reading "enrolled 40" needs to know whether
  -- the other sixty were refused or were never committed in the first place.
  select count(*) into v_uncommitted
    from crm.import_records r
   where r.batch_id = p_batch_id
     and r.committed_lead_id is null;

  for v_lead in
    select r.committed_lead_id
      from crm.import_records r
      join crm.leads l on l.id = r.committed_lead_id
     where r.batch_id = p_batch_id
       and r.committed_lead_id is not null
       and l.deleted_at is null
       and not l.in_reactivation_pilot
     order by r.created_at
     limit v_limit
  loop
    -- Through the single-lead function, deliberately. Every rule it enforces
    -- is enforced here for free, and a rule added there tomorrow cannot be
    -- missing from the batch path — which is the failure this whole gap is
    -- an instance of.
    select a.outcome into v_result from crm.add_lead_to_reactivation_pilot(v_lead) a;

    if v_result = 'added' then v_enrolled := v_enrolled + 1;
    elsif v_result = 'already_in' then v_already := v_already + 1;
    elsif v_result = 'no_consent' then v_no_consent := v_no_consent + 1;
    elsif v_result = 'not_contactable' then v_not_contact := v_not_contact + 1;
    end if;
  end loop;

  -- What is left for the next pass, so the operator knows there is one.
  select count(*) into v_remaining
    from crm.import_records r
    join crm.leads l on l.id = r.committed_lead_id
   where r.batch_id = p_batch_id
     and l.deleted_at is null
     and not l.in_reactivation_pilot;

  perform core.record_audit(
    v_org, 'reactivation.batch_enrolled', 'import_batch', p_batch_id, null,
    jsonb_build_object(
      'enrolled', v_enrolled, 'already_in', v_already,
      'no_consent', v_no_consent, 'not_contactable', v_not_contact,
      'uncommitted', v_uncommitted, 'remaining', v_remaining,
      'limit', v_limit));

  return query select 'enrolled'::text, v_enrolled, v_already, v_no_consent,
                      v_not_contact, v_uncommitted, v_remaining;
end;
$$;

comment on function crm.enrol_reactivation_batch(uuid, int) is
  'Enrols the eligible leads of one import batch in the reactivation cohort (G-219), a bounded pass at a time — 500 is the ceiling a caller cannot raise. Refuses while ADM-87''s pilot gate is off. Every lead goes through crm.add_lead_to_reactivation_pilot, so consent and G-210''s relationship exclusion are enforced by the same code the single path uses and a rule added there cannot be missing here. Returns a count per outcome and what remains, and SENDS NOTHING: the window, the approved template and the outreach limits still stand between a cohort and a message.';

revoke all on function crm.enrol_reactivation_batch(uuid, int) from public, anon;
grant execute on function crm.enrol_reactivation_batch(uuid, int) to authenticated, service_role;

-- ── and the way back out ──────────────────────────────────────────────────
--
-- Enrolling twelve hundred people is only a safe thing to offer if
-- un-enrolling them is one action too. Removal has no consent or relationship
-- test: taking somebody OUT of a campaign is always allowed.
create or replace function crm.withdraw_reactivation_batch(p_batch_id uuid)
returns table (outcome text, withdrawn int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_count int := 0;
begin
  select b.organization_id into v_org
    from crm.import_batches b where b.id = p_batch_id;
  if v_org is null then
    return query select 'not_found'::text, 0; return;
  end if;

  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text, 0; return;
    end if;
    if v_org is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text, 0; return;
    end if;
  end if;

  -- No gate check: the gate stops a campaign starting, and stopping one must
  -- work whatever the gate says.
  perform set_config('crm.reactivation_pilot_write', 'on', true);

  with removed as (
    update crm.leads l
       set in_reactivation_pilot = false
      from crm.import_records r
     where r.batch_id = p_batch_id
       and l.id = r.committed_lead_id
       and l.in_reactivation_pilot
    returning l.id
  )
  select count(*) into v_count from removed;

  perform core.record_audit(
    v_org, 'reactivation.batch_withdrawn', 'import_batch', p_batch_id, null,
    jsonb_build_object('withdrawn', v_count));

  return query select 'withdrawn'::text, v_count;
end;
$$;

comment on function crm.withdraw_reactivation_batch(uuid) is
  'Takes a whole import batch back out of the reactivation cohort (G-219). No consent or relationship test and no gate check: enrolling twelve hundred people is only safe to offer if un-enrolling them is one action too, and stopping a campaign must work whatever the gate says.';

revoke all on function crm.withdraw_reactivation_batch(uuid) from public, anon;
grant execute on function crm.withdraw_reactivation_batch(uuid) to authenticated, service_role;
