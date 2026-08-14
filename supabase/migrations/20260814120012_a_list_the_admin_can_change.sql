-- ═══════════════════════════════════════════════════════════════════════════
-- A list the Admin can change.
--
-- Gap G-113, decision ADM-80 — taken here as a **delegated decision** under
-- the owner's standing authorization. ADM-73 granted the principle and
-- withheld implementation until the shape was reviewed; this is that shape,
-- chosen for being the smallest one that satisfies every recorded constraint.
--
-- ── what was actually wrong, and how narrow it is ────────────────────────
--
-- The gap reads "the onboarding baseline is hardcoded, so an Admin cannot
-- configure it", and on inspection that is the *whole* of it. Three of the
-- five things a template system usually needs already worked:
--
--   · an item can be marked `not_applicable` — the status CHECK has admitted
--     it since the table was created
--   · an extra item can be added to one project — `onboarding_items_write`
--     already admits `core.can_manage_delivery()`, so a delivery manager can
--     insert any key and label they like
--   · items carry a free-form `key` and `label`, not an enum
--
-- Only the *default list* was unreachable: seventeen `values` rows inside
-- `projects.seed_onboarding`, changeable only by migration. So this change is
-- one table, one substitution, and a backfill — not a template engine.
--
-- ── no project type, and none was needed ─────────────────────────────────
--
-- ADM-73 established that project type is the wrong axis, and nothing here
-- reintroduces it. There is no category, no service list and no variant: one
-- baseline per organization, edited directly. An agency that wants a different
-- checklist for a different kind of work marks items `not_applicable` on the
-- project, which already worked, or edits the baseline for future projects.
--
-- Inventing a set of service categories would have been inventing exactly the
-- business definitions this project has refused to invent everywhere else.
--
-- ── the conservative sub-choice, and its reasoning ───────────────────────
--
-- **A baseline change affects future projects only. It never rewrites a
-- project that already has a checklist.**
--
-- This was the one genuine sub-choice, and it is decided the safe way. A
-- project's onboarding list is a record of what that project was asked to do.
-- Editing the baseline to add an item must not make a delivered project
-- retroactively incomplete, and removing one must not erase evidence that
-- somebody did the work.
--
-- It is also the reversible direction: an explicit "apply to existing
-- projects" action can be added later as a deliberate act, whereas silently
-- rewriting history cannot be undone once it has happened.
--
-- `seed_onboarding` was already idempotent by the item count for the same
-- reason, so this preserves a rule that existed rather than inventing one.
--
-- ── an empty baseline is allowed ─────────────────────────────────────────
--
-- Business rule 02 §3.3: onboarding blocks nothing and every item is a
-- reminder. So an organization may have no checklist, and `seed_onboarding`
-- then seeds nothing. Falling back to a built-in list would be hidden
-- behaviour — the very thing this gap exists to remove.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.onboarding_baseline (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- The same vocabulary `onboarding_items` uses, so a baseline row and the
  -- item it produces are recognisably the same thing.
  key              text not null check (length(trim(key)) > 0),
  label            text not null check (length(trim(label)) > 0),
  position         int  not null check (position >= 0),

  -- Retiring an item rather than deleting it. A deleted row loses the fact
  -- that the item ever existed, which makes an old project's checklist read
  -- as though somebody invented an item that was never on the list.
  is_active        boolean not null default true,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint onboarding_baseline_key_unique unique (organization_id, key)
);

comment on table projects.onboarding_baseline is
  'The checklist new projects start from, editable per organization (G-113, ADM-80). Replaces seventeen hardcoded values rows inside projects.seed_onboarding. A change here affects FUTURE projects only and never rewrites a project that already has a checklist: that list is a record of what the project was asked to do, and editing the baseline must not make a delivered project retroactively incomplete. There is NO project type and no service category - ADM-73 established that project type is the wrong axis.';

comment on column projects.onboarding_baseline.is_active is
  'Retiring an item rather than deleting it. A deleted row loses the fact that the item ever existed, which makes an old project checklist read as though somebody invented an item that was never on the list.';

create index if not exists onboarding_baseline_active_idx
  on projects.onboarding_baseline (organization_id, position)
  where is_active;

-- ── who may edit it ──────────────────────────────────────────────────────
--
-- Read is internal, because delivery needs to see what a project will start
-- from. Write is `core.is_admin()` — the gap's own words are "so an Admin
-- cannot configure it", and a baseline is configuration rather than delivery
-- work. Marking one item `not_applicable` on one project stays where it was,
-- with `can_manage_delivery()`.

alter table projects.onboarding_baseline enable row level security;

drop policy if exists onboarding_baseline_select on projects.onboarding_baseline;
create policy onboarding_baseline_select on projects.onboarding_baseline
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists onboarding_baseline_write on projects.onboarding_baseline;
create policy onboarding_baseline_write on projects.onboarding_baseline
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  );

drop trigger if exists set_updated_at on projects.onboarding_baseline;
create trigger set_updated_at
  before update on projects.onboarding_baseline
  for each row execute function core.set_updated_at();

-- ── the default list, and where it now lives ─────────────────────────────
--
-- Still seventeen rows of code, and that is fine: they are now a *default*
-- rather than the *only* option. Every organization gets a copy it owns and
-- may edit; nothing reads this function after an organization exists.

create or replace function projects.install_default_onboarding_baseline(p_organization_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted int;
begin
  insert into projects.onboarding_baseline (organization_id, position, key, label)
  select p_organization_id, t.position, t.key, t.label
    from (values
      ( 0, 'client_identity_confirmed',     'Client identity confirmed'),
      ( 1, 'accepted_quotation_confirmed',  'Accepted quotation confirmed'),
      ( 2, 'commercial_terms_confirmed',    'Commercial terms confirmed'),
      ( 3, 'payment_verified',              'Payment or approved exception verified'),
      ( 4, 'project_name_confirmed',        'Project name confirmed'),
      ( 5, 'requirements_imported',         'Requirements imported'),
      ( 6, 'scope_version_created',         'Scope version created'),
      ( 7, 'timeline_assumptions_recorded', 'Timeline assumptions recorded'),
      ( 8, 'stakeholders_identified',       'Client stakeholders identified'),
      ( 9, 'assets_requested',              'Required assets requested'),
      (10, 'design_references_requested',   'Brand and design references requested'),
      (11, 'technical_access_identified',   'Technical access requirements identified'),
      (12, 'whatsapp_group_mapped',         'WhatsApp group created and mapped'),
      (13, 'project_manager_assigned',      'Project manager assigned'),
      (14, 'specialist_agents_assigned',    'Specialist agents assigned'),
      (15, 'kickoff_sent',                  'Kickoff communication sent'),
      (16, 'project_activated',             'Project status activated')
    ) as t(position, key, label)
  on conflict (organization_id, key) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function projects.install_default_onboarding_baseline(uuid) is
  'Gives an organization its own copy of the Document 10 section 6 checklist (G-113). The seventeen are now a DEFAULT rather than the only option: once an organization exists it owns its rows and may edit them, and nothing reads this function again.';

-- Every organization that exists today, so no deployment loses its checklist.
select projects.install_default_onboarding_baseline(o.id) from core.organizations o;

-- And every organization created from now on.
create or replace function projects.install_baseline_for_new_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform projects.install_default_onboarding_baseline(new.id);
  return new;
end;
$$;

drop trigger if exists install_baseline_for_new_org on core.organizations;
create trigger install_baseline_for_new_org
  after insert on core.organizations
  for each row execute function projects.install_baseline_for_new_org();

-- ═══════════════════════════════════════════════════════════════════════════
-- The seeder reads the baseline
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Regenerated from the live definition with the `values` list replaced by a
-- select, and nothing else changed. The diff was checked before committing.

CREATE OR REPLACE FUNCTION projects.seed_onboarding(p_project_id uuid)
 RETURNS TABLE(outcome text, items integer)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_org      uuid;
  v_existing int;
  v_inserted int;
begin
  select p.organization_id into v_org
    from projects.projects p
   where p.id = p_project_id
   for update;

  if v_org is null then
    return query select 'not_found'::text, null::int;
    return;
  end if;

  select count(*) into v_existing
    from projects.onboarding_items i
   where i.project_id = p_project_id;

  -- Idempotent by the count rather than only by `on conflict`: a project whose
  -- checklist has been worked through and had an item deleted must not have it
  -- silently reinstated by a re-run of the conversion.
  if v_existing > 0 then
    return query select 'already_seeded'::text, v_existing;
    return;
  end if;

  -- G-113, ADM-80. The list was seventeen `values` rows here, so an Admin
  -- could not change it without a migration. It is now read from the
  -- organization's own baseline.
  --
  -- An empty baseline seeds nothing, and that is allowed rather than guarded
  -- against: business rule 02 §3.3 says onboarding blocks nothing and every
  -- item is a reminder, so an organization that wants no checklist may have
  -- none. Falling back to a built-in list would be hidden behaviour, which is
  -- the failure this gap exists to remove.
  insert into projects.onboarding_items (organization_id, project_id, position, key, label)
  select v_org, p_project_id, b.position, b.key, b.label
    from projects.onboarding_baseline b
   where b.organization_id = v_org
     and b.is_active
  on conflict (project_id, key) do nothing;

  get diagnostics v_inserted = row_count;

  return query select 'seeded'::text, v_inserted;
end;
$function$;

comment on function projects.seed_onboarding(uuid) is
  'Creates a project checklist from its organization onboarding baseline, once (G-113, ADM-80). The list used to be seventeen values rows here, changeable only by migration. Still idempotent by the existing item count rather than only by the unique key, so an item somebody deleted is not silently reinstated - and a baseline edited later never rewrites a project that already has a checklist.';


-- ═══════════════════════════════════════════════════════════════════════════
-- Changing the baseline is on the record
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The baseline decides what every future project starts from, so editing it
-- changes how the agency works. Regenerated from the live definition in
-- `20260814120008` with one branch added and nothing else changed; the diff
-- was checked before committing, and a test compares both copies structurally.

create or replace function audit.record_row_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_action  text;
  v_subject text;
  v_before  jsonb;
  v_after   jsonb;
  v_org     uuid;
begin
  v_after := to_jsonb(new);
  v_before := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;

  v_org := (v_after->>'organization_id')::uuid;

  if v_org is null then
    raise exception 'audit.record_row_change: % has no organization_id', tg_table_name;
  end if;

  case tg_table_name
    when 'leads' then
      v_subject := 'lead';
      v_action :=
        case
          when tg_op = 'INSERT' then 'lead.created'
          when new.status = 'converted' and old.status is distinct from 'converted' then 'lead.converted'
          when new.status is distinct from old.status then 'lead.status_changed'
          when new.qualification is distinct from old.qualification then 'lead.qualification_updated'
          when new.next_follow_up_at is distinct from old.next_follow_up_at then 'lead.follow_up_scheduled'
          else 'lead.updated'
        end;

    when 'lead_activities' then
      v_subject := 'lead';
      v_action :=
        -- G-010. The six kinds ADM-10 §7 names are recorded as what they are.
        -- The seven that came before keep `lead.note_added`, which is wrong
        -- for some of them and is not this change's to fix — it is recorded
        -- as its own gap. What this refuses to do is *add* to the problem:
        -- six new kinds filed as notes would be six new false statements in
        -- the audit log, written knowingly, in the change that exists to make
        -- the six honest.
        case new.kind
          when 'contacted'         then 'lead.contacted'
          when 'sample_sent'       then 'lead.sample_sent'
          when 'demo_sent'         then 'lead.demo_sent'
          when 'offer_sent'        then 'lead.offer_sent'
          when 'follow_up'         then 'lead.follow_up_recorded'
          when 'advance_requested' then 'lead.advance_requested'
          -- G-126. The seven the timeline shipped with, each recorded as what
          -- it is. Until now every one of them was filed as `lead.note_added`,
          -- so an assignment, a logged call, an inbound message and an agent
          -- run all read as notes -- in audit.audit_log, the record that
          -- exists to be trusted.
          --
          -- `status_change` becomes `lead.status_change_logged` rather than
          -- `lead.status_changed`, which the `leads` branch already produces
          -- for the lead's own status. Two different events sharing one action
          -- name would be a worse defect than the one being fixed.
          when 'note'          then 'lead.note_added'
          when 'status_change' then 'lead.status_change_logged'
          when 'message_in'    then 'lead.message_in'
          when 'message_out'   then 'lead.message_out'
          when 'call'          then 'lead.call_logged'
          when 'agent_run'     then 'lead.agent_run_logged'
          when 'assignment'    then 'lead.assigned'
          -- No fallback. The kind CHECK admits thirteen values and all
          -- thirteen are named above, so a fourteenth arriving without an
          -- action here raises rather than being filed as a note - which is
          -- exactly how the first seven came to be wrong.
          else null
        end;

      if v_action is null then
        raise exception 'audit.record_row_change: no action for lead_activities.kind %', new.kind;
      end if;

    -- G-012, ADM-70. Consent is the thing that decides whether a client may
    -- be messaged at all, so a change to it is exactly the kind of act the
    -- audit log exists for. ADM-70 warned this branch must arrive in the same
    -- change as the trigger: this function RAISES for any table it has no
    -- vocabulary for, so attaching the trigger without a branch here would
    -- make every write to the consent table fail.
    when 'communication_consent' then
      v_subject := 'communication_consent';
      v_action  := 'consent.' || new.status;

    -- G-113, ADM-80. The baseline decides what every future project starts
    -- from, so a change to it is a change to how the agency works - exactly
    -- the kind of act the audit log exists for. As with the consent table,
    -- this branch must arrive in the same change as the trigger: this
    -- function RAISES for any table it has no vocabulary for.
    when 'onboarding_baseline' then
      v_subject := 'onboarding_baseline';
      v_action  :=
        case
          when tg_op = 'INSERT' then 'onboarding_baseline.added'
          when new.is_active is distinct from old.is_active
            then case when new.is_active then 'onboarding_baseline.restored'
                      else 'onboarding_baseline.retired' end
          else 'onboarding_baseline.updated'
        end;

    when 'requirement_versions' then
      v_subject := 'requirement_version';
      v_action :=
        case
          when tg_op = 'INSERT' then 'requirement.proposed'
          when new.status is distinct from old.status then 'requirement.' || new.status
          else 'requirement.updated'
        end;

    when 'client_accounts' then
      v_subject := 'client_account';
      v_action := case when tg_op = 'INSERT' then 'client_account.created' else 'client_account.updated' end;

    when 'opportunities' then
      v_subject := 'opportunity';
      v_action :=
        case
          when tg_op = 'INSERT' then 'opportunity.created'
          when new.stage = 'won' and old.stage is distinct from 'won' then 'opportunity.won'
          when new.stage is distinct from old.stage then 'opportunity.stage_changed'
          when new.value_minor is distinct from old.value_minor then 'opportunity.value_changed'
          else 'opportunity.updated'
        end;

    -- G-011. The status vocabulary is already the business vocabulary — the
    -- states a quote moves through are exactly the events worth reading in a
    -- log — so the derivation is the status itself. `proposal.repriced` is
    -- named separately because a discount or tax change on a draft is the one
    -- material money edit that leaves the status alone, and it is the edit
    -- Document 09 §17 gates approval on.
    when 'proposals' then
      v_subject := 'proposal';
      v_action :=
        case
          when tg_op = 'INSERT' then 'proposal.drafted'
          when new.status is distinct from old.status then 'proposal.' || new.status
          when new.total_minor is distinct from old.total_minor then 'proposal.repriced'
          else 'proposal.updated'
        end;

    when 'projects' then
      v_subject := 'project';
      v_action :=
        case
          when tg_op = 'INSERT' then 'project.created'
          when new.status is distinct from old.status then 'project.status_changed'
          else 'project.updated'
        end;

    when 'defects' then
      v_subject := 'defect';
      v_action :=
        case
          when tg_op = 'INSERT' then 'defect.raised'
          when new.status is distinct from old.status then 'defect.' || new.status
          else 'defect.updated'
        end;

    else
      raise exception 'audit.record_row_change: no vocabulary for table %', tg_table_name;
  end case;

  if tg_op = 'UPDATE' and (v_before - 'updated_at') = (v_after - 'updated_at') then
    return null;
  end if;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org,
    case when (select auth.uid()) is null then 'system' else 'user' end,
    (select auth.uid()),
    v_action,
    v_subject,
    (v_after->>'id')::uuid,
    v_before,
    v_after
  );

  return null;
end;
$$;

drop trigger if exists record_row_change on projects.onboarding_baseline;
create trigger record_row_change
  after insert or update on projects.onboarding_baseline
  for each row execute function audit.record_row_change();
