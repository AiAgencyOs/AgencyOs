-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 rest-gaps, CRM and definition-of-done (traceability: docs/phase-1-3-implementation-traceability.md):
--   P1-CRM-057   a CRM export is logged: who, what filters, how many rows, BEFORE the file is produced
--   P1-CRM-040   a deal that is LOST keeps the circumstances it was lost in (last conversation point, live quotation version, objections raised, whether
--                it may be nurtured), written by a trigger so no path to "lost" can skip it
--   P1-CRM-051   an admin can mark a lead do-not-contact in one audited step (consent withdrawn on every channel that exists), with a reason
--   P1-DOD-095   a defect has a PRIORITY that is separate from its severity (severity = how bad; priority = how soon), set through an audited door
-- ═══════════════════════════════════════════════════════════════════════════

-- ── CRM export log ──────────────────────────────────────────────────────────
create or replace function crm.p13_log_crm_export(p_kind text, p_filters jsonb, p_row_count integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null or v_org is null then return 'no_actor'; end if;
  if not coalesce((select core.is_internal()), false) then return 'not_authorized'; end if;
  if p_kind not in ('pipeline_csv') then return 'invalid_kind'; end if;
  if p_row_count is null or p_row_count < 0 then return 'bad_count'; end if;
  if p_filters is not null and (jsonb_typeof(p_filters) <> 'object' or length(p_filters::text) > 2000) then return 'bad_filters'; end if;
  perform core.record_audit(v_org, 'crm.exported', 'crm_export', null, null, jsonb_build_object('kind', p_kind, 'filters', coalesce(p_filters, '{}'::jsonb), 'rowCount', p_row_count));
  return 'logged';
end $$;
revoke all on function crm.p13_log_crm_export(text, jsonb, integer) from public, anon;
grant execute on function crm.p13_log_crm_export(text, jsonb, integer) to authenticated;

-- ── lost-deal snapshot ──────────────────────────────────────────────────────
create table if not exists sales.p13_lost_snapshots (
  opportunity_id        uuid primary key references sales.opportunities(id) on delete cascade,
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  lead_id               uuid references crm.leads(id) on delete set null,
  lost_category         text,
  lost_reason           text,
  last_message_seq      integer,
  last_message_at       timestamptz,
  proposal_id           uuid references sales.proposals(id) on delete set null,
  proposal_version      integer,
  proposal_status       text,
  objection_kinds       text[] not null default '{}',
  nurture_eligible      boolean not null,
  nurture_blocked_by    text check (nurture_blocked_by is null or nurture_blocked_by in ('no_lead', 'lead_disqualified', 'consent_withdrawn')),
  captured_at           timestamptz not null default clock_timestamp()
);
comment on table sales.p13_lost_snapshots is
  'P1-CRM-040. What was true at the moment a deal was marked lost: the last conversation message (a reference, not its words), the live quotation version, the objection kinds raised, and whether the lead may be nurtured afterwards. Written once by trigger; never edited. Competitor is deliberately absent: it is voluntary and stays in the lost reason text.';
drop trigger if exists org_match_p13_lost_snapshot_opportunity on sales.p13_lost_snapshots;
create trigger org_match_p13_lost_snapshot_opportunity before insert or update of opportunity_id, organization_id on sales.p13_lost_snapshots
  for each row execute function core.enforce_parent_org('opportunity_id', 'sales.opportunities');
drop trigger if exists org_match_p13_lost_snapshot_lead on sales.p13_lost_snapshots;
create trigger org_match_p13_lost_snapshot_lead before insert or update of lead_id, organization_id on sales.p13_lost_snapshots
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');
drop trigger if exists org_match_p13_lost_snapshot_proposal on sales.p13_lost_snapshots;
create trigger org_match_p13_lost_snapshot_proposal before insert or update of proposal_id, organization_id on sales.p13_lost_snapshots
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');
drop trigger if exists freeze_org_p13_lost_snapshots on sales.p13_lost_snapshots;
create trigger freeze_org_p13_lost_snapshots before update of organization_id on sales.p13_lost_snapshots
  for each row execute function core.freeze_organization_id();
create or replace function sales.p13_lost_snapshot_is_history()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a lost-deal snapshot is history and is never edited' using errcode = 'restrict_violation'; end $$;
drop trigger if exists p13_lost_snapshot_is_history on sales.p13_lost_snapshots;
create trigger p13_lost_snapshot_is_history before update on sales.p13_lost_snapshots for each row execute function sales.p13_lost_snapshot_is_history();

alter table sales.p13_lost_snapshots enable row level security;
alter table sales.p13_lost_snapshots force row level security;
drop policy if exists p13_lost_snapshots_read on sales.p13_lost_snapshots;
create policy p13_lost_snapshots_read on sales.p13_lost_snapshots for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on sales.p13_lost_snapshots from public, anon, authenticated;
grant select on sales.p13_lost_snapshots to authenticated;
grant all on sales.p13_lost_snapshots to service_role;

create or replace function sales.p13_capture_lost_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_seq integer; v_at timestamptz; v_prop sales.proposals; v_kinds text[]; v_lead_status text; v_withdrawn boolean; v_ok boolean := true; v_block text;
begin
  if new.stage <> 'lost' or (tg_op = 'UPDATE' and old.stage = 'lost') then return new; end if;
  if new.lead_id is not null then
    select m.seq, m.occurred_at into v_seq, v_at
      from crm.conversation_messages m join crm.conversations c on c.id = m.conversation_id
     where c.lead_id = new.lead_id and c.organization_id = new.organization_id order by m.occurred_at desc, m.seq desc limit 1;
    select coalesce(array_agg(distinct o.kind order by o.kind), '{}') into v_kinds from sales.objections o where o.lead_id = new.lead_id and o.organization_id = new.organization_id;
    select l.status into v_lead_status from crm.leads l where l.id = new.lead_id;
    select exists (select 1 from crm.communication_consent cc join crm.leads l on l.contact_id = cc.contact_id
                    where l.id = new.lead_id and cc.organization_id = new.organization_id and cc.status = 'withdrawn') into v_withdrawn;
    if v_lead_status = 'disqualified' then v_ok := false; v_block := 'lead_disqualified';
    elsif v_withdrawn then v_ok := false; v_block := 'consent_withdrawn'; end if;
  else
    v_kinds := '{}'; v_ok := false; v_block := 'no_lead';
  end if;
  select p.* into v_prop from sales.proposals p where p.opportunity_id = new.id order by p.version desc limit 1;
  insert into sales.p13_lost_snapshots (opportunity_id, organization_id, lead_id, lost_category, lost_reason, last_message_seq, last_message_at, proposal_id, proposal_version, proposal_status,
                                        objection_kinds, nurture_eligible, nurture_blocked_by)
    values (new.id, new.organization_id, new.lead_id, new.lost_category, new.lost_reason, v_seq, v_at, v_prop.id, v_prop.version, v_prop.status, coalesce(v_kinds, '{}'), v_ok, v_block)
  on conflict (opportunity_id) do nothing;
  return new;
end $$;
drop trigger if exists p13_capture_lost_snapshot_ins on sales.opportunities;
create trigger p13_capture_lost_snapshot_ins after insert on sales.opportunities for each row when (new.stage = 'lost') execute function sales.p13_capture_lost_snapshot();
drop trigger if exists p13_capture_lost_snapshot_upd on sales.opportunities;
create trigger p13_capture_lost_snapshot_upd after update of stage on sales.opportunities for each row when (new.stage = 'lost' and old.stage is distinct from 'lost') execute function sales.p13_capture_lost_snapshot();

-- ── defect priority ─────────────────────────────────────────────────────────
create table if not exists qa.p13_defect_priorities (
  defect_id       uuid primary key references qa.defects(id) on delete cascade,
  organization_id uuid not null references core.organizations(id) on delete cascade,
  priority        text not null check (priority in ('p0', 'p1', 'p2', 'p3')),
  reason          text not null check (length(btrim(reason)) between 1 and 500),
  set_by          uuid references core.users(id) on delete set null,
  set_at          timestamptz not null default clock_timestamp()
);
comment on table qa.p13_defect_priorities is
  'P1-DOD-095. Priority (how soon) is separate from severity (how bad): a cosmetic defect on the launch screen can be p0, a severe one in a retired feature p3. One current value per defect; every change is audited with its reason.';
drop trigger if exists org_match_p13_defect_priority on qa.p13_defect_priorities;
create trigger org_match_p13_defect_priority before insert or update of defect_id, organization_id on qa.p13_defect_priorities
  for each row execute function core.enforce_parent_org('defect_id', 'qa.defects');
drop trigger if exists freeze_org_p13_defect_priorities on qa.p13_defect_priorities;
create trigger freeze_org_p13_defect_priorities before update of organization_id on qa.p13_defect_priorities
  for each row execute function core.freeze_organization_id();
alter table qa.p13_defect_priorities enable row level security;
alter table qa.p13_defect_priorities force row level security;
drop policy if exists p13_defect_priorities_read on qa.p13_defect_priorities;
create policy p13_defect_priorities_read on qa.p13_defect_priorities for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on qa.p13_defect_priorities from public, anon, authenticated;
grant select on qa.p13_defect_priorities to authenticated;
grant all on qa.p13_defect_priorities to service_role;

create or replace function qa.p13_set_defect_priority(p_defect_id uuid, p_priority text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d qa.defects; v_before text;
begin
  if v_actor is null then return 'no_actor'; end if;
  if not (coalesce((select core.can_manage_delivery()), false) or coalesce((select core.is_admin()), false)) then return 'not_authorized'; end if;
  if p_priority not in ('p0', 'p1', 'p2', 'p3') then return 'invalid_priority'; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then return 'reason_required'; end if;
  select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org;
  if v_d.id is null then return 'not_found'; end if;
  select priority into v_before from qa.p13_defect_priorities where defect_id = v_d.id for update;
  if v_before = p_priority then return 'unchanged'; end if;
  insert into qa.p13_defect_priorities (defect_id, organization_id, priority, reason, set_by) values (v_d.id, v_org, p_priority, left(btrim(p_reason), 500), v_actor)
  on conflict (defect_id) do update set priority = excluded.priority, reason = excluded.reason, set_by = v_actor, set_at = clock_timestamp();
  perform core.record_audit(v_org, 'defect.priority_set', 'defect', v_d.id, jsonb_build_object('priority', v_before), jsonb_build_object('priority', p_priority, 'reason', left(btrim(p_reason), 500)));
  return 'set';
end $$;
revoke all on function qa.p13_set_defect_priority(uuid, text, text) from public, anon;
grant execute on function qa.p13_set_defect_priority(uuid, text, text) to authenticated;

-- ── do-not-contact ──────────────────────────────────────────────────────────
-- The consent table already refuses every send without a granted row. This is the one audited step an admin takes to withdraw it for a LEAD's contact,
-- with the reason on record. It does not delete the lead, stop the deal or send anything; withdrawn is a row, so the fact and its date survive.
create or replace function crm.p13_mark_do_not_contact(p_lead_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_contact uuid; v_status text;
begin
  if v_actor is null then return 'no_actor'; end if;
  if not coalesce((select core.is_admin()), false) then return 'not_authorized'; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then return 'reason_required'; end if;
  select l.contact_id into v_contact from crm.leads l where l.id = p_lead_id and l.organization_id = v_org and l.deleted_at is null;
  if not found then return 'not_found'; end if;
  if v_contact is null then return 'no_contact'; end if;
  select cc.status into v_status from crm.communication_consent cc where cc.organization_id = v_org and cc.contact_id = v_contact and cc.channel = 'whatsapp';
  if v_status = 'withdrawn' then return 'already'; end if;
  insert into crm.communication_consent (organization_id, contact_id, channel, status, source, note, recorded_by)
    values (v_org, v_contact, 'whatsapp', 'withdrawn', 'admin_do_not_contact', left(btrim(p_reason), 500), v_actor)
  on conflict (organization_id, contact_id, channel) do update
    set status = 'withdrawn', source = 'admin_do_not_contact', note = left(btrim(p_reason), 500), recorded_by = v_actor, recorded_at = clock_timestamp(), updated_at = clock_timestamp();
  perform core.record_audit(v_org, 'lead.do_not_contact', 'lead', p_lead_id, jsonb_build_object('consent', coalesce(v_status, 'none')), jsonb_build_object('consent', 'withdrawn', 'reason', left(btrim(p_reason), 500)));
  return 'marked';
end $$;
revoke all on function crm.p13_mark_do_not_contact(uuid, text) from public, anon;
grant execute on function crm.p13_mark_do_not_contact(uuid, text) to authenticated;

notify pgrst, 'reload schema';
