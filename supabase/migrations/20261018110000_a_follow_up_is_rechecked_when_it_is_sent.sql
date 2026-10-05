-- ═══════════════════════════════════════════════════════════════════════════
-- A follow-up is re-checked at the moment it is sent.
--
-- Spec §122: "before every follow-up check: did the lead reply, opt out, is it WON / LOST /
-- DISQUALIFIED, was a meeting booked, did another owner take over?" - never send a stale
-- follow-up. The chokepoint already refused suppressed, stopped and unconsented people. It now
-- also asks crm.email_followup_blockers (20261018100000) for what changed on the LEAD since the
-- step was scheduled: the lead closed, another agent owns the conversation, a meeting is live, a
-- meeting or quotation subtask is open.
--
-- Carried forward from the live definition (read back with pg_get_functiondef, not retyped) with
-- ONE marked edit, after the existing prospect_stopped refusal. A refused recipient is recorded
-- with its reason like every other refusal; nothing is deleted and nothing is sent.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION crm.claim_outreach_sends(p_organization_id uuid, p_limit integer)
 RETURNS TABLE(send_id uuid, recipient_id uuid, campaign_id uuid, step_number integer, email text, first_name text, company text, language text, subject text, body text, sender_name text, postal_address text, reply_to text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- EDIT (lead generation, 20261015110000): the acquisition stops are read here too. Both the global
  -- stop and a paused email channel make the claim return nothing, so recipients stay 'pending' and
  -- wait: a pause thrown while a campaign is running stops the NEXT send, not just the next schedule.
  if core.org_paused(p_organization_id, 'outbound_paused') then return; end if;
  if crm.acquisition_blocked(p_organization_id, 'email') is not null then return; end if;
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
    -- EDIT (lead generation, 20261018110000): a follow-up is re-checked at the moment it is sent (spec §122). The lead may have closed,
    -- another agent may own the conversation, or a meeting or quotation may be under way, since this step was scheduled.
    if exists (select 1 from unnest(crm.email_followup_blockers(p_organization_id, r.prospect_id)) b
                where b in ('lead_closed', 'owner_moved', 'meeting_in_progress', 'subtask_open')) then
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
$function$;

notify pgrst, 'reload schema';
