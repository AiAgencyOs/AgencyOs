-- ═══════════════════════════════════════════════════════
-- The outreach doors: people write and approve, the chokepoint decides what may leave.
--
-- See 20261012300000 for the model. Here: the person doors (add prospects, templates, campaigns,
-- approval, suppression), the public unsubscribe, and the two service-role doors the worker uses -
-- `claim_outreach_sends` (every gate, then a RESERVATION) and `record_outreach_result`.
-- ═══════════════════════════════════════════════════════

-- ── one place that suppresses (used by unsubscribe, bounce, complaint, manual) ──

create or replace function crm._suppress_email(p_org uuid, p_email text, p_reason text, p_source text, p_note text, p_actor uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_new   boolean := false;
begin
  insert into crm.email_suppressions (organization_id, email, reason, source, note, created_by)
  values (p_org, v_email, p_reason, p_source, left(p_note, 500), p_actor)
  on conflict (organization_id, email) do nothing;
  get diagnostics v_new = row_count;

  -- Nobody who has asked to stop is reachable by any campaign, now or later.
  update crm.outreach_prospects set status = 'do_not_contact' where organization_id = p_org and email = v_email and status <> 'do_not_contact';
  update crm.email_campaign_recipients
     set status = case when p_reason = 'unsubscribed' then 'unsubscribed' else 'refused' end,
         refusal_reason = case when p_reason = 'unsubscribed' then null else 'suppressed' end
   where organization_id = p_org and email = v_email and status = 'pending';
  -- A known contact's email consent is withdrawn too (the consent table is the record ADM-70 reads).
  insert into crm.communication_consent (organization_id, contact_id, channel, status, source, note)
  select c.organization_id, c.id, 'email', 'withdrawn', 'outreach_' || p_reason, left(p_note, 500)
    from crm.contacts c where c.organization_id = p_org and lower(c.email) = v_email
  on conflict (organization_id, contact_id, channel) do update set status = 'withdrawn', source = excluded.source, note = excluded.note;
  return v_new;
end;
$$;
revoke all on function crm._suppress_email(uuid, text, text, text, text, uuid) from public, anon, authenticated;

create or replace function crm.suppress_email(p_email text, p_reason text, p_note text default null)
returns table (outcome text)
-- 'suppressed' | 'already_suppressed' | 'no_actor' | 'forbidden' | 'bad_reason' | 'bad_email'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_new   boolean;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  if p_reason not in ('hard_bounce', 'complaint', 'manual', 'erasure') then return query select 'bad_reason'::text; return; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return query select 'bad_email'::text; return; end if;
  v_new := crm._suppress_email(v_org, v_email, p_reason, 'admin', p_note, v_actor);
  perform core.record_audit(v_org, 'outreach.email_suppressed', 'email_suppression', null, null, jsonb_build_object('reason', p_reason));
  return query select case when v_new then 'suppressed' else 'already_suppressed' end::text;
end;
$$;
revoke all on function crm.suppress_email(text, text, text) from public, anon;
grant execute on function crm.suppress_email(text, text, text) to authenticated;

create or replace function crm.record_unsubscribe(p_organization_id uuid, p_email text, p_source text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_new boolean;
begin
  v_new := crm._suppress_email(p_organization_id, p_email, 'unsubscribed', coalesce(nullif(btrim(p_source), ''), 'link'), null, null);
  if v_new then
    perform core.record_audit(p_organization_id, 'outreach.unsubscribed', 'email_suppression', null, null, jsonb_build_object('source', p_source));
    perform core.emit_event(p_organization_id, 'outreach.unsubscribed', 'email_suppression', null, jsonb_build_object('source', p_source));
  end if;
  return query select case when v_new then 'unsubscribed' else 'already_unsubscribed' end::text;
end;
$$;
revoke all on function crm.record_unsubscribe(uuid, text, text) from public, anon, authenticated;
grant execute on function crm.record_unsubscribe(uuid, text, text) to service_role;

-- ── prospects ─────────────────────────────────────────────────────────────

create or replace function crm.add_outreach_prospects(p_rows jsonb)
returns table (inserted int, duplicates int, suppressed int, invalid int, problems jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  r       jsonb;
  v_email text;
  v_basis text;
  v_contact uuid;
  v_ins int := 0; v_dup int := 0; v_sup int := 0; v_bad int := 0;
  v_problems jsonb := '[]'::jsonb;
  v_n int := 0;
begin
  if v_actor is null or not coalesce((select core.can_write()), false) then
    return query select 0, 0, 0, 0, '[{"row":0,"problem":"forbidden"}]'::jsonb; return;
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 2000 then
    return query select 0, 0, 0, 0, '[{"row":0,"problem":"send between 1 and 2000 rows"}]'::jsonb; return;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    v_email := lower(btrim(coalesce(r->>'email', '')));
    v_basis := coalesce(nullif(btrim(r->>'lawfulBasis'), ''), 'b2b_legitimate_interest');
    if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      v_bad := v_bad + 1; v_problems := v_problems || jsonb_build_object('row', v_n, 'problem', 'not an email address'); continue;
    end if;
    if length(btrim(coalesce(r->>'provenance', ''))) < 3 then
      v_bad := v_bad + 1; v_problems := v_problems || jsonb_build_object('row', v_n, 'problem', 'say how the address was obtained'); continue;
    end if;
    if v_basis not in ('consent', 'existing_relationship', 'b2b_legitimate_interest') then
      v_bad := v_bad + 1; v_problems := v_problems || jsonb_build_object('row', v_n, 'problem', 'unknown lawful basis'); continue;
    end if;
    if exists (select 1 from crm.email_suppressions s where s.organization_id = v_org and s.email = v_email) then
      v_sup := v_sup + 1; continue;
    end if;
    if exists (select 1 from crm.outreach_prospects p where p.organization_id = v_org and p.email = v_email) then
      v_dup := v_dup + 1; continue;
    end if;
    v_contact := null;
    if v_basis <> 'b2b_legitimate_interest' then
      select c.id into v_contact from crm.contacts c where c.organization_id = v_org and lower(c.email) = v_email limit 1;
      if v_contact is null then
        v_bad := v_bad + 1; v_problems := v_problems || jsonb_build_object('row', v_n, 'problem', 'consent / existing relationship needs a contact the system already knows');
        continue;
      end if;
    end if;
    insert into crm.outreach_prospects (organization_id, email, full_name, company, job_title, website, language, tags, provenance, lawful_basis, contact_id, created_by)
    values (v_org, v_email, nullif(btrim(coalesce(r->>'fullName', '')), ''), nullif(btrim(coalesce(r->>'company', '')), ''), nullif(btrim(coalesce(r->>'jobTitle', '')), ''),
            nullif(btrim(coalesce(r->>'website', '')), ''), coalesce(nullif(btrim(r->>'language'), ''), 'en'),
            coalesce((select array_agg(btrim(t)) from jsonb_array_elements_text(coalesce(r->'tags', '[]'::jsonb)) t), '{}'),
            left(btrim(r->>'provenance'), 300), v_basis, v_contact, v_actor);
    v_ins := v_ins + 1;
  end loop;

  perform core.record_audit(v_org, 'outreach.prospects_added', 'outreach_prospect', null, null,
    jsonb_build_object('inserted', v_ins, 'duplicates', v_dup, 'suppressed', v_sup, 'invalid', v_bad));
  return query select v_ins, v_dup, v_sup, v_bad, v_problems;
end;
$$;
revoke all on function crm.add_outreach_prospects(jsonb) from public, anon;
grant execute on function crm.add_outreach_prospects(jsonb) to authenticated;

-- ── templates ──────────────────────────────────────────────────────────────

create or replace function crm.create_email_template(p_name text, p_language text, p_subject text, p_body text)
returns table (outcome text, template_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_id uuid;
begin
  if v_actor is null or not coalesce((select core.can_write()), false) then return query select 'forbidden'::text, null::uuid; return; end if;
  insert into crm.email_templates (organization_id, name, language, subject, body, created_by)
  values ((select core.current_organization_id()), btrim(p_name), coalesce(nullif(btrim(p_language), ''), 'en'), btrim(p_subject), btrim(p_body), v_actor)
  returning id into v_id;
  return query select 'created'::text, v_id;
exception when check_violation then
  return query select 'refused: ' || sqlerrm, null::uuid;
end;
$$;
revoke all on function crm.create_email_template(text, text, text, text) from public, anon;
grant execute on function crm.create_email_template(text, text, text, text) to authenticated;

create or replace function crm.approve_email_template(p_template_id uuid)
returns table (outcome text)
-- 'approved' | 'no_actor' | 'forbidden' | 'unknown_template' | 'not_a_draft' | 'author_cannot_approve'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_t     crm.email_templates;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  select * into v_t from crm.email_templates where id = p_template_id for update;
  if v_t.id is null then return query select 'unknown_template'::text; return; end if;
  if v_t.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if v_t.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  -- Words that go to strangers are read by a second pair of eyes.
  if v_t.created_by = v_actor then return query select 'author_cannot_approve'::text; return; end if;
  update crm.email_templates set status = 'approved', approved_by = v_actor, approved_at = now() where id = v_t.id;
  perform core.record_audit(v_t.organization_id, 'outreach.template_approved', 'email_template', v_t.id, null, jsonb_build_object('name', v_t.name));
  return query select 'approved'::text;
end;
$$;
revoke all on function crm.approve_email_template(uuid) from public, anon;
grant execute on function crm.approve_email_template(uuid) to authenticated;

create or replace function crm.retire_email_template(p_template_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  update crm.email_templates set status = 'retired' where id = p_template_id and organization_id = (select core.current_organization_id()) and status <> 'retired';
  if not found then return query select 'unknown_template'::text; return; end if;
  return query select 'retired'::text;
end;
$$;
revoke all on function crm.retire_email_template(uuid) from public, anon;
grant execute on function crm.retire_email_template(uuid) to authenticated;

-- ── campaigns ──────────────────────────────────────────────────────────────

create or replace function crm.create_email_campaign(p_name text, p_audience jsonb, p_steps jsonb)
returns table (outcome text, campaign_id uuid)
-- p_steps: [{ "templateId": "...", "delayDays": 0 }, ...] (1 to 3, the first at 0 days)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_id    uuid;
  s       jsonb;
  v_n     int := 0;
begin
  if v_actor is null or not coalesce((select core.can_write()), false) then return query select 'forbidden'::text, null::uuid; return; end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then return query select 'needs_name'::text, null::uuid; return; end if;
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) not between 1 and 3 then return query select 'needs_1_to_3_steps'::text, null::uuid; return; end if;
  -- Every template must exist and be approved BEFORE the campaign does.
  for s in select * from jsonb_array_elements(p_steps) loop
    if not exists (select 1 from crm.email_templates t where t.id = (s->>'templateId')::uuid and t.organization_id = v_org and t.status = 'approved') then
      return query select 'template_not_approved'::text, null::uuid; return;
    end if;
  end loop;
  insert into crm.email_campaigns (organization_id, name, audience, created_by)
  values (v_org, btrim(p_name), coalesce(p_audience, '{}'::jsonb), v_actor) returning id into v_id;
  for s in select * from jsonb_array_elements(p_steps) loop
    v_n := v_n + 1;
    insert into crm.email_campaign_steps (organization_id, campaign_id, step_number, template_id, delay_days)
    values (v_org, v_id, v_n, (s->>'templateId')::uuid, case when v_n = 1 then 0 else greatest(1, coalesce((s->>'delayDays')::int, 3)) end);
  end loop;
  perform core.record_audit(v_org, 'outreach.campaign_created', 'email_campaign', v_id, null, jsonb_build_object('steps', v_n));
  return query select 'created'::text, v_id;
end;
$$;
revoke all on function crm.create_email_campaign(text, jsonb, jsonb) from public, anon;
grant execute on function crm.create_email_campaign(text, jsonb, jsonb) to authenticated;

-- Which prospects a campaign may reach RIGHT NOW. Used at approval (to freeze the audience) and shown in the preview.
create or replace function crm.outreach_audience(p_organization_id uuid, p_audience jsonb)
returns table (prospect_id uuid, email text, reachable boolean, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (select coalesce(cold_basis_enabled, false) as cold from (select 1) x left join crm.outreach_settings st on st.organization_id = p_organization_id)
  select p.id, p.email,
         (not sup and (basis_ok)) as reachable,
         case when sup then 'suppressed'
              when p.lawful_basis = 'b2b_legitimate_interest' and not (select cold from s) then 'cold_outreach_not_enabled'
              when p.lawful_basis <> 'b2b_legitimate_interest' and not consent then 'no_email_consent'
              else null end as reason
    from crm.outreach_prospects p
    cross join lateral (select exists (select 1 from crm.email_suppressions e where e.organization_id = p.organization_id and e.email = p.email) as sup) q1
    cross join lateral (select exists (select 1 from crm.communication_consent cc where cc.organization_id = p.organization_id and cc.contact_id = p.contact_id and cc.channel = 'email' and cc.status = 'granted') as consent) q2
    cross join lateral (select (p.lawful_basis = 'b2b_legitimate_interest' and (select cold from s)) or (p.lawful_basis <> 'b2b_legitimate_interest' and consent) as basis_ok) q3
   where p.organization_id = p_organization_id
     and p.status in (select jsonb_array_elements_text(coalesce(p_audience->'statuses', '["new"]'::jsonb)))
     and (p_audience->'tags' is null or jsonb_array_length(p_audience->'tags') = 0 or p.tags && array(select jsonb_array_elements_text(p_audience->'tags')))
     and (p_audience->'languages' is null or jsonb_array_length(p_audience->'languages') = 0 or p.language in (select jsonb_array_elements_text(p_audience->'languages')))
   order by p.created_at
   limit coalesce(nullif((p_audience->>'limit')::int, 0), 2000);
$$;
revoke all on function crm.outreach_audience(uuid, jsonb) from public, anon, authenticated;
grant execute on function crm.outreach_audience(uuid, jsonb) to service_role;

create or replace function crm.preview_email_campaign(p_campaign_id uuid)
returns table (reachable int, suppressed int, no_consent int, cold_not_enabled int)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_c crm.email_campaigns;
begin
  select * into v_c from crm.email_campaigns where id = p_campaign_id;
  if v_c.id is null or v_c.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false) then
    return query select 0, 0, 0, 0; return;
  end if;
  return query
    select count(*) filter (where a.reachable)::int,
           count(*) filter (where a.reason = 'suppressed')::int,
           count(*) filter (where a.reason = 'no_email_consent')::int,
           count(*) filter (where a.reason = 'cold_outreach_not_enabled')::int
      from crm.outreach_audience(v_c.organization_id, v_c.audience) a;
end;
$$;
revoke all on function crm.preview_email_campaign(uuid) from public, anon;
grant execute on function crm.preview_email_campaign(uuid) to authenticated;
-- the preview calls a service-role-only helper as the definer, so authenticated may run the preview itself
grant execute on function crm.outreach_audience(uuid, jsonb) to postgres;

create or replace function crm.approve_email_campaign(p_campaign_id uuid)
returns table (
  -- 'approved' | refusals: 'no_actor' | 'forbidden' | 'unknown_campaign' | 'not_a_draft' | 'creator_cannot_approve'
  --   | 'identity_missing' | 'nobody_reachable'
  outcome text,
  recipient_count int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_c     crm.email_campaigns;
  v_set   crm.outreach_settings;
  v_n     int;
begin
  if v_actor is null then return query select 'no_actor'::text, null::int; return; end if;
  select * into v_c from crm.email_campaigns where id = p_campaign_id for update;
  if v_c.id is null then return query select 'unknown_campaign'::text, null::int; return; end if;
  if v_c.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::int; return;
  end if;
  if v_c.status <> 'draft' then return query select 'not_a_draft'::text, null::int; return; end if;
  if v_c.created_by = v_actor then return query select 'creator_cannot_approve'::text, null::int; return; end if;

  select * into v_set from crm.outreach_settings where organization_id = v_c.organization_id;
  if v_set.organization_id is null or v_set.sender_name is null or v_set.postal_address is null then
    return query select 'identity_missing'::text, null::int; return;
  end if;

  -- THE FREEZE: the audience is expanded here, so the count the approver read is the count that goes.
  insert into crm.email_campaign_recipients (organization_id, campaign_id, prospect_id, email)
  select v_c.organization_id, v_c.id, a.prospect_id, a.email from crm.outreach_audience(v_c.organization_id, v_c.audience) a where a.reachable
  on conflict (campaign_id, prospect_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return query select 'nobody_reachable'::text, 0; return; end if;

  update crm.email_campaigns set status = 'approved', approved_by = v_actor, approved_at = now(), recipient_count = v_n where id = v_c.id;
  perform core.record_audit(v_c.organization_id, 'outreach.campaign_approved', 'email_campaign', v_c.id, null, jsonb_build_object('recipients', v_n));
  return query select 'approved'::text, v_n;
end;
$$;
revoke all on function crm.approve_email_campaign(uuid) from public, anon;
grant execute on function crm.approve_email_campaign(uuid) to authenticated;

create or replace function crm.set_email_campaign_state(p_campaign_id uuid, p_to text, p_note text default null)
returns table (outcome text)
-- 'running' | 'paused' | 'cancelled' | refusals 'forbidden' | 'unknown_campaign' | 'bad_transition' | 'needs_note'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c crm.email_campaigns;
begin
  if (select auth.uid()) is null then return query select 'forbidden'::text; return; end if;
  select * into v_c from crm.email_campaigns where id = p_campaign_id for update;
  if v_c.id is null then return query select 'unknown_campaign'::text; return; end if;
  if v_c.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if not ((v_c.status = 'approved' and p_to in ('running', 'cancelled'))
       or (v_c.status = 'running' and p_to in ('paused', 'cancelled'))
       or (v_c.status = 'paused' and p_to in ('running', 'cancelled'))) then
    return query select 'bad_transition'::text; return;
  end if;
  -- Resuming a run that stopped itself needs a person to say why it is safe.
  if v_c.status = 'paused' and p_to = 'running' and length(btrim(coalesce(p_note, ''))) = 0 then
    return query select 'needs_note'::text; return;
  end if;
  update crm.email_campaigns set status = p_to, paused_reason = case when p_to = 'paused' then left(coalesce(p_note, 'Paused by a person.'), 500) else null end where id = v_c.id;
  perform core.record_audit(v_c.organization_id, 'outreach.campaign_' || p_to, 'email_campaign', v_c.id, null, jsonb_build_object('note', left(p_note, 200)));
  return query select p_to::text;
end;
$$;
revoke all on function crm.set_email_campaign_state(uuid, text, text) from public, anon;
grant execute on function crm.set_email_campaign_state(uuid, text, text) to authenticated;

-- ── the prospect's own story: replied, converted ────────────────────────────

create or replace function crm.mark_prospect_replied(p_prospect_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_p crm.outreach_prospects;
begin
  if (select auth.uid()) is null or not coalesce((select core.can_write()), false) then return query select 'forbidden'::text; return; end if;
  select * into v_p from crm.outreach_prospects where id = p_prospect_id and organization_id = (select core.current_organization_id()) for update;
  if v_p.id is null then return query select 'unknown_prospect'::text; return; end if;
  update crm.outreach_prospects set status = 'replied' where id = v_p.id and status in ('new', 'contacted');
  -- A reply ends the sequence: the next step must never go to someone already talking to us.
  update crm.email_campaign_recipients set status = 'replied' where prospect_id = v_p.id and status = 'pending';
  perform core.record_audit(v_p.organization_id, 'outreach.prospect_replied', 'outreach_prospect', v_p.id, null, null);
  return query select 'replied'::text;
end;
$$;
revoke all on function crm.mark_prospect_replied(uuid) from public, anon;
grant execute on function crm.mark_prospect_replied(uuid) to authenticated;

create or replace function crm.convert_prospect(p_prospect_id uuid)
returns table (outcome text, lead_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_p   crm.outreach_prospects;
  v_contact uuid;
  v_lead uuid;
begin
  if (select auth.uid()) is null or not coalesce((select core.can_write()), false) then return query select 'forbidden'::text, null::uuid; return; end if;
  select * into v_p from crm.outreach_prospects where id = p_prospect_id and organization_id = v_org for update;
  if v_p.id is null then return query select 'unknown_prospect'::text, null::uuid; return; end if;
  if v_p.lead_id is not null then return query select 'already_converted'::text, v_p.lead_id; return; end if;

  v_contact := v_p.contact_id;
  if v_contact is null then
    insert into crm.contacts (organization_id, full_name, email, company, job_title)
    values (v_org, coalesce(v_p.full_name, v_p.email), v_p.email, v_p.company, v_p.job_title)
    on conflict do nothing
    returning id into v_contact;
    if v_contact is null then select c.id into v_contact from crm.contacts c where c.organization_id = v_org and lower(c.email) = v_p.email limit 1; end if;
  end if;
  insert into crm.leads (organization_id, contact_id, title, source, source_ref, status)
  values (v_org, v_contact, coalesce(v_p.company, v_p.full_name, v_p.email) || ' (email outreach)', 'email', 'outreach:' || v_p.id, 'new')
  returning id into v_lead;
  update crm.outreach_prospects set contact_id = v_contact, lead_id = v_lead, status = 'converted' where id = v_p.id;
  update crm.email_campaign_recipients set status = 'replied' where prospect_id = v_p.id and status = 'pending';
  -- No consent is granted here: becoming a lead is not agreeing to be marketed to.
  perform core.record_audit(v_org, 'outreach.prospect_converted', 'outreach_prospect', v_p.id, null, jsonb_build_object('leadId', v_lead));
  return query select 'converted'::text, v_lead;
end;
$$;
revoke all on function crm.convert_prospect(uuid) from public, anon;
grant execute on function crm.convert_prospect(uuid) to authenticated;

-- ── the worker's doors ──────────────────────────────────────────────────────

create or replace function crm.orgs_with_running_email_campaigns()
returns table (organization_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct c.organization_id from crm.email_campaigns c where c.status = 'running';
$$;
revoke all on function crm.orgs_with_running_email_campaigns() from public, anon, authenticated;
grant execute on function crm.orgs_with_running_email_campaigns() to service_role;

-- The warm-up: a new mailbox that sends a burst is a spam source. 10 on the first day, +5 a day, never above the cap.
create or replace function crm.outreach_cap_today(p_organization_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select least(s.daily_cap, case when s.first_send_on is null then 10 else 10 + 5 * greatest(0, (current_date - s.first_send_on)) end)
    from crm.outreach_settings s where s.organization_id = p_organization_id;
$$;
revoke all on function crm.outreach_cap_today(uuid) from public, anon, authenticated;
grant execute on function crm.outreach_cap_today(uuid) to service_role;

create or replace function crm.claim_outreach_sends(p_organization_id uuid, p_limit int)
returns table (
  send_id        uuid,
  recipient_id   uuid,
  campaign_id    uuid,
  step_number    int,
  email          text,
  first_name     text,
  company        text,
  language       text,
  subject        text,
  body           text,
  sender_name    text,
  postal_address text,
  reply_to       text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_set    crm.outreach_settings;
  v_cap    int;
  v_used   int;
  v_room   int;
  v_cold   boolean;
  r        record;
  v_sup    boolean;
  v_consent boolean;
  v_send   uuid;
  v_tpl    crm.email_templates;
begin
  -- 1. The owner's emergency stop and the identity every email must carry.
  if core.org_paused(p_organization_id, 'outbound_paused') then return; end if;
  select * into v_set from crm.outreach_settings where organization_id = p_organization_id;
  if v_set.organization_id is null or v_set.sender_name is null or v_set.postal_address is null then return; end if;
  v_cold := v_set.cold_basis_enabled;

  -- 2. The daily cap, warm-up included, counted over everything reserved today.
  v_cap := crm.outreach_cap_today(p_organization_id);
  select count(*) into v_used from crm.email_outreach_sends x where x.organization_id = p_organization_id and x.reserved_at >= date_trunc('day', now());
  v_room := least(coalesce(p_limit, 10), v_cap - v_used);
  if v_room <= 0 then return; end if;

  for r in
    select rc.id as rid, rc.campaign_id as cid, rc.prospect_id, rc.email as remail, rc.step_number as step,
           p.full_name, p.company as pcompany, p.language as plang, p.lawful_basis, p.contact_id, p.status as pstatus
      from crm.email_campaign_recipients rc
      join crm.email_campaigns c on c.id = rc.campaign_id and c.status = 'running'
      join crm.outreach_prospects p on p.id = rc.prospect_id
     where rc.organization_id = p_organization_id and rc.status = 'pending' and rc.next_send_at <= now()
     order by rc.next_send_at, rc.created_at, rc.id
       for update of rc skip locked
     limit v_room * 3
  loop
    exit when v_room <= 0;

    select exists (select 1 from crm.email_suppressions s where s.organization_id = p_organization_id and s.email = r.remail) into v_sup;
    if v_sup then
      update crm.email_campaign_recipients set status = 'refused', refusal_reason = 'suppressed' where id = r.rid; continue;
    end if;
    if r.pstatus in ('replied', 'converted', 'do_not_contact') then
      update crm.email_campaign_recipients set status = 'refused', refusal_reason = 'prospect_stopped' where id = r.rid; continue;
    end if;
    if r.lawful_basis = 'b2b_legitimate_interest' then
      if not v_cold then
        update crm.email_campaign_recipients set status = 'refused', refusal_reason = 'no_basis' where id = r.rid; continue;
      end if;
    else
      select exists (select 1 from crm.communication_consent cc where cc.organization_id = p_organization_id and cc.contact_id = r.contact_id and cc.channel = 'email' and cc.status = 'granted') into v_consent;
      if not v_consent then
        update crm.email_campaign_recipients set status = 'refused', refusal_reason = 'no_consent' where id = r.rid; continue;
      end if;
    end if;

    select t.* into v_tpl
      from crm.email_campaign_steps st join crm.email_templates t on t.id = st.template_id
     where st.campaign_id = r.cid and st.step_number = r.step and t.status = 'approved';
    if v_tpl.id is null then
      update crm.email_campaign_recipients set status = 'refused', refusal_reason = 'template_not_approved' where id = r.rid; continue;
    end if;

    -- RESERVE before anything is attempted: one send per recipient per step. A stale reservation
    -- (a worker that died) is taken over after ten minutes; a live one is left alone.
    insert into crm.email_outreach_sends (organization_id, campaign_id, recipient_id, step_number, email)
    values (p_organization_id, r.cid, r.rid, r.step, r.remail)
    on conflict on constraint email_outreach_sends_recipient_id_step_number_key do update set reserved_at = now(), status = 'reserved'
      where crm.email_outreach_sends.status in ('reserved', 'failed') and crm.email_outreach_sends.reserved_at < now() - interval '10 minutes'
    returning id into v_send;
    if v_send is null then continue; end if;

    update crm.email_campaign_recipients set attempts = attempts + 1 where id = r.rid;
    update crm.outreach_settings set first_send_on = coalesce(first_send_on, current_date) where organization_id = p_organization_id;
    v_room := v_room - 1;

    return query select v_send, r.rid, r.cid, r.step, r.remail,
      nullif(split_part(coalesce(r.full_name, ''), ' ', 1), ''), r.pcompany, r.plang,
      v_tpl.subject, v_tpl.body, v_set.sender_name, v_set.postal_address, v_set.reply_to;
  end loop;
end;
$$;
revoke all on function crm.claim_outreach_sends(uuid, int) from public, anon, authenticated;
grant execute on function crm.claim_outreach_sends(uuid, int) to service_role;

create or replace function crm.record_outreach_result(p_send_id uuid, p_outcome text, p_message_ref text, p_error text)
returns table (outcome text)
-- 'recorded' | 'unknown_send'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_s     crm.email_outreach_sends;
  v_r     crm.email_campaign_recipients;
  v_next  crm.email_campaign_steps;
  v_set   crm.outreach_settings;
  v_total int;
  v_bad   int;
begin
  select * into v_s from crm.email_outreach_sends where id = p_send_id for update;
  if v_s.id is null then return query select 'unknown_send'::text; return; end if;
  select * into v_r from crm.email_campaign_recipients where id = v_s.recipient_id for update;

  if p_outcome = 'sent' then
    update crm.email_outreach_sends set status = 'sent', message_ref = left(p_message_ref, 300), sent_at = now() where id = v_s.id;
    select * into v_next from crm.email_campaign_steps where campaign_id = v_s.campaign_id and step_number = v_s.step_number + 1;
    if v_next.id is null then
      update crm.email_campaign_recipients set status = 'done' where id = v_r.id;
    else
      update crm.email_campaign_recipients set step_number = v_next.step_number, next_send_at = now() + make_interval(days => v_next.delay_days) where id = v_r.id;
    end if;
    update crm.outreach_prospects set status = 'contacted' where id = v_r.prospect_id and status = 'new';
    perform core.record_audit(v_s.organization_id, 'outreach.email_sent', 'email_outreach_send', v_s.id, null, jsonb_build_object('step', v_s.step_number));
  elsif p_outcome = 'bounced' then
    update crm.email_outreach_sends set status = 'bounced', error = left(p_error, 500) where id = v_s.id;
    update crm.email_campaign_recipients set status = 'bounced', last_error = left(p_error, 500) where id = v_r.id;
    perform crm._suppress_email(v_s.organization_id, v_s.email, 'hard_bounce', 'smtp', p_error, null);
    perform core.record_audit(v_s.organization_id, 'outreach.email_bounced', 'email_outreach_send', v_s.id, null, null);
  else
    update crm.email_outreach_sends set status = 'failed', error = left(p_error, 500) where id = v_s.id;
    update crm.email_campaign_recipients set last_error = left(p_error, 500), status = case when attempts >= 3 then 'failed' else status end where id = v_r.id;
  end if;

  -- THE BRAKE: a run that bounces too much stops itself and tells a person.
  select * into v_set from crm.outreach_settings where organization_id = v_s.organization_id;
  select count(*) filter (where status in ('sent', 'bounced')), count(*) filter (where status = 'bounced')
    into v_total, v_bad
    from crm.email_outreach_sends where campaign_id = v_s.campaign_id and reserved_at >= now() - interval '7 days';
  if v_total >= 20 and (v_bad::numeric * 100 / v_total) >= coalesce(v_set.bounce_pause_percent, 5.0) then
    update crm.email_campaigns
       set status = 'paused', paused_reason = left(format('Paused automatically: %s of the last %s sends bounced (%s%%).', v_bad, v_total, round(v_bad::numeric * 100 / v_total, 1)), 500)
     where id = v_s.campaign_id and status = 'running';
    if found then
      perform core.raise_alert(v_s.organization_id, 'outreach', 'warning',
        format('An outreach campaign paused itself: %s of %s sends bounced. Check the list before resuming.', v_bad, v_total), 'outreach-bounce-pause:' || v_s.campaign_id);
      perform core.emit_event(v_s.organization_id, 'outreach.campaign_paused', 'email_campaign', v_s.campaign_id, jsonb_build_object('reason', 'bounce_rate'));
    end if;
  end if;
  return query select 'recorded'::text;
end;
$$;
revoke all on function crm.record_outreach_result(uuid, text, text, text) from public, anon, authenticated;
grant execute on function crm.record_outreach_result(uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';
