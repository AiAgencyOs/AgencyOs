-- ═══════════════════════════════════════════════════════════════════════════
-- A reactivation pilot runs on a chosen few.
--
-- The inactive_lead follow-up situation (ADM-69 ordinal 7, G-012) would nurture
-- every open lead an agency holds. Reactivating 1,200+ historical leads that way
-- is a commercial decision with consent and volume risk, so this makes that
-- reach an explicit, revocable choice rather than a default:
--
--   · An org-level gate, `core.organizations.reactivation_pilot_enabled`, OFF at
--     birth. While OFF the observer emits NO inactive_lead candidate for the org,
--     so no sequence starts and nothing is sent.
--   · A per-lead cohort, `crm.leads.in_reactivation_pilot`, OFF at birth. Even
--     with the org gate ON, the observer emits a lead only when it is enrolled —
--     the pilot never auto-activates every lead; it runs on a chosen few.
--   · Enrolment requires GRANTED whatsapp consent. A lead whose contact has no
--     granted consent row cannot enter the cohort — consent is never manufactured.
--
-- Both columns are writable only through the SECURITY DEFINER functions below,
-- which mark their write with a transaction-scoped capability. A direct Data-API
-- PATCH by an authenticated caller — even an owner, whom RLS would otherwise let
-- write the row — cannot set that capability and is refused by the guard trigger,
-- the same idiom finance.refunds uses (20260815310000). Identity-less callers
-- (service role, cron, migrations) are trusted infrastructure and unrestricted.
--
-- The other four runnable situations (no_response_after_quotation,
-- abandoned_conversation, pending_approval, post_project) are UNCHANGED, and
-- per-tick batching and rhythm spacing are untouched — the gate lives only in the
-- observer's inactive_lead branch. Consequence, recorded deliberately: while the
-- gate is OFF, inactive_lead nurture does not run for FRESH cold leads either,
-- not only historical ones — reactivation of any kind is now opt-in per org.
-- G-140 / ADM-87.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the org gate, OFF by default ───────────────────────────────────────
alter table core.organizations
  add column if not exists reactivation_pilot_enabled boolean not null default false;

comment on column core.organizations.reactivation_pilot_enabled is
  'Master switch for ADM-69 inactive_lead reactivation (G-012, G-140/ADM-87). DEFAULT FALSE: the observer emits no inactive_lead candidate for this org until true, so no sequence starts and nothing is sent. Flipped only through core.set_reactivation_pilot (owner/ops_admin, audited); a direct authenticated PATCH is refused by the guard trigger.';

-- ── 2. the per-lead cohort flag, OFF by default ───────────────────────────
alter table crm.leads
  add column if not exists in_reactivation_pilot boolean not null default false;

comment on column crm.leads.in_reactivation_pilot is
  'Whether this lead is enrolled in the reactivation pilot cohort (G-012, G-140/ADM-87). Even with the org gate on, the inactive_lead observer emits this lead only when true — the pilot never auto-activates every lead. Set only through crm.add_lead_to_reactivation_pilot / remove_lead_from_reactivation_pilot (owner/ops_admin, consent-gated on add, audited via the leads row-change trigger); a direct authenticated PATCH is refused by the guard trigger.';

-- ── 3. the guard: these two columns change only through the sanctioned path ─
--
-- Column-scoped, because crm.leads is written constantly and core.organizations
-- has an owner update policy: the guard fires ONLY when the protected column is
-- the thing changing, so every other write to these tables is untouched. The
-- sanctioned functions set `crm.reactivation_pilot_write='on'` for the duration
-- of the transaction; a direct PATCH cannot, and an authenticated caller is
-- refused. Identity-less callers (service role/cron/migrations) are exempt.

create or replace function crm.reactivation_pilot_membership_is_sanctioned()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.in_reactivation_pilot is not distinct from old.in_reactivation_pilot then
    return new;
  end if;
  if tg_op = 'INSERT' and new.in_reactivation_pilot is false then
    return new;
  end if;
  if current_setting('crm.reactivation_pilot_write', true) = 'on' then
    return new;
  end if;
  if (select auth.uid()) is null then
    return new;
  end if;
  raise exception
    'crm.leads.in_reactivation_pilot is set only through crm.add_lead_to_reactivation_pilot / crm.remove_lead_from_reactivation_pilot, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function crm.reactivation_pilot_membership_is_sanctioned() is
  'Refuses any authenticated end-user write that changes crm.leads.in_reactivation_pilot outside crm.add_lead_to_reactivation_pilot / remove_lead_from_reactivation_pilot (which set the transaction-scoped crm.reactivation_pilot_write flag). Fires only when the column actually changes, so ordinary lead writes are unaffected. Service role and other identity-less callers are unrestricted.';

drop trigger if exists reactivation_pilot_membership_is_sanctioned on crm.leads;
create trigger reactivation_pilot_membership_is_sanctioned
  before insert or update on crm.leads
  for each row execute function crm.reactivation_pilot_membership_is_sanctioned();

create or replace function core.reactivation_pilot_gate_is_sanctioned()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.reactivation_pilot_enabled is not distinct from old.reactivation_pilot_enabled then
    return new;
  end if;
  if tg_op = 'INSERT' and new.reactivation_pilot_enabled is false then
    return new;
  end if;
  if current_setting('crm.reactivation_pilot_write', true) = 'on' then
    return new;
  end if;
  if (select auth.uid()) is null then
    return new;
  end if;
  raise exception
    'core.organizations.reactivation_pilot_enabled is set only through core.set_reactivation_pilot, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function core.reactivation_pilot_gate_is_sanctioned() is
  'Refuses any authenticated end-user write that changes core.organizations.reactivation_pilot_enabled outside core.set_reactivation_pilot (which sets the transaction-scoped crm.reactivation_pilot_write flag). Fires only when the column changes, so ordinary organization writes are unaffected. Service role and other identity-less callers are unrestricted.';

drop trigger if exists reactivation_pilot_gate_is_sanctioned on core.organizations;
create trigger reactivation_pilot_gate_is_sanctioned
  before insert or update on core.organizations
  for each row execute function core.reactivation_pilot_gate_is_sanctioned();

-- ── 4. the observer, regenerated: inactive_lead now gated ─────────────────
--
-- VERBATIM from 20260815120001_finding_who_is_waiting.sql:47-236, with SIX lines
-- added to the inactive_lead branch only (between `and l.deleted_at is null` and
-- `and not exists`). Every other branch, the return shape, and the header are
-- unchanged.
create or replace function crm.observe_follow_up_candidates(p_limit int default 200)
returns table (
  organization_id uuid,
  situation_key   text,
  subject_type    text,
  subject_id      uuid,
  conversation_id uuid,
  triggered_at    timestamptz,
  contact_id      uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  -- ── 1. no response after quotation ─────────────────────────────────────
  select p.organization_id,
         'no_response_after_quotation'::text,
         'proposal'::text,
         p.id,
         p.conversation_id,
         p.sent_at,
         c.contact_id
    from sales.proposals p
    join sales.opportunities o on o.id = p.opportunity_id
    left join crm.conversations c on c.id = p.conversation_id
   where p.status = 'sent'
     and p.sent_at is not null
     and o.stage not in ('won', 'lost')
     and not exists (
       select 1 from crm.follow_up_sequences s
        where s.organization_id = p.organization_id
          and s.situation_key = 'no_response_after_quotation'
          and s.subject_type = 'proposal'
          and s.subject_id = p.id
     )

  union all

  -- ── 4. abandoned conversation ──────────────────────────────────────────
  select cv.organization_id,
         'abandoned_conversation'::text,
         'lead'::text,
         cv.lead_id,
         cv.id,
         m.last_at,
         cv.contact_id
    from crm.conversations cv
    join crm.leads l on l.id = cv.lead_id
    join lateral (
      select max(cm.occurred_at) as last_at
        from crm.conversation_messages cm
       where cm.conversation_id = cv.id
    ) m on true
   where cv.kind = 'direct'
     and cv.status = 'active'
     and cv.lead_id is not null
     and m.last_at is not null
     and l.status not in ('converted', 'disqualified')
     and l.deleted_at is null
     and not exists (
       select 1 from crm.follow_up_sequences s
        where s.organization_id = cv.organization_id
          and s.situation_key = 'abandoned_conversation'
          and s.subject_type = 'lead'
          and s.subject_id = cv.lead_id
     )

  union all

  -- ── 5. pending approval ────────────────────────────────────────────────
  select a.organization_id,
         'pending_approval'::text,
         'approval_request'::text,
         a.id,
         null::uuid,
         a.created_at,
         null::uuid
    from approvals.approval_requests a
   where a.state = 'pending'
     and a.audience = 'internal'
     and not exists (
       select 1 from crm.follow_up_sequences s
        where s.organization_id = a.organization_id
          and s.situation_key = 'pending_approval'
          and s.subject_type = 'approval_request'
          and s.subject_id = a.id
     )

  union all

  -- ── 7. inactive lead (gated: org opted in AND lead enrolled) ────────────
  select l.organization_id,
         'inactive_lead'::text,
         'lead'::text,
         l.id,
         cv.id,
         greatest(l.created_at, coalesce(act.last_at, l.created_at)),
         l.contact_id
    from crm.leads l
    left join lateral (
      select max(la.occurred_at) as last_at
        from crm.lead_activities la
       where la.lead_id = l.id
    ) act on true
    left join lateral (
      select c2.id
        from crm.conversations c2
       where c2.lead_id = l.id and c2.kind = 'direct'
       order by c2.created_at desc
       limit 1
    ) cv on true
   where l.status in ('new', 'qualifying', 'qualified')
     and l.deleted_at is null
     and l.in_reactivation_pilot
     and exists (
       select 1 from core.organizations o
        where o.id = l.organization_id
          and o.reactivation_pilot_enabled
     )
     and not exists (
       select 1 from crm.follow_up_sequences s
        where s.organization_id = l.organization_id
          and s.situation_key = 'inactive_lead'
          and s.subject_type = 'lead'
          and s.subject_id = l.id
     )

  union all

  -- ── 8. post-project ────────────────────────────────────────────────────
  select pr.organization_id,
         'post_project'::text,
         'project'::text,
         pr.id,
         null::uuid,
         pr.completed_at,
         ct.id
    from projects.projects pr
    left join lateral (
      select c3.id
        from crm.contacts c3
       where c3.client_account_id = pr.client_account_id
       order by c3.created_at
       limit 1
    ) ct on true
   where pr.status = 'completed'
     and pr.completed_at is not null
     and pr.deleted_at is null
     and not exists (
       select 1 from crm.follow_up_sequences s
        where s.organization_id = pr.organization_id
          and s.situation_key = 'post_project'
          and s.subject_type = 'project'
          and s.subject_id = pr.id
     )

  limit p_limit;
$$;

comment on function crm.observe_follow_up_candidates(int) is
  'Finds subjects owed a follow-up sequence (G-012, ADM-69). OBSERVES ONLY: it never sends, never claims and never decides whether a message is permitted - the contract applies ADM-69 ten steps and crm.send_outbound_message decides permission. Five of the seven runnable situations; 2 and 3 are deliberately absent (sales.proposals IS the quotation, so no fact distinguishes them from situation 1). inactive_lead is gated behind core.organizations.reactivation_pilot_enabled AND crm.leads.in_reactivation_pilot (G-140/ADM-87); the other four situations are unchanged. organization_id is derived from the authoritative record and cannot be supplied by a caller.';

revoke all on function crm.observe_follow_up_candidates(int) from public;
grant execute on function crm.observe_follow_up_candidates(int) to service_role;

-- ── 5. the org gate setter — owner/ops_admin, audited ─────────────────────
create or replace function core.set_reactivation_pilot(p_organization_id uuid, p_enabled boolean)
returns table (outcome text)   -- 'enabled' | 'disabled' | 'forbidden' | 'not_found'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_was   boolean;
begin
  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text; return;
    end if;
    if p_organization_id is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text; return;
    end if;
  end if;

  select o.reactivation_pilot_enabled into v_was
    from core.organizations o
   where o.id = p_organization_id
   for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  if v_was is not distinct from p_enabled then
    return query select case when p_enabled then 'enabled' else 'disabled' end; return;
  end if;

  perform set_config('crm.reactivation_pilot_write', 'on', true);
  update core.organizations set reactivation_pilot_enabled = p_enabled where id = p_organization_id;

  -- core.organizations has no row-change audit trigger, so the audit row is
  -- written explicitly, as approvals.cancel_request does (20260815220000).
  perform core.record_audit(
    p_organization_id,
    case when p_enabled then 'organization.reactivation_pilot_enabled'
                        else 'organization.reactivation_pilot_disabled' end,
    'organization',
    p_organization_id,
    jsonb_build_object('reactivationPilotEnabled', v_was),
    jsonb_build_object('reactivationPilotEnabled', p_enabled)
  );

  return query select case when p_enabled then 'enabled' else 'disabled' end;
end;
$$;

comment on function core.set_reactivation_pilot(uuid, boolean) is
  'Turns the org reactivation pilot gate on or off (G-012, G-140/ADM-87). SECURITY DEFINER, authority-gated to owner/ops_admin and tenant-scoped, service role unrestricted for jobs. Marks its write with the transaction-scoped capability so the guard trigger admits it, and audits explicitly because core.organizations has no row-change trigger.';

revoke all on function core.set_reactivation_pilot(uuid, boolean) from public, anon;
grant execute on function core.set_reactivation_pilot(uuid, boolean) to authenticated, service_role;

-- ── 6. cohort add / remove — owner/ops_admin, consent-gated on add ────────
create or replace function crm.add_lead_to_reactivation_pilot(p_lead_id uuid)
returns table (outcome text)   -- 'added' | 'already_in' | 'forbidden' | 'not_found' | 'no_consent'
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
  'Enrolls a lead in the reactivation pilot cohort (G-012, G-140/ADM-87). SECURITY DEFINER; owner/ops_admin, tenant derived from the lead row. REFUSES unless the lead''s contact has a granted whatsapp communication_consent row — only consent-eligible leads may enter, consent is never manufactured. Audited via the crm.leads row-change trigger.';

create or replace function crm.remove_lead_from_reactivation_pilot(p_lead_id uuid)
returns table (outcome text)   -- 'removed' | 'not_in' | 'forbidden' | 'not_found'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_in    boolean;
begin
  select l.organization_id, l.in_reactivation_pilot
    into v_org, v_in
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

  if not v_in then
    return query select 'not_in'::text; return;   -- idempotent
  end if;

  perform set_config('crm.reactivation_pilot_write', 'on', true);
  update crm.leads set in_reactivation_pilot = false where id = p_lead_id;

  return query select 'removed'::text;
end;
$$;

comment on function crm.remove_lead_from_reactivation_pilot(uuid) is
  'Removes a lead from the reactivation pilot cohort (G-012, G-140/ADM-87). SECURITY DEFINER; owner/ops_admin, tenant derived from the lead row. Audited via the crm.leads row-change trigger. No consent check on removal — taking a lead out is always safe.';

revoke all on function crm.add_lead_to_reactivation_pilot(uuid)      from public, anon;
revoke all on function crm.remove_lead_from_reactivation_pilot(uuid) from public, anon;
grant execute on function crm.add_lead_to_reactivation_pilot(uuid)      to authenticated, service_role;
grant execute on function crm.remove_lead_from_reactivation_pilot(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
