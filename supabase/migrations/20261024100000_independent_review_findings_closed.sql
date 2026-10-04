-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 12 — what three independent reviews found, closed.
--
-- Three reviewers who had not written the code were pointed at it - one for
-- tenancy and privileges, one for the governed-execution guarantees, one for
-- honesty and secrets - and each was told to PROVE what it claimed. Everything
-- below was reproduced in a scratch database before it was fixed, and each fix
-- has a regression in scripts/verify-acquisition-hardening.sql that fails if
-- the fix is removed.
--
--  TENANCY / PRIVILEGE
--   1. crm.current_qualification_weights answered with ANOTHER organisation's
--      weights (it trusted its argument).
--   2. Eight read functions and the policy question skipped the is_internal()
--      gate their tables enforce, so a portal CLIENT could read internal spend
--      and budget and write rows to the decision ledger.
--   3. crm.bind_approval had no role check: any internal member could pre-bind
--      another person's artifact with a forged approval card, a forged amount
--      (an owner-tier approval downgraded to an admin one) or a junk hash that
--      made the version un-submittable for ever.
--   4. crm.acquisition_goal_progress joined an all-organisations aggregate to
--      each organisation's row when called with no session.
--   5. A handoff token hash was unique per organisation, not globally, while the
--      public link resolves by hash alone.
--  GOVERNED EXECUTION
--   6. Usage is written when work FINISHES, so a daily limit and a monthly cap
--      let in everything that had BEGUN: three approved posts all started under
--      a limit of one; two campaigns each under the cap went far over together.
--      In-flight work and committed ad budget now count.
--   7. Any one active social connector satisfied publishing for every platform.
--   8. finish_governed_execution accepted an execution that belonged to a
--      different artifact. The four doors that call it now refuse it.
--   9. A person's recorded B2B submission or profile update skipped the policy
--      block (and, for profiles, the daily limit).
--  10. "An agent cannot set a price" rested on a parameter the caller supplied.
--      A price now needs a signed-in person.
--  11. An admin could lift an owner's BLOCK policy.
--  12. A channel outside the plan still executed (email excepted, as before).
--  13. A budget change was classed by the 30-day estimate, so a tenfold daily
--      rate under a total cap was a "creative change" worth nothing.
--  HONESTY
--  14. crm.register_integration trusted a caller's claim that an adapter exists.
--  15. Alerts told a person to "record it" for ads, social and landing pages
--      with nowhere to record it, and a hand-uploaded landing page could never
--      become VERIFIED, so a Google ad could never launch even by hand. The
--      by-hand path is now real: record_manual_ad_apply / _ad_change /
--      _ad_metrics, record_manual_publish, record_manual_landing_deploy - each
--      accepted only for the exact approved version, once, with the stops, the
--      policy, the plan, the limits and the cap re-read at that moment.
--  16. The public landing address could name an internal host or an IP literal.
--
-- Every function below is carried forward from its LIVE definition
-- (pg_get_functiondef on the database the earlier migrations produced) with the
-- marked edits only.
-- ═══════════════════════════════════════════════════════════════════════════

-- crm.bind_approval, carried forward from 20261016100000 with ONE edit: a session must be an admin (any internal member could pre-bind another's artifact with a forged card and amount, or poison it with a junk hash).
create or replace function crm.bind_approval(p_organization_id uuid, p_artifact_type text, p_artifact_id uuid, p_version integer, p_content_hash text, p_summary text, p_amount_minor bigint, p_requested_by_type text, p_requested_by_id uuid, p_valid_hours integer DEFAULT 72, p_correlation_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, request_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_prior text;
  v_req   record;
begin
  if (select auth.uid()) is not null and p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  -- Binding fixes the approval card (its words, amount and validity) and is immutable: any internal member could pre-bind someone else's artifact
  -- with a card of their own and a junk hash. It is an admin's act (the doors that call it are admin doors).
  if (select auth.uid()) is not null and not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if p_artifact_type not in ('social_content', 'b2b_proposal', 'ad_campaign', 'acquisition_action') or p_content_hash !~ '^[0-9a-f]{64}$'
     or coalesce(p_version, 0) < 1 or coalesce(p_valid_hours, 72) not between 1 and 720 or p_artifact_id is null then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  -- An artifact id names ONE immutable version. The same id with different content means a version was edited in place:
  -- refuse, the caller must create a new version (a new id) and ask again.
  select b.content_hash into v_prior from crm.approval_bindings b
   where b.organization_id = p_organization_id and b.artifact_type = p_artifact_type and b.artifact_id = p_artifact_id
   order by b.created_at desc limit 1;
  if v_prior is not null and v_prior <> p_content_hash then
    return query select 'content_changed'::text, null::uuid; return;
  end if;

  select * into v_req from approvals.request_approval(p_organization_id, p_artifact_type, p_artifact_id, p_requested_by_type, p_requested_by_id,
    left(p_summary, 500), jsonb_build_object('artifact_type', p_artifact_type, 'version', p_version, 'content_hash', p_content_hash),
    p_amount_minor, 'internal', p_correlation_id);
  if v_req.outcome not in ('requested', 'already_pending') then
    return query select v_req.outcome::text, null::uuid; return;
  end if;
  insert into crm.approval_bindings (approval_request_id, organization_id, artifact_type, artifact_id, version, content_hash, valid_until)
  values (v_req.request_id, p_organization_id, p_artifact_type, p_artifact_id, p_version, p_content_hash, now() + make_interval(hours => coalesce(p_valid_hours, 72)))
  on conflict (approval_request_id) do nothing;
  return query select v_req.outcome::text, v_req.request_id;
end;
$function$;

-- crm.current_qualification_weights, carried forward from 20261018100000 with ONE edit: a session may read only its own organisation's weights (it answered with another tenant's).
create or replace function crm.current_qualification_weights(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    (select m.weights from crm.qualification_models m where m.organization_id = p_organization_id
        and ((select auth.uid()) is null or (p_organization_id = (select core.current_organization_id()) and (select core.is_internal()))) order by m.version desc limit 1),
    (select jsonb_object_agg(f, 1) from unnest(crm.qualification_factors()) as f));
$function$;

-- crm.acquisition_decide, carried forward from 20261016100000 with three edits: portal clients are refused, a channel outside the plan does not act (email excepted), and in-flight work counts against the daily limit.
create or replace function crm.acquisition_decide(p_organization_id uuid, p_action text, p_channel text DEFAULT NULL::text, p_amount_minor bigint DEFAULT 0, p_requested_count integer DEFAULT 1, p_correlation_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(decision text, reason text, required_role text, policy_version text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_channel text;
  v_block   text;
  v_pol     crm.acquisition_policies;
  v_chan    crm.acquisition_channels;
  v_need    text[];
  v_used_today bigint;
  v_used_month bigint;
  v_amount  bigint := greatest(coalesce(p_amount_minor, 0), 0);
  v_count   integer := greatest(coalesce(p_requested_count, 1), 1);
  d text; r text; role text; ver text;
begin
  if (select auth.uid()) is not null and p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'BLOCK'::text, 'tenant_mismatch'::text, null::text, null::text; return;
  end if;
  -- The decision ledger is internal: a portal client (not internal) can neither ask nor write a row.
  if (select auth.uid()) is not null and not coalesce((select core.is_internal()), false) then
    return query select 'BLOCK'::text, 'not_internal'::text, null::text, null::text; return;
  end if;

  v_channel := crm.action_channel(p_action, p_channel);
  if v_channel is null then
    d := 'BLOCK'; r := case when crm.action_channel(p_action, 'meta_ads') is null and p_action not in ('ad_launch', 'ad_budget_increase', 'ad_targeting_change') then 'unknown_action' else 'channel_required' end;
  else
    select * into v_pol from crm.acquisition_policies p where p.organization_id = p_organization_id and p.action_type = p_action;
    ver := case when v_pol.id is not null then v_pol.id::text || ':' || extract(epoch from v_pol.updated_at)::bigint::text else 'default' end;

    -- 1. the stops: global, then channel. Commercial actions have no channel to pause.
    if v_channel <> 'none' then
      v_block := crm.acquisition_blocked(p_organization_id, v_channel);
      if v_block is not null then d := 'BLOCK'; r := v_block; end if;
    end if;

    -- 1b. a channel that is not part of the plan does not act. Email is the exception: a running campaign must not be stopped by a switch that defaults to off.
    if d is null and v_channel not in ('none', 'email') then
      if not exists (select 1 from crm.acquisition_channels c where c.organization_id = p_organization_id and c.channel = v_channel and c.enabled) then
        d := 'BLOCK'; r := 'channel_not_enabled';
      end if;
    end if;

    -- 2. a connector the action cannot run without (email uses the existing governed lane)
    if d is null then
      v_need := crm.required_providers(p_action, v_channel);
      if array_length(v_need, 1) is not null and not exists (
        select 1 from crm.acquisition_integrations i
         where i.organization_id = p_organization_id and i.provider = any (v_need) and i.status = 'ACTIVE') then
        d := 'BLOCK'; r := 'integration_not_active';
      end if;
    end if;

    -- 3. the Admin's limits: a daily action ceiling and a monthly spend cap. A cap is a cap - approval cannot lift it.
    if d is null and v_channel <> 'none' then
      select * into v_chan from crm.acquisition_channels c where c.organization_id = p_organization_id and c.channel = v_channel;
      if v_chan.organization_id is not null and v_chan.daily_limit is not null then
        select coalesce(sum(u.amount), 0) into v_used_today from crm.acquisition_usage u
         where u.organization_id = p_organization_id and u.channel = v_channel and u.metric = 'action'
           and u.occurred_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
        -- Work that has begun and not finished counts: usage is written when work FINISHES, so three approved items could all begin before any was counted.
        v_used_today := v_used_today + (select count(*) from crm.governed_executions e where e.organization_id = p_organization_id and e.channel = v_channel
                                         and e.status in ('executing', 'unknown') and e.started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc');
        if v_used_today + v_count > v_chan.daily_limit then d := 'BLOCK'; r := 'daily_limit'; end if;
      end if;
      if d is null and v_chan.organization_id is not null and v_chan.monthly_budget_minor is not null and v_amount > 0 then
        select coalesce(sum(u.amount), 0) into v_used_month from crm.acquisition_usage u
         where u.organization_id = p_organization_id and u.channel = v_channel and u.metric = 'spend_minor'
           and u.occurred_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
        if v_used_month + v_amount > v_chan.monthly_budget_minor then d := 'BLOCK'; r := 'monthly_budget_exceeded'; end if;
      end if;
    end if;

    -- 4. the policy. No row is not permission: it is ADMIN_APPROVAL_REQUIRED.
    if d is null then
      if v_pol.id is null then
        d := 'ADMIN_APPROVAL_REQUIRED'; r := 'no_policy_default'; role := 'ops_admin';
      elsif v_pol.mode = 'block' then
        d := 'BLOCK'; r := 'blocked_by_policy';
      elsif v_pol.escalate_above_minor is not null and v_amount > v_pol.escalate_above_minor then
        d := 'ESCALATE'; r := 'above_escalation_threshold'; role := 'owner';
      elsif v_pol.mode = 'approval' then
        d := 'ADMIN_APPROVAL_REQUIRED'; r := 'policy_requires_approval'; role := 'ops_admin';
      elsif v_pol.approval_above_minor is not null and v_amount > v_pol.approval_above_minor then
        d := 'ADMIN_APPROVAL_REQUIRED'; r := 'above_auto_threshold'; role := 'ops_admin';
      else
        d := 'AUTO_APPROVE'; r := 'within_policy';
      end if;
    end if;
  end if;

  insert into crm.acquisition_decisions (organization_id, action_type, channel, amount_minor, decision, reason, policy_version, correlation_id)
  values (p_organization_id, p_action, v_channel, v_amount, d, r, ver, p_correlation_id);
  return query select d, r, role, ver;
end;
$function$;

-- crm.set_acquisition_policy, carried forward from 20261020100000 with ONE edit: lifting a BLOCK is loosening, so it is the owner's.
create or replace function crm.set_acquisition_policy(p_action text, p_mode text, p_approval_above_minor bigint, p_escalate_above_minor bigint)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_before jsonb;
  v_after jsonb;
  v_loosens boolean;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  if crm.action_channel(p_action, 'meta_ads') is null and p_action not in ('ad_launch', 'ad_budget_increase', 'ad_targeting_change') then
    return query select 'invalid'::text; return;
  end if;
  if p_mode not in ('auto', 'approval', 'block') or coalesce(p_approval_above_minor, 0) < 0 or coalesce(p_escalate_above_minor, 0) < 0 then
    return query select 'invalid'::text; return;
  end if;
  if p_mode = 'auto' and p_action in ('social_publish', 'b2b_proposal_submit', 'ad_launch', 'landing_page_deploy', 'profile_update', 'ad_budget_increase', 'ad_targeting_change') then
    return query select 'never_auto'::text; return;
  end if;
  select to_jsonb(p.*) into v_before from crm.acquisition_policies p where p.organization_id = v_org and p.action_type = p_action for update;
  -- Loosening governance (to auto, or a higher threshold than before) is the owner's. Tightening is any admin's.
  v_loosens := p_mode = 'auto' and coalesce(v_before ->> 'mode', '') <> 'auto'
               or (p_mode = 'auto' and coalesce((v_before ->> 'approval_above_minor')::bigint, 0) < coalesce(p_approval_above_minor, 9223372036854775807))
               or (v_before is null and p_mode = 'auto')
               or (v_before is not null and v_before ->> 'mode' = 'block' and p_mode <> 'block')
               or (p_mode <> 'block' and v_before is not null and (v_before ->> 'escalate_above_minor') is not null
                   and coalesce(p_escalate_above_minor, 9223372036854775807) > (v_before ->> 'escalate_above_minor')::bigint);
  if v_loosens and not coalesce((select core.is_owner()), false) then return query select 'not_owner'::text; return; end if;

  insert into crm.acquisition_policies (organization_id, action_type, mode, approval_above_minor, escalate_above_minor, updated_by)
  values (v_org, p_action, p_mode, p_approval_above_minor, p_escalate_above_minor, v_actor)
  on conflict (organization_id, action_type) do update
     set mode = excluded.mode, approval_above_minor = excluded.approval_above_minor,
         escalate_above_minor = excluded.escalate_above_minor, updated_by = v_actor, updated_at = now()
  returning to_jsonb(crm.acquisition_policies.*) into v_after;
  perform core.record_audit(v_org, 'acquisition.policy_changed', 'acquisition_policy', null, v_before, v_after);
  return query select 'saved'::text;
end;
$function$;

-- crm.register_integration, carried forward from 20261016100000 with ONE edit: whether an adapter exists is a fact about the CODE, so a caller's claim is ignored (a connection starts NOT_IMPLEMENTED; the engine's own `sync_integration_adapter` is what says otherwise).
create or replace function crm.register_integration(p_provider text, p_environment text, p_label text, p_adapter_implemented boolean)
 RETURNS TABLE(outcome text, integration_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_id    uuid;
  v_label text := coalesce(nullif(btrim(coalesce(p_label, '')), ''), 'default');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text, null::uuid; return; end if;
  if crm.provider_type(p_provider) is null or p_environment not in ('development', 'staging', 'production') or length(v_label) > 60 then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  begin
    insert into crm.acquisition_integrations (organization_id, provider, environment, label, adapter_implemented, verification, created_by)
    values (v_org, p_provider, p_environment, v_label, false, 'NOT_IMPLEMENTED', v_actor)
    returning id into v_id;
  exception when unique_violation then
    return query select 'duplicate'::text, null::uuid; return;
  end;
  perform core.record_audit(v_org, 'integration.registered', 'acquisition_integration', v_id, null,
    jsonb_build_object('provider', p_provider, 'environment', p_environment, 'adapter_implemented', false));
  return query select 'registered'::text, v_id;
end;
$function$;

-- crm.lead_outcome, carried forward from 20261015200000 with ONE edit: internal sessions only (its tables are internal-only).
create or replace function crm.lead_outcome(p_lead uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- WON / LOST / DISQUALIFIED / NURTURE / OPEN, from the two places the existing lifecycle already keeps them. Not stored.
  select case
    when l.status = 'converted' or o.stage = 'won' then 'WON'
    when o.stage = 'lost' then 'LOST'
    when l.status = 'disqualified' then 'DISQUALIFIED'
    when l.status = 'nurture' then 'NURTURE'
    else 'OPEN'
  end
  from crm.leads l
  left join lateral (
    select op.stage from sales.opportunities op where op.lead_id = l.id order by op.created_at desc, op.id desc limit 1
  ) o on true
  where l.id = p_lead
    -- A session may only ask about its own organisation; the service role (no auth.uid()) is the engines.
    and ((select auth.uid()) is null or (l.organization_id = (select core.current_organization_id()) and (select core.is_internal())));
$function$;

-- crm.content_status, carried forward from 20261019100000 with ONE edit: internal sessions only.
create or replace function crm.content_status(p_version uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v crm.content_versions; r record; c record;
begin
  select * into v from crm.content_versions x where x.id = p_version;
  if v.id is null then return null; end if;
  if (select auth.uid()) is not null and v.organization_id is distinct from (select core.current_organization_id()) then return null; end if;
  if (select auth.uid()) is not null and not coalesce((select core.is_internal()), false) then return null; end if;
  if v.state = 'AI_REVIEWED' then return 'AI_REVIEW_PASSED'; end if;
  if v.state <> 'ADMIN_REVIEW' then return v.state; end if;
  select * into r from approvals.approval_requests a where a.id = v.approval_request_id;
  if r.id is null then return 'ADMIN_REVIEW'; end if;
  if r.state = 'approved' then
    select * into c from crm.approval_check(v.approval_request_id, 'social_content', v.id, v.content_hash);
    return case when c.covered then 'APPROVED' else 'APPROVAL_LAPSED' end;
  end if;
  return case r.state when 'pending' then 'ADMIN_REVIEW' when 'rejected' then 'REJECTED' when 'changes_requested' then 'CHANGES_REQUESTED'
                      when 'expired' then 'APPROVAL_EXPIRED' else upper(r.state) end;
end;
$function$;

-- crm.begin_content_publish, carried forward from 20261019100000 with ONE edit: the connector for the version's OWN platform must be active.
create or replace function crm.begin_content_publish(p_organization_id uuid, p_version uuid, p_correlation_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, reason text, execution_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v crm.content_versions;
  d record;
  g record;
begin
  select * into v from crm.content_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text, null::uuid; return; end if;
  if v.state = 'PUBLISHED' then return query select 'already_published'::text, null::text, null::uuid; return; end if;
  if v.state not in ('SCHEDULED', 'PUBLISHING') then return query select 'not_scheduled'::text, v.state, null::uuid; return; end if;
  if v.state = 'SCHEDULED' and v.scheduled_for is not null and v.scheduled_for > now() then return query select 'not_yet_due'::text, null::text, null::uuid; return; end if;

  -- The connector for THIS version's platform must be active: any one of the three social connectors was enough.
  if not exists (select 1 from crm.acquisition_integrations i join crm.content_items ci on ci.id = v.item_id
                  where i.organization_id = p_organization_id and i.status = 'ACTIVE' and i.provider = case ci.platform when 'facebook' then 'facebook_page' else ci.platform end) then
    return query select 'blocked'::text, 'integration_not_active'::text, null::uuid; return;
  end if;

  -- The connector, the limits and the stops are asked NOW. ADMIN_APPROVAL_REQUIRED is expected (publishing is never automatic) and is
  -- satisfied by the exact-version approval checked below; only BLOCK refuses.
  select * into d from crm.acquisition_decide(p_organization_id, 'social_publish', null, 0, 1, p_correlation_id);
  if d.decision = 'BLOCK' then return query select 'blocked'::text, d.reason, null::uuid; return; end if;

  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'social_content', v.id, v.content_hash, 'social_publish', 'social', p_correlation_id);
  if g.outcome = 'proceed' then
    if v.state = 'SCHEDULED' then
      perform set_config('crm.content_write', '1', true);
      update crm.content_versions set state = 'PUBLISHING' where id = v.id;
      perform set_config('crm.content_write', '', true);
    end if;
    return query select 'proceed'::text, g.reason, g.execution_id; return;
  end if;
  return query select g.outcome::text, g.reason, g.execution_id;
end;
$function$;

-- crm.record_publish, carried forward from 20261019100000 with ONE edit: the execution being finished must be THIS version's (it accepted another artifact's execution id and left both stuck).
create or replace function crm.record_publish(p_organization_id uuid, p_version uuid, p_execution uuid, p_status text, p_external_ref text, p_url text, p_evidence jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v crm.content_versions; i crm.content_items; f record;
begin
  if p_status not in ('executed', 'failed', 'unknown') then return query select 'invalid'::text; return; end if;
  select * into v from crm.content_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text; return; end if;
  if v.state <> 'PUBLISHING' then return query select 'wrong_state'::text; return; end if;
  if p_status = 'executed' and coalesce(btrim(p_external_ref), '') = '' then return query select 'needs_reference'::text; return; end if;
  select * into i from crm.content_items x where x.id = v.item_id;

  if not exists (select 1 from crm.governed_executions e where e.id = p_execution and e.organization_id = p_organization_id and e.artifact_id = v.id) then
    return query select 'wrong_execution'::text; return;
  end if;
  select * into f from crm.finish_governed_execution(p_organization_id, p_execution, p_status, p_external_ref, p_evidence);
  if f.outcome <> 'recorded' then return query select f.outcome::text; return; end if;

  if p_status = 'executed' then
    insert into crm.social_publications (organization_id, version_id, execution_id, platform, external_ref, url)
    values (p_organization_id, v.id, p_execution, i.platform, btrim(p_external_ref), p_url);
    perform set_config('crm.content_write', '1', true);
    update crm.content_versions set state = 'PUBLISHED' where id = v.id;
    perform set_config('crm.content_write', '', true);
    perform crm.record_acquisition_usage(p_organization_id, 'social', 'action', 1, 'publish:' || v.id::text);
  elsif p_status = 'failed' then
    -- Back to SCHEDULED: the governed door decides whether another attempt is allowed (at most three).
    perform set_config('crm.content_write', '1', true);
    update crm.content_versions set state = 'SCHEDULED' where id = v.id;
    perform set_config('crm.content_write', '', true);
  end if;
  -- unknown: stays PUBLISHING. It is reconciled against the provider, never re-posted.
  perform core.record_audit(p_organization_id, 'content.publish_' || p_status, 'content_item', v.item_id, null, jsonb_build_object('version', v.version, 'external_ref', left(p_external_ref, 200)));
  return query select 'recorded'::text;
end;
$function$;

-- crm.record_ad_apply, carried forward from 20261020100000 with ONE edit: the execution being finished must be THIS version's (it accepted another artifact's execution id and left both stuck).
create or replace function crm.record_ad_apply(p_organization_id uuid, p_version uuid, p_execution uuid, p_status text, p_provider_campaign_id text, p_objects jsonb DEFAULT '[]'::jsonb, p_evidence jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v crm.ad_campaign_versions; c crm.ad_campaigns; f record; o jsonb; prev uuid;
begin
  if p_status not in ('executed', 'failed', 'unknown') then return query select 'invalid'::text; return; end if;
  select * into v from crm.ad_campaign_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text; return; end if;
  if v.state <> 'LAUNCHING' then return query select 'wrong_state'::text; return; end if;
  if p_status = 'executed' and coalesce(btrim(p_provider_campaign_id), '') = '' then return query select 'needs_reference'::text; return; end if;
  select * into c from crm.ad_campaigns x where x.id = v.campaign_id for update;

  if not exists (select 1 from crm.governed_executions e where e.id = p_execution and e.organization_id = p_organization_id and e.artifact_id = v.id) then
    return query select 'wrong_execution'::text; return;
  end if;
  select * into f from crm.finish_governed_execution(p_organization_id, p_execution, p_status, p_provider_campaign_id, p_evidence);
  if f.outcome <> 'recorded' then return query select f.outcome::text; return; end if;

  if p_status = 'executed' then
    for prev in select x.id from crm.ad_campaign_versions x where x.campaign_id = c.id and x.state in ('LIVE', 'PAUSED') and x.id <> v.id loop
      perform crm._ad_set_state(prev, 'SUPERSEDED');
    end loop;
    insert into crm.ad_applications (organization_id, version_id, execution_id, provider_campaign_id) values (p_organization_id, v.id, p_execution, btrim(p_provider_campaign_id));
    insert into crm.ad_provider_objects (organization_id, campaign_id, platform, object_type, provider_id)
    values (p_organization_id, c.id, c.platform, 'campaign', btrim(p_provider_campaign_id)) on conflict do nothing;
    for o in select e.value from jsonb_array_elements(case when jsonb_typeof(p_objects) = 'array' then p_objects else '[]'::jsonb end) e loop
      if o ->> 'object_type' in ('campaign', 'ad_set', 'ad_group', 'ad', 'keyword', 'creative') and length(coalesce(o ->> 'provider_id', '')) between 1 and 200 then
        insert into crm.ad_provider_objects (organization_id, campaign_id, platform, object_type, provider_id)
        values (p_organization_id, c.id, c.platform, o ->> 'object_type', o ->> 'provider_id') on conflict do nothing;
      end if;
    end loop;
    perform crm._ad_set_state(v.id, 'LIVE');
    update crm.ad_campaigns set status = 'live', live_version_id = v.id, provider_sync_pending = null where id = c.id;
    perform crm.record_acquisition_usage(p_organization_id, c.platform, 'action', 1, 'ad-apply:' || v.id::text);
  elsif p_status = 'failed' then
    perform crm._ad_set_state(v.id, 'ADMIN_REVIEW');
  end if;
  perform core.record_audit(p_organization_id, 'ads.apply_' || p_status, 'ad_campaign', c.id, null, jsonb_build_object('version', v.version, 'kind', v.change_kind, 'provider_ref', left(p_provider_campaign_id, 200)));
  return query select 'recorded'::text;
end;
$function$;

-- crm.record_landing_deploy, carried forward from 20261021100000 with ONE edit: the execution being finished must be THIS version's (it accepted another artifact's execution id and left both stuck).
create or replace function crm.record_landing_deploy(p_organization_id uuid, p_version uuid, p_execution uuid, p_status text, p_deployed_url text, p_html_hash text, p_evidence jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v crm.landing_page_versions; f record; prev uuid;
begin
  if p_status not in ('executed', 'failed', 'unknown') then return query select 'invalid'::text; return; end if;
  select * into v from crm.landing_page_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text; return; end if;
  if v.state <> 'DEPLOYING' then return query select 'wrong_state'::text; return; end if;
  if p_status = 'executed' and (coalesce(p_deployed_url, '') !~ '^https://' or coalesce(p_html_hash, '') !~ '^[0-9a-f]{64}$') then return query select 'needs_evidence'::text; return; end if;
  -- The host may serve only the address that was approved.
  if p_status = 'executed' and p_deployed_url <> v.public_url then return query select 'url_differs_from_approved'::text; return; end if;
  if not exists (select 1 from crm.governed_executions e where e.id = p_execution and e.organization_id = p_organization_id and e.artifact_id = v.id) then
    return query select 'wrong_execution'::text; return;
  end if;
  select * into f from crm.finish_governed_execution(p_organization_id, p_execution, p_status, p_deployed_url, p_evidence);
  if f.outcome <> 'recorded' then return query select f.outcome::text; return; end if;
  if p_status = 'executed' then
    for prev in select x.id from crm.landing_page_versions x where x.page_id = v.page_id and x.state in ('DEPLOYED', 'VERIFIED', 'VERIFY_FAILED') and x.id <> v.id loop
      perform crm._landing_set_state(prev, 'SUPERSEDED');
    end loop;
    insert into crm.landing_deployments (organization_id, version_id, execution_id, deployed_url, deployed_html_hash) values (p_organization_id, v.id, p_execution, p_deployed_url, p_html_hash);
    perform crm._landing_set_state(v.id, 'DEPLOYED');
    update crm.landing_pages set status = 'active', live_version_id = v.id where id = v.page_id;
    perform crm.record_acquisition_usage(p_organization_id, 'google_ads', 'action', 1, 'landing-deploy:' || v.id::text);
  elsif p_status = 'failed' then
    perform crm._landing_set_state(v.id, 'ADMIN_REVIEW');
  end if;
  perform core.record_audit(p_organization_id, 'landing.deploy_' || p_status, 'landing_page', v.page_id, null, jsonb_build_object('version', v.version));
  return query select 'recorded'::text;
end;
$function$;

-- crm._b2b_finish_submit, carried forward from 20261022100000 with ONE edit: the execution being finished must be THIS version's (it accepted another artifact's execution id and left both stuck).
create or replace function crm._b2b_finish_submit(p_organization_id uuid, p_version uuid, p_execution uuid, p_status text, p_external_ref text, p_via text, p_evidence jsonb)
 RETURNS TABLE(outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v crm.b2b_proposal_versions; f record;
begin
  if p_status not in ('executed', 'failed', 'unknown') then return query select 'invalid'::text; return; end if;
  select * into v from crm.b2b_proposal_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text; return; end if;
  if v.state <> 'SUBMITTING' then return query select 'wrong_state'::text; return; end if;
  if p_status = 'executed' and coalesce(btrim(p_external_ref), '') = '' then return query select 'needs_reference'::text; return; end if;
  if not exists (select 1 from crm.governed_executions e where e.id = p_execution and e.organization_id = p_organization_id and e.artifact_id = v.id) then
    return query select 'wrong_execution'::text; return;
  end if;
  select * into f from crm.finish_governed_execution(p_organization_id, p_execution, p_status, p_external_ref, p_evidence);
  if f.outcome <> 'recorded' then return query select f.outcome::text; return; end if;
  if p_status = 'executed' then
    perform set_config('crm.b2b_write', '1', true);
    update crm.b2b_proposal_versions set state = 'SUBMITTED', external_ref = left(btrim(p_external_ref), 200), submitted_via = p_via where id = v.id;
    update crm.b2b_opportunities set status = 'submitted' where id = v.opportunity_id;
    perform set_config('crm.b2b_write', '', true);
    perform crm.record_acquisition_usage(p_organization_id, 'b2b', 'action', 1, 'b2b-submit:' || v.id::text);
    if v.connects_cost > 0 then perform crm.record_acquisition_usage(p_organization_id, 'b2b', 'connect', v.connects_cost, 'b2b-connects:' || v.id::text); end if;
  elsif p_status = 'failed' then
    perform crm._b2b_set('proposal', v.id, 'ADMIN_REVIEW');
  end if;
  perform core.record_audit(p_organization_id, 'b2b.proposal_' || p_status, 'b2b_opportunity', v.opportunity_id, null, jsonb_build_object('version', v.version, 'via', p_via, 'external_ref', left(p_external_ref, 200)));
  return query select 'recorded'::text;
end;
$function$;

-- crm.begin_ad_apply, carried forward from 20261021100000 with ONE edit: committed budget counts against the monthly cap.
create or replace function crm.begin_ad_apply(p_organization_id uuid, p_version uuid, p_correlation_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, reason text, execution_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v crm.ad_campaign_versions; c crm.ad_campaigns; d record; g record;
begin
  select * into v from crm.ad_campaign_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text, null::uuid; return; end if;
  if v.state in ('LIVE', 'PAUSED') then return query select 'already_applied'::text, null::text, null::uuid; return; end if;
  if v.state not in ('ADMIN_REVIEW', 'LAUNCHING') then return query select 'not_approved_state'::text, v.state, null::uuid; return; end if;
  select * into c from crm.ad_campaigns x where x.id = v.campaign_id;
  -- A Google ad may only point at a landing page that is deployed AND verified, read NOW.
  if c.platform = 'google_ads' and not exists (
       select 1 from crm.landing_page_versions lv
        where lv.organization_id = p_organization_id and lv.id::text = (v.plan #>> '{destination,landing_page_version_id}') and lv.state = 'VERIFIED') then
    return query select 'blocked'::text, 'landing_page_not_verified'::text, null::uuid; return;
  end if;

  -- The connector, the cap and the stops are asked NOW, with the money this change adds. Approval is satisfied by the exact-version check
  -- below; only BLOCK refuses here.
  select * into d from crm.acquisition_decide(p_organization_id, crm._ad_action(v.change_kind), c.platform, v.change_amount_minor, 1, p_correlation_id);
  if d.decision = 'BLOCK' then return query select 'blocked'::text, d.reason, null::uuid; return; end if;

  -- Money already COMMITTED to other live campaigns on this platform counts against the monthly cap, not only money already spent.
  if v.change_kind in ('launch', 'budget_increase') and crm._ad_committed_over_cap(p_organization_id, v.id) then
    return query select 'blocked'::text, 'committed_budget_exceeds_cap'::text, null::uuid; return;
  end if;

  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'ad_campaign', v.id, v.content_hash,
                                                    crm._ad_action(v.change_kind), c.platform, p_correlation_id);
  if g.outcome = 'proceed' then
    if v.state = 'ADMIN_REVIEW' then perform crm._ad_set_state(v.id, 'LAUNCHING'); end if;
    return query select 'proceed'::text, g.reason, g.execution_id; return;
  end if;
  return query select g.outcome::text, g.reason, g.execution_id;
end;
$function$;

-- crm.ad_version_stamp, carried forward from 20261020100000 with ONE edit: a higher daily rate is a budget increase.
create or replace function crm.ad_version_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  c crm.ad_campaigns;
  p crm.ad_campaign_versions;
  v_new bigint;
  v_old bigint;
begin
  select * into c from crm.ad_campaigns x where x.id = new.campaign_id;
  new.content_hash := encode(sha256(convert_to(jsonb_build_object(
    'platform', c.platform, 'currency', c.currency, 'plan', new.plan, 'daily', new.budget_daily_minor, 'total', new.budget_total_minor,
    'start', new.start_date, 'end', new.end_date)::text, 'UTF8')), 'hex');

  -- What does this version change about a campaign that is already running?
  select * into p from crm.ad_campaign_versions v where v.campaign_id = new.campaign_id and v.state in ('LIVE', 'PAUSED') order by v.version desc limit 1;
  v_new := crm._ad_monthly_estimate(new.budget_daily_minor, new.budget_total_minor);
  if p.id is null then
    new.change_kind := 'launch';
    new.change_amount_minor := v_new;
  else
    v_old := crm._ad_monthly_estimate(p.budget_daily_minor, p.budget_total_minor);
    -- A higher DAILY rate is an increase even when a total cap keeps the 30-day estimate level.
    if v_new > v_old or new.budget_daily_minor > p.budget_daily_minor then new.change_kind := 'budget_increase'; new.change_amount_minor := greatest(v_new - v_old, (new.budget_daily_minor - p.budget_daily_minor) * 30);
    elsif crm._ad_targeting_signature(c.platform, new.plan) is distinct from crm._ad_targeting_signature(c.platform, p.plan) then new.change_kind := 'targeting_change'; new.change_amount_minor := 0;
    elsif crm._ad_creative_signature(c.platform, new.plan) is distinct from crm._ad_creative_signature(c.platform, p.plan) then new.change_kind := 'creative_change'; new.change_amount_minor := 0;
    elsif v_new < v_old then new.change_kind := 'budget_decrease'; new.change_amount_minor := 0;
    else new.change_kind := 'creative_change'; new.change_amount_minor := 0; end if;
  end if;
  return new;
end;
$function$;

-- crm._b2b_begin_submit, carried forward from 20261022100000 with TWO edits: a person's recorded submission is held to the policy, the plan and the in-flight limits (`_manual_gate`), and connects being sent count.
create or replace function crm._b2b_begin_submit(p_organization_id uuid, p_version uuid, p_via text, p_correlation_id uuid)
 RETURNS TABLE(outcome text, reason text, execution_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v crm.b2b_proposal_versions; o crm.b2b_opportunities; rule crm.b2b_platform_rules; s crm.b2b_settings; ch crm.acquisition_channels;
  g record; v_used bigint; v_today bigint; d record; v_gate text;
begin
  select * into v from crm.b2b_proposal_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text, null::uuid; return; end if;
  if v.state = 'SUBMITTED' then return query select 'already_submitted'::text, null::text, null::uuid; return; end if;
  if v.state not in ('ADMIN_REVIEW', 'SUBMITTING') then return query select 'not_approved_state'::text, v.state, null::uuid; return; end if;
  select * into o from crm.b2b_opportunities x where x.id = v.opportunity_id;
  select * into rule from crm.b2b_platform_rules x where x.organization_id = p_organization_id and x.platform = o.platform;
  select * into s from crm.b2b_settings x where x.organization_id = p_organization_id;
  if p_via = 'adapter' then
    if coalesce(rule.automation_mode, 'manual') <> 'automated' then return query select 'blocked'::text, 'platform_not_automated'::text, null::uuid; return; end if;
    select * into d from crm.acquisition_decide(p_organization_id, 'b2b_proposal_submit', 'b2b', coalesce(v.price_minor, 0), 1, p_correlation_id);
    if d.decision = 'BLOCK' then return query select 'blocked'::text, d.reason, null::uuid; return; end if;
  else
    -- A person acting on the platform needs no connector, but the stops, the policy, the plan, the limits and the budget still apply.
    v_gate := crm._manual_gate(p_organization_id, 'b2b', 'b2b_proposal_submit', 0);
    if v_gate is not null then return query select 'blocked'::text, v_gate, null::uuid; return; end if;
  end if;
  if s.monthly_connects_cap is not null and v.connects_cost > 0 then
    select coalesce(sum(u.amount), 0) into v_used from crm.acquisition_usage u where u.organization_id = p_organization_id and u.channel = 'b2b' and u.metric = 'connect' and u.occurred_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
    -- Connects of proposals being sent right now are not yet in the ledger.
    v_used := v_used + coalesce((select sum(p.connects_cost) from crm.b2b_proposal_versions p where p.organization_id = p_organization_id and p.state = 'SUBMITTING' and p.id <> v.id), 0);
    if v_used + v.connects_cost > s.monthly_connects_cap then return query select 'blocked'::text, 'monthly_connects_exceeded'::text, null::uuid; return; end if;
  end if;
  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'b2b_proposal', v.id, v.content_hash, 'b2b_proposal_submit', 'b2b', p_correlation_id);
  if g.outcome = 'proceed' then
    if v.state = 'ADMIN_REVIEW' then perform crm._b2b_set('proposal', v.id, 'SUBMITTING'); end if;
    return query select 'proceed'::text, g.reason, g.execution_id; return;
  end if;
  return query select g.outcome::text, g.reason, g.execution_id;
end;
$function$;

-- crm.record_manual_profile_update, carried forward from 20261022100000 with ONE edit: held to the policy, the plan and the daily limit.
create or replace function crm.record_manual_profile_update(p_organization_id uuid, p_version uuid, p_evidence_url text)
 RETURNS TABLE(outcome text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v crm.b2b_profile_versions; g record; f record; prev uuid; v_gate text;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::text; return; end if;
  if coalesce(p_evidence_url, '') !~ '^https://' then return query select 'needs_evidence'::text, null::text; return; end if;
  select * into v from crm.b2b_profile_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v.state = 'APPLIED' then return query select 'already_applied'::text, null::text; return; end if;
  if v.state <> 'ADMIN_REVIEW' then return query select 'not_approved_state'::text, v.state; return; end if;
  v_gate := crm._manual_gate(p_organization_id, 'b2b', 'profile_update', 0);
  if v_gate is not null then return query select 'blocked'::text, v_gate; return; end if;
  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'acquisition_action', v.id, v.content_hash, 'profile_update', 'b2b', null);
  if g.outcome <> 'proceed' then return query select g.outcome::text, g.reason; return; end if;
  select * into f from crm.finish_governed_execution(p_organization_id, g.execution_id, 'executed', p_evidence_url, jsonb_build_object('recorded_by', 'a person on the platform'));
  if f.outcome <> 'recorded' then return query select f.outcome::text, null::text; return; end if;
  for prev in select x.id from crm.b2b_profile_versions x where x.organization_id = p_organization_id and x.platform = v.platform and x.state = 'APPLIED' loop
    perform crm._b2b_set('profile', prev, 'SUPERSEDED');
  end loop;
  perform set_config('crm.b2b_write', '1', true);
  update crm.b2b_profile_versions set state = 'APPLIED', evidence_url = p_evidence_url where id = v.id;
  perform set_config('crm.b2b_write', '', true);
  perform crm.record_acquisition_usage(p_organization_id, 'b2b', 'action', 1, 'b2b-profile:' || v.id::text);
  perform core.record_audit(p_organization_id, 'b2b.profile_applied', 'b2b_profile', v.id, null, jsonb_build_object('platform', v.platform, 'version', v.version));
  return query select 'recorded'::text, null::text;
end;
$function$;

-- crm.add_b2b_proposal_version, carried forward from 20261022100000 with ONE edit: a price needs a SIGNED-IN person, not just the word 'human' (the service role - how agents run - could claim it).
create or replace function crm.add_b2b_proposal_version(p_organization_id uuid, p_opportunity uuid, p_body text, p_price_minor bigint, p_timeline_days integer, p_connects_cost integer, p_portfolio_item_ids uuid[], p_by_type text DEFAULT 'human'::text)
 RETURNS TABLE(outcome text, version_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o crm.b2b_opportunities; v_n integer; v_id uuid; r record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  if p_by_type not in ('human', 'agent', 'rule') or (p_price_minor is not null and (p_by_type <> 'human' or (select auth.uid()) is null)) then return query select 'invalid'::text, null::uuid; return; end if;
  select * into o from crm.b2b_opportunities x where x.id = p_opportunity and x.organization_id = p_organization_id for update;
  if o.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if o.status <> 'shortlisted' then return query select 'not_shortlisted'::text, null::uuid; return; end if;
  if exists (select 1 from crm.b2b_proposal_versions v where v.opportunity_id = o.id and v.state in ('SUBMITTING', 'SUBMITTED')) then return query select 'already_submitted'::text, null::uuid; return; end if;
  for r in select v.id, v.approval_request_id from crm.b2b_proposal_versions v where v.opportunity_id = o.id and v.state in ('DRAFT', 'CHECKED', 'CHECK_FAILED', 'ADMIN_REVIEW') loop
    if r.approval_request_id is not null then perform approvals.cancel_request(r.approval_request_id, 'a newer version of the proposal replaced it'); end if;
    perform crm._b2b_set('proposal', r.id, 'SUPERSEDED');
  end loop;
  select coalesce(max(v.version), 0) + 1 into v_n from crm.b2b_proposal_versions v where v.opportunity_id = o.id;
  insert into crm.b2b_proposal_versions (organization_id, opportunity_id, version, body, currency, price_minor, timeline_days, connects_cost, portfolio_item_ids, created_by_type, created_by)
  values (p_organization_id, o.id, v_n, p_body, o.currency, p_price_minor, p_timeline_days, coalesce(p_connects_cost, 0), coalesce(p_portfolio_item_ids, '{}'), p_by_type, (select auth.uid()))
  returning id into v_id;
  perform core.record_audit(p_organization_id, 'b2b.proposal_version_added', 'b2b_opportunity', o.id, null, jsonb_build_object('version', v_n));
  return query select 'added'::text, v_id;
exception when check_violation or not_null_violation then return query select 'invalid'::text, null::uuid;
end;
$function$;

-- crm.acquisition_funnel, carried forward from 20261023100000 with ONE edit: a session must be INTERNAL and sees only its own organisation; with no session it answers with nothing (an all-organisations aggregate would mix tenants).
create or replace function crm.acquisition_funnel(p_days integer DEFAULT 90)
 RETURNS TABLE(channel text, leads bigint, qualified bigint, meetings bigint, quotes bigint, won bigint, revenue jsonb, spend_minor bigint, cost_per_lead_minor bigint, cost_per_qualified_minor bigint, cost_per_won_minor bigint, last_touch_leads bigint, touched_leads bigint, won_last_touch bigint, insufficient_data boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org, coalesce((select core.is_internal()), false) as internal),
  win as (select now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 730))) as since),
  leads_w as (
    select l.id, l.organization_id, l.qualified_at
      from crm.leads l, caller k, win w
     where l.created_at >= w.since and l.merged_into_lead_id is null and (k.uid is not null and k.internal and l.organization_id = k.org)
  ),
  ft as (
    select distinct on (t.lead_id) t.lead_id, crm._acq_channel(t.channel) as ch
      from crm.lead_touchpoints t join leads_w lw on lw.id = t.lead_id order by t.lead_id, t.occurred_at, t.recorded_at, t.id
  ),
  lt as (
    select distinct on (t.lead_id) t.lead_id, crm._acq_channel(t.channel) as ch
      from crm.lead_touchpoints t join leads_w lw on lw.id = t.lead_id order by t.lead_id, t.occurred_at desc, t.recorded_at desc, t.id desc
  ),
  touched as (
    select distinct crm._acq_channel(t.channel) as ch, t.lead_id from crm.lead_touchpoints t join leads_w lw on lw.id = t.lead_id
  ),
  per_lead as (
    select lw.id, coalesce(ft.ch, 'other') as ch, coalesce(lt.ch, 'other') as lch, lw.qualified_at is not null as q,
           exists (select 1 from crm.meetings m where m.lead_id = lw.id and m.status = 'completed') as mtg,
           exists (select 1 from sales.proposals p join sales.opportunities op on op.id = p.opportunity_id where op.lead_id = lw.id and p.status in ('sent', 'accepted')) as quo,
           crm.lead_outcome(lw.id) = 'WON' as w,
           (select op.currency from sales.opportunities op where op.lead_id = lw.id and op.stage = 'won' order by op.created_at desc limit 1) as cur,
           (select op.value_minor from sales.opportunities op where op.lead_id = lw.id and op.stage = 'won' order by op.created_at desc limit 1) as val
      from leads_w lw left join ft on ft.lead_id = lw.id left join lt on lt.lead_id = lw.id
  ),
  rev as (
    select ch, jsonb_object_agg(cur, s) as revenue from (select ch, cur, sum(val)::bigint as s from per_lead where w and cur is not null and val is not null group by ch, cur) x group by ch
  ),
  spend as (
    select crm._acq_channel(u.channel) as ch, sum(u.amount)::bigint as s from crm.acquisition_usage u, caller k, win w
     where u.metric = 'spend_minor' and u.occurred_at >= w.since and (k.uid is not null and k.internal and u.organization_id = k.org) group by 1
  ),
  chans as (select unnest(array['meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other']) as ch)
  select c.ch,
         coalesce(count(p.id), 0)::bigint,
         coalesce(count(p.id) filter (where p.q), 0)::bigint,
         coalesce(count(p.id) filter (where p.mtg), 0)::bigint,
         coalesce(count(p.id) filter (where p.quo), 0)::bigint,
         coalesce(count(p.id) filter (where p.w), 0)::bigint,
         coalesce((select r.revenue from rev r where r.ch = c.ch), '{}'::jsonb),
         coalesce((select s.s from spend s where s.ch = c.ch), 0)::bigint,
         case when count(p.id) > 0 and coalesce((select s.s from spend s where s.ch = c.ch), 0) > 0 then ((select s.s from spend s where s.ch = c.ch) / count(p.id))::bigint end,
         case when count(p.id) filter (where p.q) > 0 and coalesce((select s.s from spend s where s.ch = c.ch), 0) > 0 then ((select s.s from spend s where s.ch = c.ch) / count(p.id) filter (where p.q))::bigint end,
         case when count(p.id) filter (where p.w) > 0 and coalesce((select s.s from spend s where s.ch = c.ch), 0) > 0 then ((select s.s from spend s where s.ch = c.ch) / count(p.id) filter (where p.w))::bigint end,
         (select count(*) from per_lead x where x.lch = c.ch)::bigint,
         (select count(*) from touched t where t.ch = c.ch)::bigint,
         (select count(*) from per_lead x where x.lch = c.ch and x.w)::bigint,
         coalesce(count(p.id), 0) < 10
    from chans c left join per_lead p on p.ch = c.ch
   group by c.ch
   order by array_position(array['meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other'], c.ch);
$function$;

-- crm.acquisition_recommendations, carried forward with the same edit.
create or replace function crm.acquisition_recommendations(p_days integer DEFAULT 90)
 RETURNS TABLE(channel text, recommendation text, basis jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org, coalesce((select core.is_internal()), false) as internal),
       f as (select * from crm.acquisition_funnel(p_days)),
       g as (select * from crm.acquisition_goal_progress()),
       -- the actions each channel took in the last 30 days, for THIS organisation only (a session sees its own; the engine sees all)
       act as (select crm._acq_channel(u.channel) as ch, coalesce(sum(u.amount), 0)::bigint as n from crm.acquisition_usage u, caller k
                where u.metric = 'action' and u.occurred_at >= now() - interval '30 days' and (k.uid is not null and k.internal and u.organization_id = k.org) group by 1),
       sib as (select channel, cost_per_qualified_minor from f where channel in ('meta_ads', 'google_ads') and not insufficient_data and cost_per_qualified_minor is not null)
  select r.channel, r.recommendation, r.basis from (
    select g.channel, 'behind_pace_for_the_monthly_goal' as recommendation,
           jsonb_build_object('target', g.qualified_target, 'qualified_so_far', g.qualified_this_month, 'pace_pct', g.pace_pct, 'days_elapsed', g.days_elapsed) as basis
      from g where g.enabled and not g.paused and g.on_pace is false and g.days_elapsed >= 10
    union all
    select g.channel, 'budget_nearly_used', jsonb_build_object('budget_used_pct', g.budget_used_pct, 'days_elapsed', g.days_elapsed, 'days_in_month', g.days_in_month)
      from g where g.budget_used_pct >= 90 and g.days_elapsed < g.days_in_month
    union all
    select s.channel, 'cost_per_qualified_far_above_its_sibling',
           jsonb_build_object('cost_per_qualified_minor', s.cost_per_qualified_minor, 'sibling_minor', (select min(o.cost_per_qualified_minor) from sib o where o.channel <> s.channel))
      from sib s where s.cost_per_qualified_minor > 2 * (select min(o.cost_per_qualified_minor) from sib o where o.channel <> s.channel)
    union all
    select f.channel, 'acting_without_producing_a_lead_check_tracking',
           jsonb_build_object('actions', (select a.n from act a where a.ch = f.channel), 'leads', f.leads)
      from f where f.channel <> 'other' and f.leads = 0 and coalesce((select a.n from act a where a.ch = f.channel), 0) >= 10
    union all
    select f.channel, 'too_early_to_judge', jsonb_build_object('leads', f.leads)
      from f where f.channel <> 'other' and f.leads between 1 and 9
  ) r;
$function$;

-- crm.acquisition_failures, carried forward with ONE edit: internal sessions only.
create or replace function crm.acquisition_failures(p_limit integer DEFAULT 100)
 RETURNS TABLE(kind text, severity text, channel text, ref_id uuid, summary text, since timestamp with time zone, advice text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org, coalesce((select core.is_internal()), false) as internal),
  rows_ as (
    -- executions that failed, stalled, or whose outcome is unknown
    select 'execution_' || e.status as kind,
           case when e.status = 'unknown' or (e.status = 'failed' and e.attempt >= 3) then 'critical' else 'warning' end as severity,
           e.channel as channel, e.id as ref_id,
           e.action_type || ' ' || e.status || ' (attempt ' || e.attempt || ')' as summary, coalesce(e.finished_at, e.started_at) as since,
           case e.status when 'unknown' then 'Check the platform before anything else: it may have gone through. It will not be run again.'
                         else 'A retry is allowed up to three attempts; after that it needs a person.' end as advice
      from crm.governed_executions e, caller k
     where e.status in ('failed', 'unknown') and (k.uid is null or (k.internal and e.organization_id = k.org))
    union all
    select 'execution_stalled', 'critical', e.channel, e.id, e.action_type || ' has been executing for over 10 minutes', e.started_at,
           'Its worker may have died. The next attempt will mark it unknown and ask for a check.'
      from crm.governed_executions e, caller k where e.status = 'executing' and e.started_at < now() - interval '10 minutes' and (k.uid is null or (k.internal and e.organization_id = k.org))
    union all
    -- approved and not applied
    select 'approved_not_applied', 'warning', 'meta_ads', v.id, 'An approved ad change has waited over a day to be applied', v.state_changed_at,
           'No connector applies it automatically yet: apply it by hand exactly as approved.'
      from crm.ad_campaign_versions v join approvals.approval_requests a on a.id = v.approval_request_id, caller k
     where v.state = 'ADMIN_REVIEW' and a.state = 'approved' and v.state_changed_at < now() - interval '1 day' and (k.uid is null or (k.internal and v.organization_id = k.org))
    union all
    select 'approved_not_applied', 'warning', 'google_ads', v.id, 'An approved landing page has waited over a day to be deployed', v.state_changed_at,
           'No deployer exists yet: upload exactly the approved page, then re-check it.'
      from crm.landing_page_versions v join approvals.approval_requests a on a.id = v.approval_request_id, caller k
     where v.state = 'ADMIN_REVIEW' and a.state = 'approved' and v.state_changed_at < now() - interval '1 day' and (k.uid is null or (k.internal and v.organization_id = k.org))
    union all
    select 'approved_not_applied', 'warning', 'b2b', v.id, 'An approved marketplace proposal has waited over a day to be sent', v.state_changed_at,
           'Send it on the platform exactly as approved, then record it.'
      from crm.b2b_proposal_versions v join approvals.approval_requests a on a.id = v.approval_request_id, caller k
     where v.state = 'ADMIN_REVIEW' and a.state = 'approved' and v.state_changed_at < now() - interval '1 day' and (k.uid is null or (k.internal and v.organization_id = k.org))
    union all
    -- pages
    select 'landing_not_verified', 'critical', 'google_ads', v.id, 'A deployed landing page does not match what was approved', v.state_changed_at,
           'Ads cannot launch to it. Check the public address, or redeploy exactly the approved page.'
      from crm.landing_page_versions v, caller k where v.state = 'VERIFY_FAILED' and (k.uid is null or (k.internal and v.organization_id = k.org))
    union all
    select 'landing_not_verified', 'warning', 'google_ads', v.id, 'A deployed landing page has not been verified for over an hour', v.state_changed_at,
           'It is not usable by an ad until the public address has been checked.'
      from crm.landing_page_versions v, caller k where v.state = 'DEPLOYED' and v.state_changed_at < now() - interval '1 hour' and (k.uid is null or (k.internal and v.organization_id = k.org))
    union all
    -- connections
    select 'connection_' || lower(i.status), case when i.status = 'REVOKED' then 'critical' else 'warning' end,
           case i.integration_type when 'ads' then i.provider when 'social' then 'social' when 'marketplace' then 'b2b' when 'directory' then 'b2b' when 'email' then 'email' end,
           i.id, i.provider || ' is ' || lower(i.status) || coalesce(' - ' || i.last_error, ''), coalesce(i.last_failure_at, i.updated_at),
           'Reconnect it under Connections. Work that needs it is refused until it is active.'
      from crm.acquisition_integrations i, caller k where i.status in ('DEGRADED', 'REVOKED') and (k.uid is null or (k.internal and i.organization_id = k.org))
    union all
    -- campaigns
    select 'campaign_' || h.kind, h.severity, c.platform, h.id, h.kind || ' on "' || c.name || '"', h.created_at, h.recommended_action
      from crm.campaign_health_records h join crm.ad_campaigns c on c.id = h.campaign_id, caller k
     where h.severity = 'critical' and h.assessed_on >= (now() at time zone 'utc')::date - 7 and (k.uid is null or (k.internal and h.organization_id = k.org))
    union all
    -- subtasks that failed
    select 'subtask_failed', 'warning', null, s.id, s.kind || ' task failed' || coalesce(': ' || left(s.failure_reason, 120), ''), s.updated_at,
           'It returned to the conversation owner. Re-request it if it is still needed.'
      from crm.subtask_requests s, caller k where s.status = 'FAILED' and s.updated_at >= now() - interval '14 days' and (k.uid is null or (k.internal and s.organization_id = k.org))
    union all
    -- alerts raised by the acquisition workers, not yet acknowledged
    select 'worker_alert', a.severity, case a.source when 'social_publishing' then 'social' when 'ad_operations' then 'meta_ads' when 'landing_pages' then 'google_ads' when 'b2b_operations' then 'b2b' end,
           a.id, a.summary, a.last_seen_at, 'Acknowledge it once it has been dealt with.'
      from core.alerts a, caller k where a.source in ('social_publishing', 'ad_operations', 'landing_pages', 'b2b_operations') and a.acknowledged_at is null and (k.uid is null or (k.internal and a.organization_id = k.org))
    union all
    -- stops in force
    select 'channel_paused', 'info', c.channel, null::uuid, c.channel || ' is paused' || coalesce(': ' || c.pause_reason, ''), c.paused_at, 'Nothing new goes out on it until it is resumed.'
      from crm.acquisition_channels c, caller k where c.paused and (k.uid is null or (k.internal and c.organization_id = k.org))
    union all
    select 'duplicate_reviews_open', 'info', null, null, count(*)::text || ' possible duplicate people are waiting for a decision', min(d.created_at), 'Open Identity and decide each: confirmed, kept separate or dismissed.'
      from crm.duplicate_reviews d, caller k where d.status = 'open' and (k.uid is null or (k.internal and d.organization_id = k.org)) having count(*) > 0
  )
  select r.kind, r.severity, r.channel, r.ref_id, r.summary, r.since, r.advice from rows_ r
   order by case r.severity when 'critical' then 0 when 'warning' then 1 else 2 end, r.since desc nulls last
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$function$;

-- crm.ad_outcomes, carried forward from 20261020100000 with ONE edit: internal sessions only.
create or replace function crm.ad_outcomes(p_campaign uuid DEFAULT NULL::uuid)
 RETURNS TABLE(campaign_id uuid, platform text, name text, spend_minor bigint, impressions bigint, clicks bigint, platform_leads bigint, leads bigint, qualified bigint, meetings bigint, quotes bigint, won bigint, revenue_minor bigint, cost_per_lead_minor bigint, cost_per_qualified_minor bigint, cost_per_meeting_minor bigint, cost_per_won_minor bigint, insufficient_data boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with caller as (
    select (select auth.uid()) as uid, (select core.current_organization_id()) as org, coalesce((select core.is_internal()), false) as internal
  ), camps as (
    select c.* from crm.ad_campaigns c, caller k
     where (p_campaign is null or c.id = p_campaign) and (k.uid is null or (k.internal and c.organization_id = k.org))
  ), spend as (
    select m.campaign_id,
           sum(m.spend_minor) as spend_minor, sum(m.impressions) as impressions, sum(m.clicks) as clicks, sum(m.platform_leads) as platform_leads
      from (select distinct on (x.campaign_id, x.metric_date) x.* from crm.ad_metrics x order by x.campaign_id, x.metric_date, x.reported_at desc, x.id desc) m
     group by m.campaign_id
  ), first_touch as (
    select distinct on (t.lead_id) t.lead_id, t.organization_id, t.channel, t.campaign, t.utm
      from crm.lead_touchpoints t order by t.lead_id, t.occurred_at, t.recorded_at, t.id
  ), attributed as (
    select distinct on (f.lead_id) f.lead_id, c.id as campaign_id
      from first_touch f
      join camps c on c.organization_id = f.organization_id and c.platform = f.channel
      join crm.ad_provider_objects o on o.campaign_id = c.id
       and o.provider_id in (f.campaign ->> 'ad_id', f.campaign ->> 'ad_set_id', f.campaign ->> 'campaign_id', f.utm ->> 'utm_campaign')
     order by f.lead_id, c.id
  ), per as (
    select a.campaign_id,
           count(*) as leads,
           count(*) filter (where l.qualified_at is not null) as qualified,
           count(*) filter (where exists (select 1 from crm.meetings m where m.lead_id = l.id and m.status = 'completed')) as meetings,
           count(*) filter (where exists (select 1 from sales.proposals p join sales.opportunities op on op.id = p.opportunity_id where op.lead_id = l.id and p.status in ('sent', 'accepted'))) as quotes,
           count(*) filter (where crm.lead_outcome(l.id) = 'WON') as won,
           coalesce(sum((select op.value_minor from sales.opportunities op where op.lead_id = l.id and op.stage = 'won' order by op.created_at desc limit 1)), 0)::bigint as revenue_minor
      from attributed a join crm.leads l on l.id = a.lead_id
     group by a.campaign_id
  )
  select c.id, c.platform, c.name, coalesce(s.spend_minor, 0)::bigint, coalesce(s.impressions, 0)::bigint, coalesce(s.clicks, 0)::bigint, coalesce(s.platform_leads, 0)::bigint,
         coalesce(p.leads, 0)::bigint, coalesce(p.qualified, 0)::bigint, coalesce(p.meetings, 0)::bigint, coalesce(p.quotes, 0)::bigint, coalesce(p.won, 0)::bigint, coalesce(p.revenue_minor, 0)::bigint,
         case when coalesce(p.leads, 0) > 0 then (coalesce(s.spend_minor, 0) / p.leads) end::bigint,
         case when coalesce(p.qualified, 0) > 0 then (coalesce(s.spend_minor, 0) / p.qualified) end::bigint,
         case when coalesce(p.meetings, 0) > 0 then (coalesce(s.spend_minor, 0) / p.meetings) end::bigint,
         case when coalesce(p.won, 0) > 0 then (coalesce(s.spend_minor, 0) / p.won) end::bigint,
         coalesce(p.leads, 0) < 10
    from camps c left join spend s on s.campaign_id = c.id left join per p on p.campaign_id = c.id
   order by c.created_at desc;
$function$;

-- crm.b2b_outcomes, carried forward from 20261022100000 with ONE edit: internal sessions only.
create or replace function crm.b2b_outcomes()
 RETURNS TABLE(platform text, found bigint, shortlisted bigint, submitted bigint, won bigint, lost bigint, revenue_minor bigint, connects_spent bigint, win_rate_pct integer, insufficient_data boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org, coalesce((select core.is_internal()), false) as internal)
  select o.platform,
         count(*)::bigint,
         count(*) filter (where o.status in ('shortlisted', 'submitted', 'won', 'lost'))::bigint,
         count(*) filter (where o.status in ('submitted', 'won', 'lost'))::bigint,
         count(*) filter (where o.status = 'won')::bigint,
         count(*) filter (where o.status = 'lost')::bigint,
         coalesce(sum(o.outcome_value_minor) filter (where o.status = 'won'), 0)::bigint,
         coalesce((select sum(p.connects_cost) from crm.b2b_proposal_versions p join crm.b2b_opportunities o2 on o2.id = p.opportunity_id
                    where o2.platform = o.platform and o2.organization_id = o.organization_id and p.state = 'SUBMITTED'), 0)::bigint,
         case when count(*) filter (where o.status in ('won', 'lost')) > 0
              then round(100.0 * count(*) filter (where o.status = 'won') / count(*) filter (where o.status in ('won', 'lost')))::integer end,
         count(*) filter (where o.status in ('won', 'lost')) < 10
    from crm.b2b_opportunities o, caller k
   where k.uid is null or o.organization_id = k.org
   group by o.platform, o.organization_id
   order by o.platform;
$function$;

-- crm.acquisition_goal_progress, rewritten from 20261023100000: strictly one internal session's own organisation (it joined an all-organisation aggregate to each organisation's row).
create or replace function crm.acquisition_goal_progress()
returns table (channel text, enabled boolean, paused boolean, qualified_target integer, qualified_this_month bigint, pace_pct integer, on_pace boolean,
               budget_minor bigint, spend_this_month_minor bigint, budget_used_pct integer, days_elapsed integer, days_in_month integer)
language sql stable security definer set search_path = '' as $$
  -- Only an INTERNAL session sees anything, and only its own organisation: with no session there is no organisation to answer for, and an
  -- all-organisations aggregate joined to each organisation's channel row would hand every tenant everyone's figure.
  with caller as (select (select auth.uid()) as uid, (select core.current_organization_id()) as org, coalesce((select core.is_internal()), false) as internal),
  m as (
    select date_trunc('month', now() at time zone 'utc') at time zone 'utc' as start,
           greatest(1, extract(day from (now() at time zone 'utc'))::integer) as elapsed,
           extract(day from (date_trunc('month', now() at time zone 'utc') + interval '1 month - 1 day'))::integer as total
  ),
  ft as (
    select distinct on (t.lead_id) t.lead_id, crm._acq_channel(t.channel) as ch
      from crm.lead_touchpoints t, caller k where k.uid is not null and k.internal and t.organization_id = k.org order by t.lead_id, t.occurred_at, t.recorded_at, t.id
  ),
  q as (
    select ft.ch, count(*)::bigint as n from crm.leads l join ft on ft.lead_id = l.id, m
     where l.qualified_at >= m.start and l.merged_into_lead_id is null group by ft.ch
  ),
  sp as (
    select crm._acq_channel(u.channel) as ch, sum(u.amount)::bigint as s from crm.acquisition_usage u, caller k, m
     where u.metric = 'spend_minor' and u.occurred_at >= m.start and k.uid is not null and k.internal and u.organization_id = k.org group by 1
  )
  select c.channel, c.enabled, c.paused, c.monthly_qualified_target, coalesce(q.n, 0)::bigint,
         case when c.monthly_qualified_target is not null and c.monthly_qualified_target > 0
              then round(100.0 * (coalesce(q.n, 0)::numeric * m.total / m.elapsed) / c.monthly_qualified_target)::integer end,
         case when c.monthly_qualified_target is not null and c.monthly_qualified_target > 0
              then (coalesce(q.n, 0)::numeric * m.total / m.elapsed) >= c.monthly_qualified_target * 0.8 end,
         c.monthly_budget_minor, coalesce(sp.s, 0)::bigint,
         case when c.monthly_budget_minor is not null and c.monthly_budget_minor > 0 then round(100.0 * coalesce(sp.s, 0) / c.monthly_budget_minor)::integer end,
         m.elapsed, m.total
    from crm.acquisition_channels c cross join m cross join caller k
    left join q on q.ch = c.channel left join sp on sp.ch = c.channel
   where k.uid is not null and k.internal and c.organization_id = k.org
   order by array_position(array['meta_ads', 'email', 'social', 'google_ads', 'b2b'], c.channel);
$$;

-- ═══ table-level fixes ═══════════════════════════════════════════════════════

-- The public link resolves a handoff by its hash alone, so a hash must belong to exactly one handoff in the whole database.
create unique index if not exists channel_handoffs_token_hash_global_key on crm.channel_handoffs (token_hash);

-- A landing page is served from a public address the worker will FETCH to verify it: never an IP literal, a port, or an internal name.
alter table crm.landing_page_versions drop constraint if exists landing_versions_public_url_host;
alter table crm.landing_page_versions add constraint landing_versions_public_url_host
  check (public_url !~ '^https://([0-9]{1,3}\.){3}[0-9]{1,3}([/]|$)'
         and public_url !~ '^https://(localhost|[^/]*\.(local|internal|localhost|lan|intranet|corp|home))([/]|$)');
comment on constraint landing_versions_public_url_host on crm.landing_page_versions is
  'The verifier fetches this address from the server. An IP literal or an internal host name would make that fetch a probe of the private network.';

-- A price is a person's: a signed-in person's id must be on the version (the word "human" alone is a parameter the caller supplies).
alter table crm.b2b_proposal_versions drop constraint if exists b2b_proposal_price_is_human;
alter table crm.b2b_proposal_versions add constraint b2b_proposal_price_is_human
  check (price_minor is null or (created_by_type = 'human' and created_by is not null));


-- ═══ 9. the by-hand path is a real path: every governed side effect a person can do on a platform can be RECORDED ═══
-- Until a connector exists, "apply it by hand, then record it" is the whole process for ads, social and landing pages. The B2B engine already had
-- these doors; the others told a person to record something there was nowhere to record. Each door below accepts the record ONLY for the exact
-- approved version, once, with the stops, the policy, the channel's plan, the daily limit and the spend cap re-read at that moment.

-- The questions a person's own act is held to. No connector is needed (the person IS the connector); everything else still applies.
create or replace function crm._manual_gate(p_organization_id uuid, p_channel text, p_action text, p_amount_minor bigint)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_block text; ch crm.acquisition_channels; v_today bigint; v_month bigint;
begin
  v_block := crm.acquisition_blocked(p_organization_id, p_channel);
  if v_block is not null then return v_block; end if;
  if exists (select 1 from crm.acquisition_policies p where p.organization_id = p_organization_id and p.action_type = p_action and p.mode = 'block') then return 'blocked_by_policy'; end if;
  select * into ch from crm.acquisition_channels c where c.organization_id = p_organization_id and c.channel = p_channel;
  if p_channel <> 'email' and not coalesce(ch.enabled, false) then return 'channel_not_enabled'; end if;
  if ch.daily_limit is not null then
    select coalesce(sum(u.amount), 0) into v_today from crm.acquisition_usage u
     where u.organization_id = p_organization_id and u.channel = p_channel and u.metric = 'action' and u.occurred_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
    v_today := v_today + (select count(*) from crm.governed_executions e where e.organization_id = p_organization_id and e.channel = p_channel and e.status in ('executing', 'unknown')
                           and e.started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc');
    if v_today + 1 > ch.daily_limit then return 'daily_limit'; end if;
  end if;
  if ch.monthly_budget_minor is not null and coalesce(p_amount_minor, 0) > 0 then
    select coalesce(sum(u.amount), 0) into v_month from crm.acquisition_usage u
     where u.organization_id = p_organization_id and u.channel = p_channel and u.metric = 'spend_minor' and u.occurred_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
    if v_month + p_amount_minor > ch.monthly_budget_minor then return 'monthly_budget_exceeded'; end if;
  end if;
  return null;
end;
$$;
revoke all on function crm._manual_gate(uuid, text, text, bigint) from public, anon, authenticated;

-- Spend that is already COMMITTED, not only spent: the monthly estimate of every other campaign that is live or being launched on the platform,
-- plus this version's own. A cap that counted only reported spend let two campaigns each fit under it and together go far over.
create or replace function crm._ad_committed_over_cap(p_organization_id uuid, p_version uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(ch.monthly_budget_minor is not null and
         ((select coalesce(sum(crm._ad_monthly_estimate(o.budget_daily_minor, o.budget_total_minor)), 0)
             from crm.ad_campaign_versions o join crm.ad_campaigns oc on oc.id = o.campaign_id
            where o.organization_id = p_organization_id and oc.platform = c.platform and o.campaign_id <> v.campaign_id and o.state in ('LIVE', 'LAUNCHING'))
          + crm._ad_monthly_estimate(v.budget_daily_minor, v.budget_total_minor)) > ch.monthly_budget_minor, false)
    from crm.ad_campaign_versions v
    join crm.ad_campaigns c on c.id = v.campaign_id
    left join crm.acquisition_channels ch on ch.organization_id = v.organization_id and ch.channel = c.platform
   where v.id = p_version and v.organization_id = p_organization_id;
$$;
revoke all on function crm._ad_committed_over_cap(uuid, uuid) from public, anon, authenticated;

create or replace function crm.record_manual_ad_apply(p_organization_id uuid, p_version uuid, p_provider_campaign_id text, p_objects jsonb default '[]')
returns table (outcome text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v crm.ad_campaign_versions; c crm.ad_campaigns; g record; f record; v_gate text;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::text; return; end if;
  if coalesce(btrim(p_provider_campaign_id), '') = '' then return query select 'needs_reference'::text, null::text; return; end if;
  select * into v from crm.ad_campaign_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v.state in ('LIVE', 'PAUSED') then return query select 'already_applied'::text, null::text; return; end if;
  if v.state <> 'ADMIN_REVIEW' then return query select 'not_approved_state'::text, v.state; return; end if;
  select * into c from crm.ad_campaigns x where x.id = v.campaign_id;
  if c.platform = 'google_ads' and not exists (
       select 1 from crm.landing_page_versions lv
        where lv.organization_id = p_organization_id and lv.id::text = (v.plan #>> '{destination,landing_page_version_id}') and lv.state = 'VERIFIED') then
    return query select 'blocked'::text, 'landing_page_not_verified'::text; return;
  end if;
  v_gate := crm._manual_gate(p_organization_id, c.platform, crm._ad_action(v.change_kind), v.change_amount_minor);
  if v_gate is not null then return query select 'blocked'::text, v_gate; return; end if;
  if v.change_kind in ('launch', 'budget_increase') and crm._ad_committed_over_cap(p_organization_id, v.id) then
    return query select 'blocked'::text, 'committed_budget_exceeds_cap'::text; return;
  end if;
  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'ad_campaign', v.id, v.content_hash, crm._ad_action(v.change_kind), c.platform, null);
  if g.outcome <> 'proceed' then return query select g.outcome::text, g.reason; return; end if;
  perform crm._ad_set_state(v.id, 'LAUNCHING');
  select * into f from crm.record_ad_apply(p_organization_id, v.id, g.execution_id, 'executed', p_provider_campaign_id, p_objects, jsonb_build_object('recorded_by', 'a person on the platform'));
  return query select f.outcome::text, null::text;
end;
$$;
revoke all on function crm.record_manual_ad_apply(uuid, uuid, text, jsonb) from public, anon;
grant execute on function crm.record_manual_ad_apply(uuid, uuid, text, jsonb) to authenticated;

-- A person paused, resumed or ended the campaign on the platform and says so (confirming the intent recorded here), or says the platform refused.
create or replace function crm.record_manual_ad_change(p_organization_id uuid, p_campaign uuid, p_confirmed boolean, p_detail text default null)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare f record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text; return; end if;
  select * into f from crm.confirm_ad_change(p_organization_id, p_campaign, p_confirmed, p_detail);
  return query select f.outcome::text;
end;
$$;
revoke all on function crm.record_manual_ad_change(uuid, uuid, boolean, text) from public, anon;
grant execute on function crm.record_manual_ad_change(uuid, uuid, boolean, text) to authenticated;

-- A person copies a day's figures off the platform. Only the increase over the previous report enters the spend ledger, exactly as for the engine.
create or replace function crm.record_manual_ad_metrics(p_organization_id uuid, p_campaign uuid, p_date date, p_spend_minor bigint, p_impressions bigint, p_clicks bigint, p_platform_leads bigint)
returns table (outcome text, counted_minor bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare f record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, 0::bigint; return; end if;
  if p_date is null or p_date > (now() at time zone 'utc')::date then return query select 'invalid'::text, 0::bigint; return; end if;
  select * into f from crm.record_ad_metrics(p_organization_id, p_campaign, p_date, p_spend_minor, p_impressions, p_clicks, p_platform_leads);
  return query select f.outcome::text, f.counted_minor;
end;
$$;
revoke all on function crm.record_manual_ad_metrics(uuid, uuid, date, bigint, bigint, bigint, bigint) from public, anon;
grant execute on function crm.record_manual_ad_metrics(uuid, uuid, date, bigint, bigint, bigint, bigint) to authenticated;

create or replace function crm.record_manual_publish(p_organization_id uuid, p_version uuid, p_external_ref text, p_url text default null)
returns table (outcome text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v crm.content_versions; i crm.content_items; g record; f record; v_gate text;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::text; return; end if;
  if coalesce(btrim(p_external_ref), '') = '' then return query select 'needs_reference'::text, null::text; return; end if;
  select * into v from crm.content_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v.state = 'PUBLISHED' then return query select 'already_published'::text, null::text; return; end if;
  if v.state <> 'SCHEDULED' then return query select 'not_scheduled'::text, v.state; return; end if;
  select * into i from crm.content_items x where x.id = v.item_id;
  v_gate := crm._manual_gate(p_organization_id, 'social', 'social_publish', 0);
  if v_gate is not null then return query select 'blocked'::text, v_gate; return; end if;
  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'social_content', v.id, v.content_hash, 'social_publish', 'social', null);
  if g.outcome <> 'proceed' then return query select g.outcome::text, g.reason; return; end if;
  perform set_config('crm.content_write', '1', true);
  update crm.content_versions set state = 'PUBLISHING' where id = v.id;
  perform set_config('crm.content_write', '', true);
  select * into f from crm.record_publish(p_organization_id, v.id, g.execution_id, 'executed', p_external_ref, p_url, jsonb_build_object('recorded_by', 'a person on the platform'));
  return query select f.outcome::text, null::text;
end;
$$;
revoke all on function crm.record_manual_publish(uuid, uuid, text, text) from public, anon;
grant execute on function crm.record_manual_publish(uuid, uuid, text, text) to authenticated;

-- A person uploaded exactly the approved page (the app renders it for them to download). The hash is of what the app rendered; whether the
-- public address really carries it is a separate, fetched verification - this door never makes a page VERIFIED.
create or replace function crm.record_manual_landing_deploy(p_organization_id uuid, p_version uuid, p_html_hash text)
returns table (outcome text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v crm.landing_page_versions; g record; f record; v_gate text;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::text; return; end if;
  if coalesce(p_html_hash, '') !~ '^[0-9a-f]{64}$' then return query select 'needs_evidence'::text, null::text; return; end if;
  select * into v from crm.landing_page_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v.state in ('DEPLOYED', 'VERIFIED', 'VERIFY_FAILED') then return query select 'already_deployed'::text, null::text; return; end if;
  if v.state <> 'ADMIN_REVIEW' then return query select 'not_approved_state'::text, v.state; return; end if;
  v_gate := crm._manual_gate(p_organization_id, 'google_ads', 'landing_page_deploy', 0);
  if v_gate is not null then return query select 'blocked'::text, v_gate; return; end if;
  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'acquisition_action', v.id, v.content_hash, 'landing_page_deploy', null, null);
  if g.outcome <> 'proceed' then return query select g.outcome::text, g.reason; return; end if;
  perform crm._landing_set_state(v.id, 'DEPLOYING');
  select * into f from crm.record_landing_deploy(p_organization_id, v.id, g.execution_id, 'executed', v.public_url, p_html_hash, jsonb_build_object('recorded_by', 'a person on the host'));
  return query select f.outcome::text, null::text;
end;
$$;
revoke all on function crm.record_manual_landing_deploy(uuid, uuid, text) from public, anon;
grant execute on function crm.record_manual_landing_deploy(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';
