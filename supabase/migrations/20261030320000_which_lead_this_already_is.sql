-- ═══════════════════════════════════════════════════════════════════════════
-- Identity resolution / dedup classifier — Audit 1.2
-- (docs/AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json): "no automatic
-- NEW_IDENTITY/EXISTING_LEAD/EXISTING_CLIENT/REACTIVATED_LEAD/
-- POSSIBLE_DUPLICATE classification exists anywhere."
--
-- `crm.merge_leads` (20260921130000) already refuses to guess across two
-- different contacts and never auto-merges anything — Doc 09's own praised
-- safe default. This migration does not touch that refusal; it gives the
-- system a NAME for what it is looking at before a human ever opens the
-- merge dialog, and for POSSIBLE_DUPLICATE_REVIEW specifically, this is a
-- classification a person reviews, never an action the system takes.
--
-- ── the five outcomes, and what each one actually checks ───────────────────
--
--   EXISTING_CLIENT          the lead's own contact is already tied to a
--                            core.client_accounts row (crm.contacts.
--                            client_account_id) — the strongest signal this
--                            schema has for "we already do business with
--                            this person."
--   EXISTING_LEAD            another, still-open (not merged, not
--                            disqualified) lead already exists for the SAME
--                            contact — two rows for one inquiry, the exact
--                            case crm.merge_leads exists to fold together.
--   REACTIVATED_LEAD         the same contact has a PAST lead that was
--                            disqualified — a lead who left and came back,
--                            distinct from a duplicate of a live pipeline.
--   POSSIBLE_DUPLICATE_REVIEW  a DIFFERENT contact row in the same
--                            organization shares this one's normalized name
--                            — the fuzzy case an exact phone/email match
--                            could never produce (those already dedupe onto
--                            one contact via contacts_org_email_key /
--                            contacts_org_phone_key). Flagged for a human,
--                            never merged automatically.
--   NEW_IDENTITY             none of the above — a genuinely new person.
--
-- Checked in that order because each is a stronger, more specific claim than
-- the ones after it: a client relationship outranks an open duplicate lead,
-- which outranks a past one, which outranks a same-name coincidence.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.identity_resolutions (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  lead_id                  uuid not null unique references crm.leads(id) on delete cascade,

  outcome                  text not null check (outcome in (
                             'NEW_IDENTITY',
                             'EXISTING_LEAD',
                             'EXISTING_CLIENT',
                             'REACTIVATED_LEAD',
                             'POSSIBLE_DUPLICATE_REVIEW'
                           )),

  matched_contact_id       uuid references crm.contacts(id) on delete set null,
  matched_lead_id          uuid references crm.leads(id) on delete set null,
  matched_client_account_id uuid references core.client_accounts(id) on delete set null,
  notes                    jsonb not null default '{}'::jsonb,

  -- Set only for POSSIBLE_DUPLICATE_REVIEW, by a person — never by the
  -- classifier itself. The row for every other outcome is never reviewed:
  -- there is no action pending on it.
  reviewed_at              timestamptz,
  reviewed_by              uuid references core.users(id) on delete set null,
  review_outcome           text check (review_outcome is null or review_outcome in
                             ('confirmed_duplicate', 'not_a_duplicate')),

  created_at               timestamptz not null default now(),

  constraint identity_resolutions_review_is_dated
    check (reviewed_at is null or (reviewed_by is not null and review_outcome is not null)),
  constraint identity_resolutions_review_only_for_flagged
    check (reviewed_at is null or outcome = 'POSSIBLE_DUPLICATE_REVIEW')
);

comment on table crm.identity_resolutions is
  'Audit 1.2. One row per lead, written once by crm.classify_lead_identity on creation. POSSIBLE_DUPLICATE_REVIEW is a human-reviewable state, not an action: nothing in this migration merges, deletes or reassigns anything on its own. Reviewing a row (crm.review_identity_resolution) records a person''s judgment; acting on it, if anybody does, still goes through the existing crm.merge_leads door with its own same-contact-only, no-opportunity refusals.';

create index if not exists identity_resolutions_org_outcome_idx
  on crm.identity_resolutions (organization_id, outcome);

create index if not exists identity_resolutions_pending_review_idx
  on crm.identity_resolutions (organization_id)
  where outcome = 'POSSIBLE_DUPLICATE_REVIEW' and reviewed_at is null;

drop trigger if exists identity_resolutions_parent_org_lead on crm.identity_resolutions;
create trigger identity_resolutions_parent_org_lead
  before insert or update of lead_id, organization_id on crm.identity_resolutions
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');

-- The three "what matched" columns are also org-scoped foreign keys and each
-- needs its own guard — core.unguarded_org_fks() (db:verify:tenancyguards)
-- checks every one of them structurally, not only the primary lead_id link.
drop trigger if exists identity_resolutions_parent_org_matched_contact on crm.identity_resolutions;
create trigger identity_resolutions_parent_org_matched_contact
  before insert or update of matched_contact_id, organization_id on crm.identity_resolutions
  for each row execute function core.enforce_parent_org('matched_contact_id', 'crm.contacts');

drop trigger if exists identity_resolutions_parent_org_matched_lead on crm.identity_resolutions;
create trigger identity_resolutions_parent_org_matched_lead
  before insert or update of matched_lead_id, organization_id on crm.identity_resolutions
  for each row execute function core.enforce_parent_org('matched_lead_id', 'crm.leads');

drop trigger if exists identity_resolutions_parent_org_matched_account on crm.identity_resolutions;
create trigger identity_resolutions_parent_org_matched_account
  before insert or update of matched_client_account_id, organization_id on crm.identity_resolutions
  for each row execute function core.enforce_parent_org('matched_client_account_id', 'core.client_accounts');

drop trigger if exists identity_resolutions_freeze_org on crm.identity_resolutions;
create trigger identity_resolutions_freeze_org
  before update of organization_id on crm.identity_resolutions
  for each row execute function core.freeze_organization_id();

alter table crm.identity_resolutions enable row level security;
alter table crm.identity_resolutions force row level security;

drop policy if exists identity_resolutions_select on crm.identity_resolutions;
create policy identity_resolutions_select on crm.identity_resolutions
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- Reviewing is the one write a person makes; the classification insert
-- itself always goes through the SECURITY DEFINER function below, which does
-- not need table INSERT granted to any role.
drop policy if exists identity_resolutions_review on crm.identity_resolutions;
create policy identity_resolutions_review on crm.identity_resolutions
  for update to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_write()));

grant select on crm.identity_resolutions to authenticated, service_role;
grant update on crm.identity_resolutions to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- The classifier.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.classify_lead_identity(p_lead_id uuid)
returns table (
  -- outcome names above, plus 'already_classified' | 'unknown_lead'
  -- | 'no_actor' | 'forbidden'
  outcome            text,
  resolution_id      uuid,
  matched_contact_id uuid,
  matched_lead_id    uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor         uuid := (select auth.uid());
  v_lead          crm.leads;
  v_contact       crm.contacts;
  v_existing      crm.identity_resolutions;
  v_result        text;
  v_match_contact uuid;
  v_match_lead    uuid;
  v_match_account uuid;
  v_id            uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::uuid, null::uuid; return;
  end if;

  select l.* into v_lead from crm.leads l where l.id = p_lead_id;
  if v_lead.id is null or v_lead.deleted_at is not null then
    return query select 'unknown_lead'::text, null::uuid, null::uuid, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_lead.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.is_internal()), false)) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::uuid; return;
  end if;

  -- Idempotent: classified once, at creation. A replayed event reports the
  -- same row rather than writing (or judging) a second one.
  select r.* into v_existing from crm.identity_resolutions r where r.lead_id = v_lead.id;
  if v_existing.id is not null then
    return query select 'already_classified'::text, v_existing.id,
                        v_existing.matched_contact_id, v_existing.matched_lead_id;
    return;
  end if;

  if v_lead.contact_id is not null then
    select c.* into v_contact from crm.contacts c where c.id = v_lead.contact_id;
  end if;

  -- 1. EXISTING_CLIENT — the contact is already a client account.
  if v_contact.id is not null and v_contact.client_account_id is not null then
    v_result := 'EXISTING_CLIENT';
    v_match_account := v_contact.client_account_id;

  -- 2. EXISTING_LEAD — another open lead already exists for this contact.
  elsif v_contact.id is not null and exists (
    select 1 from crm.leads l2
     where l2.contact_id = v_contact.id
       and l2.id <> v_lead.id
       and l2.merged_into_lead_id is null
       and l2.deleted_at is null
       and l2.status in ('new', 'qualifying', 'qualified')
  ) then
    v_result := 'EXISTING_LEAD';
    select l2.id into v_match_lead
      from crm.leads l2
     where l2.contact_id = v_contact.id
       and l2.id <> v_lead.id
       and l2.merged_into_lead_id is null
       and l2.deleted_at is null
       and l2.status in ('new', 'qualifying', 'qualified')
     order by l2.created_at asc
     limit 1;

  -- 3. REACTIVATED_LEAD — the same contact had a lead that was disqualified.
  elsif v_contact.id is not null and exists (
    select 1 from crm.leads l2
     where l2.contact_id = v_contact.id
       and l2.id <> v_lead.id
       and l2.merged_into_lead_id is null
       and l2.deleted_at is null
       and l2.status = 'disqualified'
  ) then
    v_result := 'REACTIVATED_LEAD';
    select l2.id into v_match_lead
      from crm.leads l2
     where l2.contact_id = v_contact.id
       and l2.id <> v_lead.id
       and l2.merged_into_lead_id is null
       and l2.deleted_at is null
       and l2.status = 'disqualified'
     order by l2.created_at desc
     limit 1;

  -- 4. POSSIBLE_DUPLICATE_REVIEW — a DIFFERENT contact, same normalized name.
  -- An exact phone or email match cannot reach here: contacts_org_email_key
  -- and contacts_org_phone_key already collapse those onto one contact row
  -- at ingest time, so a same-name-different-contact hit is exactly the
  -- fuzzy case those unique indexes cannot catch.
  elsif v_contact.id is not null and exists (
    select 1 from crm.contacts c2
     where c2.organization_id = v_lead.organization_id
       and c2.id <> v_contact.id
       and lower(btrim(c2.full_name)) = lower(btrim(v_contact.full_name))
  ) then
    v_result := 'POSSIBLE_DUPLICATE_REVIEW';
    select c2.id into v_match_contact
      from crm.contacts c2
     where c2.organization_id = v_lead.organization_id
       and c2.id <> v_contact.id
       and lower(btrim(c2.full_name)) = lower(btrim(v_contact.full_name))
     order by c2.created_at asc
     limit 1;

  else
    v_result := 'NEW_IDENTITY';
  end if;

  insert into crm.identity_resolutions (
    organization_id, lead_id, outcome,
    matched_contact_id, matched_lead_id, matched_client_account_id
  )
  values (
    v_lead.organization_id, v_lead.id, v_result,
    v_match_contact, v_match_lead, v_match_account
  )
  on conflict (lead_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost the race to a concurrent classification of the same lead.
    select r.* into v_existing from crm.identity_resolutions r where r.lead_id = v_lead.id;
    return query select 'already_classified'::text, v_existing.id,
                        v_existing.matched_contact_id, v_existing.matched_lead_id;
    return;
  end if;

  perform core.record_audit(
    v_lead.organization_id, 'lead.identity_classified', 'lead', v_lead.id, null,
    jsonb_build_object('outcome', v_result, 'resolutionId', v_id)
  );

  return query select v_result, v_id, v_match_contact, v_match_lead;
end;
$$;

comment on function crm.classify_lead_identity(uuid) is
  'Audit 1.2. Classifies a lead into NEW_IDENTITY/EXISTING_LEAD/EXISTING_CLIENT/REACTIVATED_LEAD/POSSIBLE_DUPLICATE_REVIEW once, at creation, and writes exactly one crm.identity_resolutions row. Never merges, deletes or reassigns anything - POSSIBLE_DUPLICATE_REVIEW is left for a person, and even a confirmed duplicate still goes through crm.merge_leads by hand.';

revoke all on function crm.classify_lead_identity(uuid) from public, anon;
grant execute on function crm.classify_lead_identity(uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- The human review door — the only write a POSSIBLE_DUPLICATE_REVIEW row
-- ever gets. Recording a judgment, not performing one: 'confirmed_duplicate'
-- still requires a person to separately call crm.merge_leads if they want
-- the records folded together.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.review_identity_resolution(
  p_resolution_id  uuid,
  p_review_outcome text
)
returns table (
  -- 'reviewed' | 'not_found' | 'not_pending' | 'invalid_outcome' | 'no_actor' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   crm.identity_resolutions;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if p_review_outcome not in ('confirmed_duplicate', 'not_a_duplicate') then
    return query select 'invalid_outcome'::text; return;
  end if;

  select r.* into v_row from crm.identity_resolutions r where r.id = p_resolution_id for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.outcome <> 'POSSIBLE_DUPLICATE_REVIEW' or v_row.reviewed_at is not null then
    return query select 'not_pending'::text; return;
  end if;

  update crm.identity_resolutions
     set reviewed_at = now(), reviewed_by = v_actor, review_outcome = p_review_outcome
   where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'lead.identity_reviewed', 'lead', v_row.lead_id, null,
    jsonb_build_object('resolutionId', v_row.id, 'reviewOutcome', p_review_outcome)
  );

  return query select 'reviewed'::text;
end;
$$;

comment on function crm.review_identity_resolution(uuid, text) is
  'The only write a POSSIBLE_DUPLICATE_REVIEW row ever gets: a person records confirmed_duplicate or not_a_duplicate. Never merges anything itself - acting on confirmed_duplicate is still a separate crm.merge_leads call, which keeps its own same-contact-only and no-opportunity refusals.';

revoke all on function crm.review_identity_resolution(uuid, text) from public, anon;
grant execute on function crm.review_identity_resolution(uuid, text) to authenticated;
