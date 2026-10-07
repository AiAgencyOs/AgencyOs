-- ═════════════════════════════════════════════════════════════════
-- Phase 8A gaps log 1 (part 4): the post-launch Sales agent's discovery brief (SAL-TST-002: discovery reuses the Customer 360 context).
--
-- A brief is a DRAFT: a summary and the discovery questions to ask, citing the records of the Customer 360 it was built from (tickets, check-ins of THE OPPORTUNITY'S
-- project and organization: a foreign id is refused). The sales agent writes drafts through ONE service-role door and only for an opportunity a PERSON has already
-- qualified; a person marks it reviewed. Neither touches a deal, a quotation, a proposal, a discount or a price: the table has no such column and the door refuses text that
-- names one. Quoting, negotiation and acceptance stay in the existing sales doors.
-- ═════════════════════════════════════════════════════════════════

create table if not exists projects.sales_discovery_briefs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  opportunity_id   uuid not null references sales.phase_eight_opportunities(id) on delete restrict,
  version          int not null check (version >= 1),
  summary          text not null check (length(btrim(summary)) between 20 and 2000 and not projects.p7_has_secret(summary)),
  questions        jsonb not null check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) between 1 and 10),
  context_refs     jsonb not null check (jsonb_typeof(context_refs) = 'object'),
  status           text not null default 'draft' check (status in ('draft', 'reviewed', 'superseded')),
  drafted_by_agent text not null check (length(btrim(drafted_by_agent)) between 1 and 80),
  reviewed_by      uuid references core.users(id) on delete restrict,
  reviewed_at      timestamptz,
  review_note      text check (review_note is null or not projects.p7_has_secret(review_note)),
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default now(),
  unique (opportunity_id, version),
  constraint discovery_brief_reviewed_is_a_person check ((status = 'reviewed') = (reviewed_by is not null and reviewed_at is not null)),
  constraint discovery_brief_names_no_price check (summary !~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off'
                                                   and questions::text !~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off')
);
create unique index if not exists sales_discovery_briefs_one_draft on projects.sales_discovery_briefs (opportunity_id) where status = 'draft';
comment on table projects.sales_discovery_briefs is
  'A DRAFT discovery brief for an opportunity a person qualified: a summary, questions, and the Customer 360 records it cites. No price, quote or discount. A person marks it reviewed.';

do $$ begin
  perform projects.p8g_wire_parent('sales_discovery_briefs', 'opportunity_id', 'sales.phase_eight_opportunities');
  perform projects.p8g_wire_table('sales_discovery_briefs', true, false);
end $$;

create or replace function projects.record_discovery_brief_draft(p_organization_id uuid, p_opportunity_id uuid, p_agent_key text, p_summary text, p_questions jsonb, p_context_refs jsonb)
returns table (outcome text, brief_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_o sales.phase_eight_opportunities; v_sum text := nullif(btrim(coalesce(p_summary, '')), ''); v_id uuid; v_v int; v_last projects.sales_discovery_briefs; q jsonb; v_ids uuid[]; v_cnt int; v_total int := 0;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid; return; end if;
  if p_agent_key is distinct from 'sales' then return query select 'not_the_sales_agent'::text, null::uuid; return; end if;
  if v_sum is null or length(v_sum) < 20 or length(v_sum) > 2000 then return query select 'bad_summary'::text, null::uuid; return; end if;
  if p_questions is null or jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) not between 1 and 10 then return query select 'bad_questions'::text, null::uuid; return; end if;
  for q in select * from jsonb_array_elements(p_questions) loop
    if jsonb_typeof(q) <> 'string' or length(btrim(q #>> '{}')) not between 10 and 300 then return query select 'bad_questions'::text, null::uuid; return; end if;
  end loop;
  if v_sum ~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off' or p_questions::text ~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off' then
    return query select 'names_a_price'::text, null::uuid; return;
  end if;
  if projects.p7_has_secret(v_sum) or projects.p7_has_secret(p_questions::text) then return query select 'contains_secret'::text, null::uuid; return; end if;
  select * into v_o from sales.phase_eight_opportunities o where o.id = p_opportunity_id and o.organization_id = p_organization_id for update;
  if v_o.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  -- the Sales agent works what a PERSON qualified: a detected, suppressed or closed opportunity is not its to discover
  if v_o.status not in ('qualified', 'handed_off') then return query select 'opportunity_not_qualified'::text, null::uuid; return; end if;
  -- every cited record must be THIS opportunity's project in THIS organization; at least one must be cited (the brief reuses the context, it does not recall it)
  if p_context_refs is null or jsonb_typeof(p_context_refs) <> 'object' then return query select 'context_required'::text, null::uuid; return; end if;
  if (select count(*) from jsonb_object_keys(p_context_refs) k where k not in ('ticketIds', 'checkInIds')) > 0 then return query select 'unknown_context_key'::text, null::uuid; return; end if;
  if p_context_refs ? 'ticketIds' then
    if jsonb_typeof(p_context_refs -> 'ticketIds') <> 'array' then return query select 'bad_context'::text, null::uuid; return; end if;
    begin select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(p_context_refs -> 'ticketIds') x;
    exception when others then return query select 'bad_context'::text, null::uuid; return; end;
    select count(*) into v_cnt from projects.support_tickets t where t.id = any (coalesce(v_ids, '{}')) and t.project_id = v_o.project_id and t.organization_id = p_organization_id;
    if v_cnt <> coalesce(cardinality(v_ids), 0) then return query select 'context_not_this_clients'::text, null::uuid; return; end if;
    v_total := v_total + v_cnt;
  end if;
  if p_context_refs ? 'checkInIds' then
    if jsonb_typeof(p_context_refs -> 'checkInIds') <> 'array' then return query select 'bad_context'::text, null::uuid; return; end if;
    begin select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(p_context_refs -> 'checkInIds') x;
    exception when others then return query select 'bad_context'::text, null::uuid; return; end;
    select count(*) into v_cnt from projects.cs_check_ins c where c.id = any (coalesce(v_ids, '{}')) and c.project_id = v_o.project_id and c.organization_id = p_organization_id;
    if v_cnt <> coalesce(cardinality(v_ids), 0) then return query select 'context_not_this_clients'::text, null::uuid; return; end if;
    v_total := v_total + v_cnt;
  end if;
  if v_total = 0 then return query select 'context_required'::text, null::uuid; return; end if;

  select * into v_last from projects.sales_discovery_briefs b where b.opportunity_id = p_opportunity_id order by b.version desc limit 1;
  if v_last.id is not null and v_last.summary = v_sum and v_last.questions = p_questions and v_last.status in ('draft', 'reviewed') then return query select 'already_recorded'::text, v_last.id; return; end if;
  v_v := coalesce(v_last.version, 0) + 1;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.sales_discovery_briefs set status = 'superseded' where opportunity_id = p_opportunity_id and status = 'draft';
  insert into projects.sales_discovery_briefs (organization_id, opportunity_id, version, summary, questions, context_refs, drafted_by_agent)
  values (p_organization_id, p_opportunity_id, v_v, v_sum, p_questions, p_context_refs, p_agent_key) returning id into v_id;
  perform core.record_audit(p_organization_id, 'sales_discovery_brief.drafted', 'phase_eight_opportunity', p_opportunity_id, null, jsonb_build_object('briefId', v_id, 'version', v_v), projects.p8g_correlation());
  return query select 'drafted'::text, v_id;
end $$;
revoke all on function projects.record_discovery_brief_draft(uuid, uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function projects.record_discovery_brief_draft(uuid, uuid, text, text, jsonb, jsonb) to service_role;

create or replace function projects.review_discovery_brief(p_brief_id uuid, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_b projects.sales_discovery_briefs; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if v_note is not null and projects.p7_has_secret(v_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_b from projects.sales_discovery_briefs b where b.id = p_brief_id and b.organization_id = v_org for update;
  if v_b.id is null then return query select 'not_found'::text; return; end if;
  if v_b.status = 'reviewed' then return query select 'already_reviewed'::text; return; end if;
  if v_b.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.sales_discovery_briefs set status = 'reviewed', reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_note = left(v_note, 500) where id = v_b.id;
  perform core.record_audit(v_org, 'sales_discovery_brief.reviewed', 'phase_eight_opportunity', v_b.opportunity_id, null, jsonb_build_object('briefId', v_b.id), projects.p8g_correlation());
  return query select 'reviewed'::text;
end $$;
revoke all on function projects.review_discovery_brief(uuid, text) from public, anon, service_role;
grant execute on function projects.review_discovery_brief(uuid, text) to authenticated;

-- the shared DDL helpers were only for the four 20261120 migrations
drop function if exists projects.p8g_wire_table(text, boolean, boolean, boolean);
drop function if exists projects.p8g_wire_parent(text, text, text);

notify pgrst, 'reload schema';
