-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation follow-up — deleting an organisation removes its history.
--
-- FOUND BY THE FIRST CI RUN: db:verify:tenancyguards could not delete its probe
-- organisation (HTTP 403). The history and immutability triggers added in slices
-- 1-10 refused EVERY delete, including the cascade from the organisation that
-- owns the row, so any organisation that had a lead (whose touchpoint is
-- append-only) became undeletable. The rule that matters is "nobody deletes
-- history WHILE its organisation exists": a trigger now refuses a delete only
-- when the owning organisation is still there (during the cascade it is already
-- gone). The `restrict` foreign keys between the new tables become `no action`
-- (checked at the end of the statement) so an organisation delete may remove a
-- parent and its children in either order.
-- The same applies to the lead: a touchpoint or owner transfer goes when ITS LEAD is deleted (the realtime e2e's cleanup deleted a lead and
-- could not, which left 33 leads behind and pushed the new one to page 2 of the leads list). Every function is carried forward from its
-- live definition with that one edit.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.touchpoints_are_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- A touch (or an owner transfer) is removed with the LEAD it belongs to, or with its organisation; never on its own.
  if tg_op = 'DELETE' and (not exists (select 1 from core.organizations o where o.id = old.organization_id)
                           or not exists (select 1 from crm.leads l where l.id = old.lead_id)) then return old; end if;
  raise exception 'a touchpoint is history; record a new one instead' using errcode = '42501';
end;
$function$;

create or replace function crm.history_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' and not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if;
  raise exception 'this record is history; add a new one instead' using errcode = '42501';
end;
$function$;

create or replace function crm.engine_history_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' and not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if;
  raise exception 'this record is history; add a new one instead' using errcode = '42501';
end;
$function$;

create or replace function crm.social_history_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' and not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if;
  raise exception 'this record is history; add a new one instead' using errcode = '42501';
end;
$function$;

create or replace function crm.icp_versions_are_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' and not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if;
  raise exception 'an ICP version is history; save the next version instead' using errcode = '42501';
end;
$function$;

create or replace function crm.ad_history_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' and not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if;
  raise exception 'this record is history; add a new one instead' using errcode = '42501';
end;
$function$;

create or replace function crm.social_strategy_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'a strategy is history; supersede it instead' using errcode = '42501'; end if;
  if (new.organization_id, new.platform, new.horizon_months, new.version, new.content, new.rationale, new.evidence_audit_id, new.created_by_type, new.created_at)
     is distinct from (old.organization_id, old.platform, old.horizon_months, old.version, old.content, old.rationale, old.evidence_audit_id, old.created_by_type, old.created_at) then
    raise exception 'a strategy''s content is frozen; make the next version' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not ((old.status = 'draft' and new.status = 'active') or (old.status = 'active' and new.status = 'superseded') or (old.status = 'draft' and new.status = 'superseded')) then
    raise exception 'a % strategy cannot become %', old.status, new.status using errcode = '23514';
  end if;
  return new;
end;
$function$;

create or replace function crm.content_item_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'a content item is history' using errcode = '42501'; end if;
  if (new.organization_id, new.platform, new.objective, new.format, new.title, new.created_at) is distinct from (old.organization_id, old.platform, old.objective, old.format, old.title, old.created_at) then
    raise exception 'what an item is for is fixed; make a new item' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function crm.content_version_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'a content version is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.item_id, new.version, new.body, new.cta, new.hashtags, new.asset_ids, new.reference_ids, new.content_hash,
      new.created_by_type, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.item_id, old.version, old.body, old.cta, old.hashtags, old.asset_ids, old.reference_ids, old.content_hash,
      old.created_by_type, old.created_by, old.created_at) then
    raise exception 'what a version says is frozen; make the next version' using errcode = '42501';
  end if;
  if new.state is distinct from old.state then
    if coalesce(current_setting('crm.content_write', true), '') <> '1' then
      raise exception 'a version''s state moves only through the content doors' using errcode = '42501';
    end if;
    if not (
         (old.state = 'DRAFT'            and new.state in ('AI_REVIEWED', 'AI_REVIEW_FAILED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'AI_REVIEW_FAILED' and new.state in ('SUPERSEDED', 'CANCELLED'))
      or (old.state = 'AI_REVIEWED'      and new.state in ('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'ADMIN_REVIEW'     and new.state in ('SCHEDULED', 'REJECTED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'SCHEDULED'        and new.state in ('PUBLISHING', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'PUBLISHING'       and new.state in ('PUBLISHED', 'SCHEDULED'))) then
      raise exception 'a % version cannot become %', old.state, new.state using errcode = '23514';
    end if;
    new.state_changed_at := now();
  end if;
  return new;
end;
$function$;

create or replace function crm.ad_campaign_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'a campaign is history' using errcode = '42501'; end if;
  if (new.organization_id, new.platform, new.name, new.created_at) is distinct from (old.organization_id, old.platform, old.name, old.created_at) then
    raise exception 'what a campaign is for is fixed; make a new campaign' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function crm.ad_version_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'an ad version is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.campaign_id, new.version, new.plan, new.budget_daily_minor, new.budget_total_minor, new.start_date, new.end_date,
      new.change_kind, new.change_amount_minor, new.content_hash, new.created_by_type, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.campaign_id, old.version, old.plan, old.budget_daily_minor, old.budget_total_minor, old.start_date, old.end_date,
      old.change_kind, old.change_amount_minor, old.content_hash, old.created_by_type, old.created_by, old.created_at) then
    raise exception 'what a version plans is frozen; make the next version' using errcode = '42501';
  end if;
  if new.state is distinct from old.state then
    if coalesce(current_setting('crm.ad_write', true), '') <> '1' then
      raise exception 'a version''s state moves only through the ad doors' using errcode = '42501';
    end if;
    if not (
         (old.state = 'DRAFT'        and new.state in ('CHECKED', 'CHECK_FAILED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECK_FAILED' and new.state in ('SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECKED'      and new.state in ('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'ADMIN_REVIEW' and new.state in ('LAUNCHING', 'REJECTED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'LAUNCHING'    and new.state in ('LIVE', 'ADMIN_REVIEW'))
      or (old.state = 'LIVE'         and new.state in ('PAUSED', 'ENDED', 'SUPERSEDED'))
      or (old.state = 'PAUSED'       and new.state in ('LIVE', 'ENDED', 'SUPERSEDED'))) then
      raise exception 'a % version cannot become %', old.state, new.state using errcode = '23514';
    end if;
    new.state_changed_at := now();
  end if;
  return new;
end;
$function$;

create or replace function crm.landing_version_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'a landing page version is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.page_id, new.version, new.content, new.whatsapp_number, new.public_url, new.tracking, new.content_hash, new.created_by_type, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.page_id, old.version, old.content, old.whatsapp_number, old.public_url, old.tracking, old.content_hash, old.created_by_type, old.created_by, old.created_at) then
    raise exception 'what a landing page version says is frozen; make the next version' using errcode = '42501';
  end if;
  if new.state is distinct from old.state then
    if coalesce(current_setting('crm.landing_write', true), '') <> '1' then
      raise exception 'a version''s state moves only through the landing doors' using errcode = '42501';
    end if;
    if not (
         (old.state = 'DRAFT'         and new.state in ('CHECKED', 'CHECK_FAILED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECK_FAILED'  and new.state in ('SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECKED'       and new.state in ('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'ADMIN_REVIEW'  and new.state in ('DEPLOYING', 'REJECTED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'DEPLOYING'     and new.state in ('DEPLOYED', 'ADMIN_REVIEW'))
      or (old.state = 'DEPLOYED'      and new.state in ('VERIFIED', 'VERIFY_FAILED', 'SUPERSEDED', 'RETIRED'))
      or (old.state = 'VERIFY_FAILED' and new.state in ('VERIFIED', 'SUPERSEDED', 'RETIRED'))
      or (old.state = 'VERIFIED'      and new.state in ('VERIFY_FAILED', 'SUPERSEDED', 'RETIRED'))) then
      raise exception 'a % version cannot become %', old.state, new.state using errcode = '23514';
    end if;
    new.state_changed_at := now();
  end if;
  return new;
end;
$function$;

create or replace function crm.landing_page_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'a landing page is history' using errcode = '42501'; end if;
  if (new.organization_id, new.slug, new.created_at) is distinct from (old.organization_id, old.slug, old.created_at) then
    raise exception 'a page''s address is fixed; make a new page' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function crm.b2b_proposal_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'a proposal version is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.opportunity_id, new.version, new.body, new.currency, new.price_minor, new.timeline_days, new.connects_cost, new.portfolio_item_ids, new.content_hash, new.created_by_type, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.opportunity_id, old.version, old.body, old.currency, old.price_minor, old.timeline_days, old.connects_cost, old.portfolio_item_ids, old.content_hash, old.created_by_type, old.created_by, old.created_at) then
    raise exception 'what a proposal says is frozen; make the next version' using errcode = '42501';
  end if;
  if new.state is distinct from old.state then
    if coalesce(current_setting('crm.b2b_write', true), '') <> '1' then
      raise exception 'a proposal''s state moves only through the B2B doors' using errcode = '42501';
    end if;
    if not (
         (old.state = 'DRAFT'        and new.state in ('CHECKED', 'CHECK_FAILED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECK_FAILED' and new.state in ('SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECKED'      and new.state in ('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'ADMIN_REVIEW' and new.state in ('SUBMITTING', 'REJECTED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'SUBMITTING'   and new.state in ('SUBMITTED', 'ADMIN_REVIEW'))) then
      raise exception 'a % proposal cannot become %', old.state, new.state using errcode = '23514';
    end if;
    new.state_changed_at := now();
  elsif (new.external_ref, new.submitted_via) is distinct from (old.external_ref, old.submitted_via)
        and coalesce(current_setting('crm.b2b_write', true), '') <> '1' then
    raise exception 'a submission is recorded only through the B2B doors' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function crm.b2b_profile_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'a profile version is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.platform, new.version, new.content, new.content_hash, new.created_by_type, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.platform, old.version, old.content, old.content_hash, old.created_by_type, old.created_by, old.created_at) then
    raise exception 'what a profile says is frozen; make the next version' using errcode = '42501';
  end if;
  if new.state is distinct from old.state then
    if coalesce(current_setting('crm.b2b_write', true), '') <> '1' then
      raise exception 'a profile version''s state moves only through the B2B doors' using errcode = '42501';
    end if;
    if not (
         (old.state = 'DRAFT'        and new.state in ('CHECKED', 'CHECK_FAILED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECK_FAILED' and new.state in ('SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECKED'      and new.state in ('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'ADMIN_REVIEW' and new.state in ('APPLIED', 'REJECTED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'APPLIED'      and new.state = 'SUPERSEDED')) then
      raise exception 'a % profile version cannot become %', old.state, new.state using errcode = '23514';
    end if;
    new.state_changed_at := now();
  elsif new.evidence_url is distinct from old.evidence_url and coalesce(current_setting('crm.b2b_write', true), '') <> '1' then
    raise exception 'evidence is recorded only through the B2B doors' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function crm.b2b_opportunity_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'an opportunity is history' using errcode = '42501'; end if;
  if (new.organization_id, new.platform, new.external_ref, new.url, new.title, new.description, new.budget_min_minor, new.budget_max_minor, new.currency, new.client_country, new.posted_at, new.source, new.created_at)
     is distinct from
     (old.organization_id, old.platform, old.external_ref, old.url, old.title, old.description, old.budget_min_minor, old.budget_max_minor, old.currency, old.client_country, old.posted_at, old.source, old.created_at) then
    raise exception 'what an opportunity said when it was found is frozen' using errcode = '42501';
  end if;
  if (new.status, new.fit_score, new.fit_reasons, new.skip_reason, new.lead_id, new.outcome_value_minor, new.outcome_note, new.closed_at)
     is distinct from
     (old.status, old.fit_score, old.fit_reasons, old.skip_reason, old.lead_id, old.outcome_value_minor, old.outcome_note, old.closed_at)
     and coalesce(current_setting('crm.b2b_write', true), '') <> '1' then
    raise exception 'an opportunity moves only through the B2B doors' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and old.status in ('won', 'lost') then
    raise exception 'an opportunity that was won or lost does not reopen' using errcode = '23514';
  end if;
  return new;
end;
$function$;

create or replace function crm.governed_execution_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'an execution is history' using errcode = '42501'; end if;
  if (new.approval_request_id, new.organization_id, new.artifact_type, new.artifact_id, new.content_hash, new.action_type, new.channel)
     is distinct from (old.approval_request_id, old.organization_id, old.artifact_type, old.artifact_id, old.content_hash, old.action_type, old.channel) then
    raise exception 'what was executed is fixed' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'executing' and new.status in ('executed', 'failed', 'unknown'))
    or (old.status = 'unknown'   and new.status in ('executed', 'failed'))
    or (old.status = 'failed'    and new.status = 'executing')
    or (old.status = 'executed'  and new.status = 'verified')) then
    raise exception 'an execution cannot go from % to %', old.status, new.status using errcode = '23514';
  end if;
  return new;
end;
$function$;

create or replace function crm.subtask_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'a subtask is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.lead_id, new.kind, new.requested_by_owner, new.objective, new.input, new.context_refs,
      new.requirement_version_id, new.idempotency_key, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.lead_id, old.kind, old.requested_by_owner, old.objective, old.input, old.context_refs,
      old.requirement_version_id, old.idempotency_key, old.created_by, old.created_at) then
    raise exception 'what a subtask asked for is fixed when it is asked' using errcode = '42501';
  end if;
  if old.status in ('COMPLETED', 'FAILED', 'CANCELLED') then
    raise exception 'a % subtask is closed', old.status using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'REQUESTED'   and new.status in ('IN_PROGRESS', 'FAILED', 'CANCELLED'))
    or (old.status = 'IN_PROGRESS' and new.status in ('COMPLETED', 'FAILED', 'CANCELLED'))) then
    raise exception 'a subtask cannot go from % to %', old.status, new.status using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

create or replace function crm.blocked_prospect_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if; raise exception 'a block is history; lift it instead' using errcode = '42501'; end if;
  if (new.organization_id, new.kind, new.value, new.reason, new.created_at) is distinct from (old.organization_id, old.kind, old.value, old.reason, old.created_at) then
    raise exception 'what was blocked, and why, is fixed' using errcode = '42501';
  end if;
  if old.lifted_at is not null then raise exception 'a lifted block stays lifted; block again instead' using errcode = '23514'; end if;
  return new;
end;
$function$;

create or replace function crm.channel_handoff_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if;
    raise exception 'a handoff is history; cancel it instead' using errcode = '42501';
  end if;
  if (new.id, new.organization_id, new.lead_id, new.contact_id, new.opportunity_id, new.source_channel, new.source_platform,
      new.source_agent, new.destination_channel, new.destination_agent, new.token_hash, new.context_version, new.context,
      new.expires_at, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.lead_id, old.contact_id, old.opportunity_id, old.source_channel, old.source_platform,
      old.source_agent, old.destination_channel, old.destination_agent, old.token_hash, old.context_version, old.context,
      old.expires_at, old.created_by, old.created_at) then
    raise exception 'a handoff''s identity, context and lifetime are frozen at creation' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'CREATED'  and new.status in ('OPENED', 'RESOLVED', 'EXPIRED', 'CANCELLED', 'INVALID'))
         or (old.status = 'OPENED'   and new.status in ('RESOLVED', 'EXPIRED', 'CANCELLED', 'INVALID'))
         or (old.status = 'RESOLVED' and new.status in ('CONSUMED', 'EXPIRED', 'CANCELLED', 'INVALID'))) then
      raise exception 'a % handoff cannot become %', old.status, new.status using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;

-- restrict -> no action (same columns, same targets)
alter table crm.channel_handoffs drop constraint channel_handoffs_lead_id_fkey;
alter table crm.channel_handoffs add constraint channel_handoffs_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES crm.leads(id);
alter table crm.approval_bindings drop constraint approval_bindings_approval_request_id_fkey;
alter table crm.approval_bindings add constraint approval_bindings_approval_request_id_fkey FOREIGN KEY (approval_request_id) REFERENCES approvals.approval_requests(id);
alter table crm.governed_executions drop constraint governed_executions_approval_request_id_fkey;
alter table crm.governed_executions add constraint governed_executions_approval_request_id_fkey FOREIGN KEY (approval_request_id) REFERENCES approvals.approval_requests(id);
alter table crm.subtask_requests drop constraint subtask_requests_lead_id_fkey;
alter table crm.subtask_requests add constraint subtask_requests_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES crm.leads(id);
alter table crm.subtask_requests drop constraint subtask_requests_requirement_version_id_fkey;
alter table crm.subtask_requests add constraint subtask_requests_requirement_version_id_fkey FOREIGN KEY (requirement_version_id) REFERENCES crm.requirement_versions(id);
alter table crm.ad_campaign_versions drop constraint ad_campaign_versions_campaign_id_fkey;
alter table crm.ad_campaign_versions add constraint ad_campaign_versions_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES crm.ad_campaigns(id);
alter table crm.content_versions drop constraint content_versions_item_id_fkey;
alter table crm.content_versions add constraint content_versions_item_id_fkey FOREIGN KEY (item_id) REFERENCES crm.content_items(id);
alter table crm.social_publications drop constraint social_publications_version_id_fkey;
alter table crm.social_publications add constraint social_publications_version_id_fkey FOREIGN KEY (version_id) REFERENCES crm.content_versions(id);
alter table crm.social_publications drop constraint social_publications_execution_id_fkey;
alter table crm.social_publications add constraint social_publications_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES crm.governed_executions(id);
alter table crm.ad_applications drop constraint ad_applications_version_id_fkey;
alter table crm.ad_applications add constraint ad_applications_version_id_fkey FOREIGN KEY (version_id) REFERENCES crm.ad_campaign_versions(id);
alter table crm.ad_applications drop constraint ad_applications_execution_id_fkey;
alter table crm.ad_applications add constraint ad_applications_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES crm.governed_executions(id);
alter table crm.landing_page_versions drop constraint landing_page_versions_page_id_fkey;
alter table crm.landing_page_versions add constraint landing_page_versions_page_id_fkey FOREIGN KEY (page_id) REFERENCES crm.landing_pages(id);
alter table crm.landing_deployments drop constraint landing_deployments_version_id_fkey;
alter table crm.landing_deployments add constraint landing_deployments_version_id_fkey FOREIGN KEY (version_id) REFERENCES crm.landing_page_versions(id);
alter table crm.landing_deployments drop constraint landing_deployments_execution_id_fkey;
alter table crm.landing_deployments add constraint landing_deployments_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES crm.governed_executions(id);
alter table crm.landing_verifications drop constraint landing_verifications_deployment_id_fkey;
alter table crm.landing_verifications add constraint landing_verifications_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES crm.landing_deployments(id);
alter table crm.b2b_proposal_versions drop constraint b2b_proposal_versions_opportunity_id_fkey;
alter table crm.b2b_proposal_versions add constraint b2b_proposal_versions_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES crm.b2b_opportunities(id);

notify pgrst, 'reload schema';
