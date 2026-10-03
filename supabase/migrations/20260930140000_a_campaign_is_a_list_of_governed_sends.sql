-- ═══════════════════════════════════════════════════════════════════════════
-- A campaign is a list of governed sends.
--
-- Decision: reversed by the owner on 2026-09-30 — broadcast reopened as a
-- governed campaign.
--
-- SCR-059's "WhatsApp broadcast" sub-feature was declined in bucket A
-- because a broadcast is the one thing this system exists not to be: many
-- people written to at once, on nobody's decision but the sender's. The
-- owner reopened it on 2026-09-30 with the rule that makes it governable
-- (docs/AGENCYOS_ADMIN_BUCKET_E_PLAN.md §E1):
--
--   A campaign is not a send. It is a PLAN that expands into one per-thread
--   outbound message per recipient, and each of those goes through the
--   existing chokepoint (`crm.send_outbound_message` → provider →
--   `crm.mark_outbound_delivery`), so consent, the 24-hour window, the
--   approved-template rule and the outreach allowance decide each recipient
--   separately. A recipient the rules refuse is recorded as refused with the
--   reason; the campaign never bypasses them.
--
-- What this file adds:
--
--   1. `crm.campaigns` — the plan: a name, an approved template, the
--      audience filter as the person typed it, and a status that only the
--      doors below move: draft → approved → running → done, or → cancelled.
--   2. `crm.campaign_recipients` — the expansion, one row per lead, written
--      AT APPROVAL (not at creation) so the count the approver read is the
--      count that goes. Each row ends sent, refused (with the reason) or
--      failed; none is ever deleted.
--   3. Five doors. `create_campaign` and `cancel_campaign` for people;
--      `approve_campaign` is four-eyes — the approver may not be the
--      creator, and must be owner or ops_admin; `claim_campaign_recipient`
--      and `record_campaign_recipient` are the worker's, service_role only,
--      and the claim is `for update skip locked` so two ticks never send to
--      the same person.
--   4. `campaign` joins the template situations, so an Admin can register
--      the template a campaign carries under Settings › Communication.
--
-- Audit actions: campaign.created | approved | started | cancelled | done |
-- recipient.sent | recipient.refused (a failed delivery is audited under
-- recipient.refused with after.status = 'failed': it did not reach anybody).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the plan ───────────────────────────────────────────────────────────

create table if not exists crm.campaigns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  name             text not null check (length(btrim(name)) between 1 and 120),
  -- Which approved template carries it. A campaign is never free text.
  template_id      uuid not null references crm.whatsapp_templates(id) on delete restrict,
  -- The audience filter exactly as typed (the Leads list's filter shape), so
  -- the preview and the expansion at approval read the same thing.
  audience         jsonb not null default '{}'::jsonb,

  status           text not null default 'draft'
                   check (status in ('draft', 'approved', 'running', 'done', 'cancelled')),

  created_by       uuid references core.users(id) on delete set null,
  approved_by      uuid references core.users(id) on delete set null,
  approved_at      timestamptz,
  started_at       timestamptz,
  finished_at      timestamptz,
  cancelled_reason text check (cancelled_reason is null or length(btrim(cancelled_reason)) between 1 and 600),

  -- Counters, kept by record_campaign_recipient so the list page needs no join.
  recipients_count int not null default 0 check (recipients_count >= 0),
  sent_count       int not null default 0 check (sent_count >= 0),
  refused_count    int not null default 0 check (refused_count >= 0),
  failed_count     int not null default 0 check (failed_count >= 0),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Four eyes, held at the row as well as in the door.
  constraint campaigns_approver_is_not_creator check (
    approved_by is null or created_by is null or approved_by <> created_by
  ),
  constraint campaigns_cancelled_says_why check (
    status <> 'cancelled' or cancelled_reason is not null
  )
);

create index if not exists campaigns_org_status_idx
  on crm.campaigns (organization_id, status, created_at desc);

comment on table crm.campaigns is
  'SCR-059 (owner decision 2026-09-30): a WhatsApp campaign — an approved template plus an audience filter, expanded into crm.campaign_recipients at approval and sent one governed message per recipient by the cron tick. Approval is four-eyes (approver ≠ creator, owner or ops_admin).';

drop trigger if exists set_updated_at on crm.campaigns;
create trigger set_updated_at before update on crm.campaigns
  for each row execute function core.set_updated_at();

alter table crm.campaigns enable row level security;
alter table crm.campaigns force row level security;

drop policy if exists campaigns_select on crm.campaigns;
create policy campaigns_select on crm.campaigns
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- Owner and ops_admin: the two roles that hold lead.write in
-- src/lib/authz/permissions.ts. The status is moved only by the doors below,
-- and approval is decided there (four eyes cannot be a column policy).
drop policy if exists campaigns_write on crm.campaigns;
create policy campaigns_write on crm.campaigns
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

drop trigger if exists org_match_campaigns_template on crm.campaigns;
create trigger org_match_campaigns_template
  before insert or update of template_id, organization_id on crm.campaigns
  for each row execute function core.enforce_parent_org('template_id', 'crm.whatsapp_templates');

drop trigger if exists freeze_org_campaigns on crm.campaigns;
create trigger freeze_org_campaigns
  before update of organization_id on crm.campaigns
  for each row execute function core.freeze_organization_id();

-- No delete: a campaign that ran is a record of who was written to.
grant select, insert, update on crm.campaigns to authenticated, service_role;

-- ── 2. the expansion ──────────────────────────────────────────────────────

create table if not exists crm.campaign_recipients (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  campaign_id       uuid not null references crm.campaigns(id) on delete cascade,

  lead_id           uuid references crm.leads(id) on delete cascade,
  client_account_id uuid references core.client_accounts(id) on delete cascade,
  -- The lead's own thread, when one exists. Null is a recipient the worker
  -- refuses with 'no_conversation' — recorded, never silently dropped.
  conversation_id   uuid references crm.conversations(id) on delete set null,

  status            text not null default 'pending'
                    check (status in ('pending', 'sent', 'refused', 'failed')),
  -- One of the closed set in src/modules/crm/campaign-types.ts, or the
  -- provider's own words after a failed delivery.
  reason            text check (reason is null or length(btrim(reason)) between 1 and 600),
  message_id        uuid references crm.conversation_messages(id) on delete set null,
  -- Set by the claim; a claim older than ten minutes with no decision is a
  -- worker that died, and the row is claimable again.
  claimed_at        timestamptz,
  decided_at        timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint campaign_recipients_names_somebody check (
    lead_id is not null or client_account_id is not null
  ),
  constraint campaign_recipients_decided_says_how check (
    status = 'pending' or decided_at is not null
  ),
  constraint campaign_recipients_refused_says_why check (
    status not in ('refused', 'failed') or reason is not null
  ),
  constraint campaign_recipients_one_per_lead unique (campaign_id, lead_id)
);

create index if not exists campaign_recipients_pending_idx
  on crm.campaign_recipients (organization_id, campaign_id, status, created_at);

comment on table crm.campaign_recipients is
  'SCR-059 (owner decision 2026-09-30): one row per person a campaign expands to, written at approval. Each ends sent (message_id names the governed outbound message), refused (reason from the closed set: no consent, no phone, the outreach limits, a missing template fact) or failed (the provider''s words). Never deleted.';

drop trigger if exists set_updated_at on crm.campaign_recipients;
create trigger set_updated_at before update on crm.campaign_recipients
  for each row execute function core.set_updated_at();

alter table crm.campaign_recipients enable row level security;
alter table crm.campaign_recipients force row level security;

drop policy if exists campaign_recipients_select on crm.campaign_recipients;
create policy campaign_recipients_select on crm.campaign_recipients
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- Written by approve_campaign (a person, owner/ops_admin) and by the worker
-- (service_role, which RLS does not bind). Same pair as campaigns_write.
drop policy if exists campaign_recipients_write on crm.campaign_recipients;
create policy campaign_recipients_write on crm.campaign_recipients
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

drop trigger if exists org_match_campaign_recipients_campaign on crm.campaign_recipients;
create trigger org_match_campaign_recipients_campaign
  before insert or update of campaign_id, organization_id on crm.campaign_recipients
  for each row execute function core.enforce_parent_org('campaign_id', 'crm.campaigns');

drop trigger if exists org_match_campaign_recipients_lead on crm.campaign_recipients;
create trigger org_match_campaign_recipients_lead
  before insert or update of lead_id, organization_id on crm.campaign_recipients
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');

drop trigger if exists org_match_campaign_recipients_client_account on crm.campaign_recipients;
create trigger org_match_campaign_recipients_client_account
  before insert or update of client_account_id, organization_id on crm.campaign_recipients
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_campaign_recipients_conversation on crm.campaign_recipients;
create trigger org_match_campaign_recipients_conversation
  before insert or update of conversation_id, organization_id on crm.campaign_recipients
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists org_match_campaign_recipients_message on crm.campaign_recipients;
create trigger org_match_campaign_recipients_message
  before insert or update of message_id, organization_id on crm.campaign_recipients
  for each row execute function core.enforce_parent_org('message_id', 'crm.conversation_messages');

drop trigger if exists freeze_org_campaign_recipients on crm.campaign_recipients;
create trigger freeze_org_campaign_recipients
  before update of organization_id on crm.campaign_recipients
  for each row execute function core.freeze_organization_id();

grant select, insert, update on crm.campaign_recipients to authenticated, service_role;

-- ── 3a. create ────────────────────────────────────────────────────────────

drop function if exists crm.create_campaign(text, uuid, jsonb);

create or replace function crm.create_campaign(
  p_name        text,
  p_template_id uuid,
  p_audience    jsonb
)
returns table (outcome text, campaign_id uuid)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid := (select core.current_organization_id());
  v_template crm.whatsapp_templates;
  v_id       uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select * into v_template from crm.whatsapp_templates
   where id = p_template_id and organization_id = v_org;
  if v_template.id is null then
    return query select 'template_not_found'::text, null::uuid; return;
  end if;
  -- Only a template Meta approved and an Admin left active. Checked again
  -- at approval, because Meta may have paused it in between.
  if v_template.status <> 'approved' or not v_template.active then
    return query select 'template_not_approved'::text, null::uuid; return;
  end if;

  insert into crm.campaigns (organization_id, name, template_id, audience, created_by)
  values (v_org, btrim(p_name), v_template.id, coalesce(p_audience, '{}'::jsonb), v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'campaign.created', 'campaign', v_id, null,
    jsonb_build_object('name', btrim(p_name), 'template_id', v_template.id,
                       'template_name', v_template.template_name, 'audience', coalesce(p_audience, '{}'::jsonb))
  );

  return query select 'created'::text, v_id;
end;
$$;

comment on function crm.create_campaign(text, uuid, jsonb) is
  'SCR-059 (owner decision 2026-09-30): saves a campaign draft — name, approved template, audience filter as typed. Owner/ops_admin (SECURITY INVOKER, campaigns_write decides again). Nothing is expanded or sent here. Audits campaign.created.';

revoke all on function crm.create_campaign(text, uuid, jsonb) from public, anon;
grant execute on function crm.create_campaign(text, uuid, jsonb) to authenticated, service_role;

-- ── 3b. approve — four eyes ───────────────────────────────────────────────

drop function if exists crm.approve_campaign(uuid, jsonb);

create or replace function crm.approve_campaign(
  p_campaign_id uuid,
  -- [{"lead_id": uuid, "conversation_id": uuid|null}, …] — the audience as
  -- the caller expanded it from the filter, at this moment.
  p_recipients  jsonb
)
returns table (outcome text, recipients int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid := (select core.current_organization_id());
  v_campaign crm.campaigns;
  v_template crm.whatsapp_templates;
  v_count    int;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, 0; return;
  end if;
  -- Owner or ops_admin, and never the person who wrote the plan: a campaign
  -- to many people is approved by a second pair of eyes or not at all.
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, 0; return;
  end if;

  select * into v_campaign from crm.campaigns
   where id = p_campaign_id and organization_id = v_org
   for update;
  if v_campaign.id is null then
    return query select 'not_found'::text, 0; return;
  end if;
  if v_campaign.status <> 'draft' then
    return query select 'not_draft'::text, 0; return;
  end if;
  if v_campaign.created_by = v_actor then
    return query select 'same_person'::text, 0; return;
  end if;

  select * into v_template from crm.whatsapp_templates where id = v_campaign.template_id;
  if v_template.id is null or v_template.status <> 'approved' or not v_template.active then
    return query select 'template_not_approved'::text, 0; return;
  end if;

  if p_recipients is null or jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) = 0 then
    return query select 'no_recipients'::text, 0; return;
  end if;

  -- One row per lead, in the organization, alive. A lead named twice, or a
  -- lead from elsewhere, is dropped here rather than trusted.
  insert into crm.campaign_recipients (organization_id, campaign_id, lead_id, conversation_id)
  select v_org, v_campaign.id, l.id, c.id
    from jsonb_to_recordset(p_recipients) as r(lead_id uuid, conversation_id uuid)
    join crm.leads l on l.id = r.lead_id and l.organization_id = v_org and l.deleted_at is null
    left join crm.conversations c
      on c.id = r.conversation_id and c.organization_id = v_org and c.lead_id = l.id
  on conflict (campaign_id, lead_id) do nothing;
  get diagnostics v_count = row_count;

  if v_count = 0 then
    return query select 'no_recipients'::text, 0; return;
  end if;

  update crm.campaigns
     set status = 'approved', approved_by = v_actor, approved_at = now(), recipients_count = v_count
   where id = v_campaign.id;

  perform core.record_audit(
    v_org, 'campaign.approved', 'campaign', v_campaign.id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'approved', 'recipients', v_count, 'template_id', v_template.id,
                       'created_by', v_campaign.created_by, 'approved_by', v_actor)
  );

  return query select 'approved'::text, v_count;
end;
$$;

comment on function crm.approve_campaign(uuid, jsonb) is
  'SCR-059 (owner decision 2026-09-30): four-eyes approval — the approver must be owner or ops_admin and must not be the creator. Expands the audience into campaign_recipients from the list the caller resolved at this moment (one row per lead, duplicates and strangers dropped), then draft → approved. Audits campaign.approved. Nothing is sent here; the cron tick sends.';

revoke all on function crm.approve_campaign(uuid, jsonb) from public, anon;
grant execute on function crm.approve_campaign(uuid, jsonb) to authenticated, service_role;

-- ── 3c. claim — the worker's, one row, skip locked ────────────────────────

drop function if exists crm.claim_campaign_recipient();

create or replace function crm.claim_campaign_recipient()
returns table (
  recipient_id    uuid,
  campaign_id     uuid,
  organization_id uuid,
  lead_id         uuid,
  conversation_id uuid,
  template_id     uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_recipient crm.campaign_recipients;
  v_campaign  crm.campaigns;
begin
  -- Oldest approval first, then oldest row; a row another tick holds is
  -- skipped rather than waited on, and a claim nobody decided within ten
  -- minutes is a dead worker's and is claimable again.
  select r.* into v_recipient
    from crm.campaign_recipients r
    join crm.campaigns c on c.id = r.campaign_id
   where r.status = 'pending'
     and c.status in ('approved', 'running')
     and (r.claimed_at is null or r.claimed_at < now() - interval '10 minutes')
   order by c.approved_at asc nulls last, r.created_at asc
   limit 1
   for update of r skip locked;

  if v_recipient.id is null then
    return;
  end if;

  update crm.campaign_recipients set claimed_at = now() where id = v_recipient.id;

  select * into v_campaign from crm.campaigns where id = v_recipient.campaign_id for update;
  if v_campaign.status = 'approved' then
    update crm.campaigns set status = 'running', started_at = now() where id = v_campaign.id;
    perform core.record_audit(
      v_campaign.organization_id, 'campaign.started', 'campaign', v_campaign.id,
      jsonb_build_object('status', 'approved'),
      jsonb_build_object('status', 'running', 'recipients', v_campaign.recipients_count)
    );
  end if;

  return query select v_recipient.id, v_campaign.id, v_campaign.organization_id,
                      v_recipient.lead_id, v_recipient.conversation_id, v_campaign.template_id;
end;
$$;

comment on function crm.claim_campaign_recipient() is
  'SCR-059 (owner decision 2026-09-30): the cron worker''s claim — one pending recipient of an approved or running campaign, FOR UPDATE SKIP LOCKED, stamped claimed_at so a dead worker''s claim expires. The first claim moves the campaign approved → running and audits campaign.started. service_role only.';

revoke all on function crm.claim_campaign_recipient() from public, anon, authenticated;
grant execute on function crm.claim_campaign_recipient() to service_role;

-- ── 3d. record — the worker's, the outcome and its reason ─────────────────

drop function if exists crm.record_campaign_recipient(uuid, text, text, uuid);

create or replace function crm.record_campaign_recipient(
  p_recipient_id uuid,
  p_status       text,
  p_reason       text default null,
  p_message_id   uuid default null
)
returns table (outcome text, campaign_status text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_recipient crm.campaign_recipients;
  v_campaign  crm.campaigns;
  v_pending   int;
begin
  if p_status not in ('sent', 'refused', 'failed') then
    return query select 'bad_status'::text, null::text; return;
  end if;
  if p_status in ('refused', 'failed') and nullif(btrim(coalesce(p_reason, '')), '') is null then
    return query select 'no_reason'::text, null::text; return;
  end if;

  select * into v_recipient from crm.campaign_recipients where id = p_recipient_id for update;
  if v_recipient.id is null then
    return query select 'not_found'::text, null::text; return;
  end if;
  if v_recipient.status <> 'pending' then
    -- Decided already: a retry after a crash between the send and this
    -- record must not count the same person twice.
    return query select 'already_recorded'::text, null::text; return;
  end if;

  update crm.campaign_recipients
     set status = p_status,
         reason = nullif(btrim(coalesce(p_reason, '')), ''),
         message_id = p_message_id,
         decided_at = now()
   where id = v_recipient.id;

  select * into v_campaign from crm.campaigns where id = v_recipient.campaign_id for update;

  update crm.campaigns
     set sent_count    = sent_count    + case when p_status = 'sent'    then 1 else 0 end,
         refused_count = refused_count + case when p_status = 'refused' then 1 else 0 end,
         failed_count  = failed_count  + case when p_status = 'failed'  then 1 else 0 end
   where id = v_campaign.id;

  perform core.record_audit(
    v_campaign.organization_id,
    case when p_status = 'sent' then 'campaign.recipient.sent' else 'campaign.recipient.refused' end,
    'campaign_recipient', v_recipient.id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', p_status, 'reason', nullif(btrim(coalesce(p_reason, '')), ''),
                       'campaign_id', v_campaign.id, 'lead_id', v_recipient.lead_id,
                       'conversation_id', v_recipient.conversation_id, 'message_id', p_message_id)
  );

  select count(*)::int into v_pending
    from crm.campaign_recipients
   where campaign_id = v_campaign.id and status = 'pending';

  if v_pending = 0 and v_campaign.status in ('approved', 'running') then
    update crm.campaigns set status = 'done', finished_at = now() where id = v_campaign.id;
    perform core.record_audit(
      v_campaign.organization_id, 'campaign.done', 'campaign', v_campaign.id,
      jsonb_build_object('status', v_campaign.status),
      (select jsonb_build_object('status', 'done', 'sent', c.sent_count, 'refused', c.refused_count,
                                 'failed', c.failed_count, 'recipients', c.recipients_count)
         from crm.campaigns c where c.id = v_campaign.id)
    );
    return query select 'recorded'::text, 'done'::text; return;
  end if;

  return query select 'recorded'::text, v_campaign.status;
end;
$$;

comment on function crm.record_campaign_recipient(uuid, text, text, uuid) is
  'SCR-059 (owner decision 2026-09-30): the worker records one recipient''s outcome — sent (message_id names the governed message), refused or failed (reason required). Idempotent: a decided row answers already_recorded. Bumps the campaign''s counters, audits campaign.recipient.sent / .refused, and moves the campaign to done (audits campaign.done) when nothing is pending. service_role only.';

revoke all on function crm.record_campaign_recipient(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function crm.record_campaign_recipient(uuid, text, text, uuid) to service_role;

-- ── 3e. cancel — creator or owner, with a reason ──────────────────────────

drop function if exists crm.cancel_campaign(uuid, text);

create or replace function crm.cancel_campaign(
  p_campaign_id uuid,
  p_reason      text
)
returns table (outcome text, withdrawn int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid := (select core.current_organization_id());
  v_campaign crm.campaigns;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_count    int;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, 0; return;
  end if;
  if v_reason is null then
    return query select 'no_reason'::text, 0; return;
  end if;

  select * into v_campaign from crm.campaigns
   where id = p_campaign_id and organization_id = v_org
   for update;
  if v_campaign.id is null then
    return query select 'not_found'::text, 0; return;
  end if;
  -- The person who planned it, or the owner. An ops_admin who did not write
  -- it may approve it but not withdraw it.
  if v_campaign.created_by is distinct from v_actor and not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text, 0; return;
  end if;
  if v_campaign.status in ('done', 'cancelled') then
    return query select 'finished'::text, 0; return;
  end if;

  -- What has not gone will not go. What went, went — a sent row stays sent.
  update crm.campaign_recipients
     set status = 'refused', reason = 'cancelled', decided_at = now()
   where campaign_id = v_campaign.id and status = 'pending';
  get diagnostics v_count = row_count;

  update crm.campaigns
     set status = 'cancelled', cancelled_reason = v_reason, finished_at = now(),
         refused_count = refused_count + v_count
   where id = v_campaign.id;

  perform core.record_audit(
    v_org, 'campaign.cancelled', 'campaign', v_campaign.id,
    jsonb_build_object('status', v_campaign.status),
    jsonb_build_object('status', 'cancelled', 'reason', v_reason, 'withdrawn', v_count,
                       'sent', v_campaign.sent_count)
  );

  return query select 'cancelled'::text, v_count;
end;
$$;

comment on function crm.cancel_campaign(uuid, text) is
  'SCR-059 (owner decision 2026-09-30): the creator or the owner withdraws a campaign with a reason. Every pending recipient is recorded refused (''cancelled''); sent rows stay sent. A done or cancelled campaign is not cancelled again. Audits campaign.cancelled.';

revoke all on function crm.cancel_campaign(uuid, text) from public, anon;
grant execute on function crm.cancel_campaign(uuid, text) to authenticated, service_role;

-- ── 4. a campaign is a template situation ─────────────────────────────────
--
-- Carried forward from 20260930100000 with one addition; the list is restated
-- rather than appended to because a CHECK cannot be appended to.

alter table crm.whatsapp_templates
  drop constraint if exists whatsapp_templates_situation_key_check;

alter table crm.whatsapp_templates
  add constraint whatsapp_templates_situation_key_check check (situation_key in (
    'no_response_after_quotation',
    'no_response_after_requirements',
    'no_response_after_proposal',
    'abandoned_conversation',
    'pending_approval',
    'inactive_lead',
    'post_project',
    'internal_approval',
    'quotation_approved',
    'internal_notice',
    'agent_message',
    'missed_meeting',
    'invoice_reminder',
    -- Owner decision 2026-09-30: the template a campaign carries. Registered
    -- by a person, approved at Meta; the campaign picker lists only approved
    -- and active rows, whatever their situation.
    'campaign'
  ));
