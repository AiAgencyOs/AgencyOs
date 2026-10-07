-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7, round two. Everything here is deterministic and needs no credential, no funded model, no deployment host and no provider account.
--
--   P7-ARC-01  a rendered completion certificate: a self-contained, print-ready HTML document built from the immutable completion record and the rows it
--              names, stored once with its SHA-256. It is NOT signed and says so. (A PDF is made from this HTML by the browser or a renderer; no PDF engine is
--              claimed here.)
--   P7-FIN-05/06 a downloadable receipt document per finance.receipts row, built from the receipt, the verified payment and the invoice, stored once with its
--              SHA-256. The client reads only its own, only for a verified payment on an issued invoice.
--   P7-PM-07   reminders for a client action request: due-soon and overdue, one per request per kind, scheduled by a sweep that is handed its clock. Nothing is
--              sent. A person records that they reminded the client, with a channel and a note.
--   P7-INC-07  an Admin notification POLICY (severity -> channel and a time to acknowledge, versioned, Admin-set) and a notification written when an incident
--              opens. The client-safe wording is a fixed text per severity and carries none of the technical detail. Delivery to e-mail or WhatsApp is a person's
--              relay: the row says so; only the internal inbox is "delivered" by existing.
--   P7-INC-08  a provider-outage decision (wait, retry, fail over, escalate, stop) is a RECORD with evidence. A fail-over needs an independent Admin approval and
--              its execution is a fact somebody records afterwards: AgencyOS fails nothing over.
--   P7-NEG-01  provider-outage, cloud-timeout, monitoring-gap and audit-store-failure CASES as records (handling, the audit gap stated, resolution by a person).
--   P7-QA-07   SmokePassed / SmokeFailed / RollbackCompleted exist as events, emitted by triggers on the rows that change (no existing door was edited).
--
-- Every write goes through a door: a trigger refuses any insert or update that does not carry the door's transaction-local flag, and deletes are always refused.
-- No agent can approve, acknowledge, resolve or decide anything here: each door needs a signed-in person (or, for the two sweeps, the service role, which
-- only RECORDS what the rows already say).
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description) values
  ('project.production_smoke_passed', 'A smoke validation run of a production deployment passed. A person ran it; AgencyOS ran no check.'),
  ('project.production_smoke_failed', 'A smoke validation run of a production deployment failed. Completion is paused by the existing incident door.'),
  ('project.production_rollback_completed', 'A production deployment was recorded as rolled back (a person recorded it; AgencyOS rolled nothing back).'),
  ('project.client_action_reminder_due', 'A client action request is due soon or overdue; a reminder is waiting for a person to send.'),
  ('project.incident_admin_notification_due', 'A production incident opened and an Admin must be told per the notification policy.'),
  ('project.completion_certificate_rendered', 'The completion certificate document was rendered from the completion record.')
on conflict (type) do nothing;

-- ── one guard for every table below ────────────────────────────────────────
-- TG_ARGV lists the columns an UPDATE may change. Every insert and update needs the door flag; a delete is never allowed.
create or replace function projects.p789_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_allowed text[] := coalesce(tg_argv, '{}'::text[]); v_old jsonb; v_new jsonb; k text;
begin
  if tg_op = 'DELETE' then raise exception '% is history and is never deleted', tg_table_name using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p789_door', true), '') <> 'on' then
    raise exception '% changes through its door, never by a direct statement', tg_table_name using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old); v_new := to_jsonb(new);
    foreach k in array v_allowed loop v_old := v_old - k; v_new := v_new - k; end loop;
    if v_old is distinct from v_new then raise exception 'only the decision columns of % may change', tg_table_name using errcode = 'restrict_violation'; end if;
  end if;
  return new;
end $$;
revoke all on function projects.p789_guard() from public, anon, authenticated, service_role;

create or replace function projects.p789_html_escape(p text)
returns text language sql immutable set search_path = '' as $$
  select replace(replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;
revoke all on function projects.p789_html_escape(text) from public, anon;
grant execute on function projects.p789_html_escape(text) to authenticated, service_role;

-- ── tables ─────────────────────────────────────────────────────────────────
create table if not exists projects.p789_completion_certificates (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  completion_record_id uuid not null unique references projects.p7_completion_records(id) on delete restrict,
  certificate_number   text not null check (length(btrim(certificate_number)) between 1 and 120),
  body_html            text not null check (length(body_html) between 200 and 200000),
  content_sha256       text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  rendered_by          uuid references core.users(id) on delete set null,
  rendered_at          timestamptz not null default clock_timestamp(),
  unique (organization_id, certificate_number)
);
comment on table projects.p789_completion_certificates is 'The completion certificate as a document: HTML built from the immutable completion record, once, with its SHA-256. Not signed. Never edited.';

create table if not exists finance.p789_receipt_documents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  receipt_id       uuid not null unique references finance.receipts(id) on delete restrict,
  payment_id       uuid not null references finance.payments(id) on delete restrict,
  invoice_id       uuid not null references finance.invoices(id) on delete restrict,
  receipt_number   text not null check (length(btrim(receipt_number)) > 0),
  body_html        text not null check (length(body_html) between 200 and 100000),
  content_sha256   text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  rendered_by      uuid references core.users(id) on delete set null,
  rendered_at      timestamptz not null default clock_timestamp()
);
comment on table finance.p789_receipt_documents is 'A receipt as a downloadable document: HTML built once from the receipt, the verified payment and the invoice, with its SHA-256. Never edited.';

create table if not exists projects.p789_client_action_reminders (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  request_id         uuid not null references projects.p7c_client_action_requests(id) on delete cascade,
  kind               text not null check (kind in ('due_soon', 'overdue')),
  due_at_seen        timestamptz not null,
  scheduled_at       timestamptz not null,
  state              text not null default 'due' check (state in ('due', 'delivered')),
  delivered_by       uuid references core.users(id) on delete restrict,
  delivered_at       timestamptz,
  delivered_channel  text check (delivered_channel in ('call', 'whatsapp', 'email', 'portal', 'meeting')),
  delivery_note      text check (delivery_note is null or (length(btrim(delivery_note)) between 10 and 1000 and not projects.p7_has_secret(delivery_note))),
  created_at         timestamptz not null default clock_timestamp(),
  unique (request_id, kind),
  constraint p789_car_delivered_is_a_persons check ((state = 'delivered') = (delivered_by is not null and delivered_at is not null and delivered_channel is not null and delivery_note is not null))
);
comment on table projects.p789_client_action_reminders is 'A reminder that a client action request is due soon or overdue. Nothing is sent: a person sends it and records channel and note.';

create table if not exists projects.p789_admin_notification_policies (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references core.organizations(id) on delete cascade,
  severity               text not null check (severity in ('sev1', 'sev2', 'sev3')),
  version                int not null check (version > 0),
  channel                text not null check (channel in ('internal_inbox', 'email', 'whatsapp')),
  acknowledge_within_min int not null check (acknowledge_within_min between 1 and 10080),
  reason                 text not null check (length(btrim(reason)) between 5 and 500 and not projects.p7_has_secret(reason)),
  set_by                 uuid not null references core.users(id) on delete restrict,
  set_at                 timestamptz not null default clock_timestamp(),
  unique (organization_id, severity, version)
);
comment on table projects.p789_admin_notification_policies is 'An Admin-set rule: how an incident of a severity reaches an Admin and how quickly it must be acknowledged. Versioned; the highest version wins.';

create table if not exists projects.p789_admin_notifications (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  incident_id         uuid not null unique references projects.p7_incidents(id) on delete cascade,
  project_id          uuid not null references projects.projects(id) on delete cascade,
  severity            text not null check (severity in ('sev1', 'sev2', 'sev3')),
  policy_id           uuid references projects.p789_admin_notification_policies(id) on delete restrict,
  channel             text not null check (channel in ('internal_inbox', 'email', 'whatsapp')),
  delivery            text not null check (delivery in ('inbox', 'relay_by_person_required')),
  due_by              timestamptz not null,
  technical_summary   text not null check (length(technical_summary) <= 1000),
  client_safe_text    text not null check (length(client_safe_text) between 20 and 500),
  status              text not null default 'pending' check (status in ('pending', 'acknowledged')),
  acknowledged_by     uuid references core.users(id) on delete restrict,
  acknowledged_at     timestamptz,
  acknowledge_note    text check (acknowledge_note is null or (length(btrim(acknowledge_note)) between 5 and 1000 and not projects.p7_has_secret(acknowledge_note))),
  created_at          timestamptz not null default clock_timestamp(),
  constraint p789_an_ack_is_a_persons check ((status = 'acknowledged') = (acknowledged_by is not null and acknowledged_at is not null and acknowledge_note is not null)),
  constraint p789_an_inbox_is_delivered_by_existing check ((channel = 'internal_inbox') = (delivery = 'inbox'))
);
comment on table projects.p789_admin_notifications is 'Written when an incident opens. technical_summary is internal; client_safe_text is a fixed wording that carries none of it. Only the internal inbox is delivered by the row existing; e-mail/WhatsApp are relayed by a person.';

create table if not exists projects.p789_provider_failover_records (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  incident_id          uuid not null references projects.p7_incidents(id) on delete restrict,
  provider_kind        text not null check (provider_kind in ('hosting', 'database', 'email', 'payment', 'whatsapp', 'ai_model', 'dns', 'other')),
  provider_name        text not null check (length(btrim(provider_name)) between 1 and 120 and not projects.p7_has_secret(provider_name)),
  decision             text not null check (decision in ('wait', 'retry', 'failover', 'escalate_to_provider', 'stop')),
  next_check_at        timestamptz,
  failover_target      text check (failover_target is null or (length(btrim(failover_target)) between 1 and 200 and not projects.p7_has_secret(failover_target))),
  evidence_ref         text not null check (length(btrim(evidence_ref)) between 1 and 500 and not projects.p7_has_secret(evidence_ref)),
  recorded_by          uuid not null references core.users(id) on delete restrict,
  recorded_at          timestamptz not null default clock_timestamp(),
  approved_by          uuid references core.users(id) on delete restrict,
  approved_at          timestamptz,
  approval_note        text check (approval_note is null or (length(btrim(approval_note)) between 5 and 1000 and not projects.p7_has_secret(approval_note))),
  executed_by          uuid references core.users(id) on delete restrict,
  executed_at          timestamptz,
  execution_evidence   text check (execution_evidence is null or (length(btrim(execution_evidence)) between 1 and 500 and not projects.p7_has_secret(execution_evidence))),
  constraint p789_pf_wait_and_retry_name_a_time check ((decision in ('wait', 'retry')) = (next_check_at is not null)),
  constraint p789_pf_failover_names_a_target check ((decision = 'failover') = (failover_target is not null)),
  constraint p789_pf_approval_is_complete check ((approved_by is null) = (approved_at is null) and (approved_by is null) = (approval_note is null)),
  constraint p789_pf_only_a_failover_is_approved check (approved_by is null or decision = 'failover'),
  constraint p789_pf_approver_is_independent check (approved_by is null or approved_by <> recorded_by),
  constraint p789_pf_execution_needs_approval check (executed_at is null or approved_by is not null),
  constraint p789_pf_execution_is_complete check ((executed_by is null) = (executed_at is null) and (executed_by is null) = (execution_evidence is null))
);
comment on table projects.p789_provider_failover_records is 'A person''s decision during a provider outage. AgencyOS fails nothing over. A fail-over is approved by an independent Admin, and its execution is a fact recorded afterwards with evidence.';

create table if not exists projects.p789_outage_cases (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid references projects.projects(id) on delete cascade,
  incident_id      uuid references projects.p7_incidents(id) on delete restrict,
  kind             text not null check (kind in ('cloud_timeout', 'provider_outage', 'audit_store_failure', 'monitoring_gap')),
  handling         text not null check (handling in ('waited', 'retried', 'failed_over', 'degraded', 'work_held', 'manual_workaround')),
  observed_from    timestamptz not null,
  observed_until   timestamptz,
  summary          text not null check (length(btrim(summary)) between 10 and 2000 and not projects.p7_has_secret(summary)),
  audit_gap        boolean not null default false,
  status           text not null default 'open' check (status in ('open', 'resolved')),
  recorded_by      uuid not null references core.users(id) on delete restrict,
  recorded_at      timestamptz not null default clock_timestamp(),
  resolved_by      uuid references core.users(id) on delete restrict,
  resolved_at      timestamptz,
  resolution_note  text check (resolution_note is null or (length(btrim(resolution_note)) between 10 and 1000 and not projects.p7_has_secret(resolution_note))),
  constraint p789_oc_window_is_ordered check (observed_until is null or observed_until >= observed_from),
  constraint p789_oc_an_audit_store_failure_states_the_gap check (kind <> 'audit_store_failure' or audit_gap),
  constraint p789_oc_resolution_is_a_persons check ((status = 'resolved') = (resolved_by is not null and resolved_at is not null and resolution_note is not null and observed_until is not null))
);
comment on table projects.p789_outage_cases is 'A recorded provider outage, cloud timeout, monitoring gap or audit-store failure: how it was handled, the audit gap stated, and a person''s resolution.';

create index if not exists p789_car_project_idx on projects.p789_client_action_reminders (project_id, state);
create index if not exists p789_an_pending_idx on projects.p789_admin_notifications (organization_id, status, due_by);
create index if not exists p789_pf_incident_idx on projects.p789_provider_failover_records (incident_id);
create index if not exists p789_oc_org_idx on projects.p789_outage_cases (organization_id, status, observed_from desc);

-- tenancy: a parent in another organization is refused; the organization of a row never moves
do $$
declare r record;
begin
  for r in select * from (values
    ('projects', 'p789_completion_certificates', 'project_id', 'projects.projects'), ('projects', 'p789_completion_certificates', 'completion_record_id', 'projects.p7_completion_records'),
    ('finance',  'p789_receipt_documents', 'receipt_id', 'finance.receipts'), ('finance', 'p789_receipt_documents', 'payment_id', 'finance.payments'), ('finance', 'p789_receipt_documents', 'invoice_id', 'finance.invoices'),
    ('projects', 'p789_client_action_reminders', 'project_id', 'projects.projects'), ('projects', 'p789_client_action_reminders', 'request_id', 'projects.p7c_client_action_requests'),
    ('projects', 'p789_admin_notifications', 'incident_id', 'projects.p7_incidents'), ('projects', 'p789_admin_notifications', 'project_id', 'projects.projects'),
    ('projects', 'p789_admin_notifications', 'policy_id', 'projects.p789_admin_notification_policies'),
    ('projects', 'p789_provider_failover_records', 'incident_id', 'projects.p7_incidents'),
    ('projects', 'p789_outage_cases', 'project_id', 'projects.projects'), ('projects', 'p789_outage_cases', 'incident_id', 'projects.p7_incidents')
  ) as t(sch, tbl, col, parent) loop
    execute format('drop trigger if exists %I on %I.%I', r.tbl || '_parent_org_' || r.col, r.sch, r.tbl);
    execute format('create trigger %I before insert or update of %I, organization_id on %I.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.sch, r.tbl, r.col, r.parent);
  end loop;
end $$;

-- RLS, grants, freeze, guard. Internal read for projects tables; finance tables read by Admin / finance only. No direct write for anyone.
do $$
declare r record; v_allowed text;
begin
  for r in select * from (values
    ('projects', 'p789_completion_certificates', ''), ('finance', 'p789_receipt_documents', ''), ('projects', 'p789_client_action_reminders', 'state,delivered_by,delivered_at,delivered_channel,delivery_note'),
    ('projects', 'p789_admin_notification_policies', ''), ('projects', 'p789_admin_notifications', 'status,acknowledged_by,acknowledged_at,acknowledge_note'),
    ('projects', 'p789_provider_failover_records', 'approved_by,approved_at,approval_note,executed_by,executed_at,execution_evidence'),
    ('projects', 'p789_outage_cases', 'observed_until,status,resolved_by,resolved_at,resolution_note')
  ) as t(sch, tbl, allowed) loop
    execute format('alter table %I.%I enable row level security', r.sch, r.tbl);
    execute format('drop policy if exists %I on %I.%I', r.tbl || '_read', r.sch, r.tbl);
    if r.sch = 'finance' then
      execute format($p$create policy %I on %I.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and ((select core.is_admin()) or (select core.is_finance())))$p$, r.tbl || '_read', r.sch, r.tbl);
    else
      execute format($p$create policy %I on %I.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.sch, r.tbl);
    end if;
    execute format('revoke all on %I.%I from public, anon', r.sch, r.tbl);
    execute format('revoke insert, update, delete on %I.%I from authenticated', r.sch, r.tbl);
    execute format('grant select on %I.%I to authenticated', r.sch, r.tbl);
    execute format('grant all on %I.%I to service_role', r.sch, r.tbl);
    execute format('drop trigger if exists %I on %I.%I', 'freeze_org_' || r.tbl, r.sch, r.tbl);
    execute format('create trigger %I before update of organization_id on %I.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.sch, r.tbl);
    execute format('drop trigger if exists %I on %I.%I', r.tbl || '_guard', r.sch, r.tbl);
    if r.allowed = '' then
      execute format('create trigger %I before insert or update or delete on %I.%I for each row execute function projects.p789_guard()', r.tbl || '_guard', r.sch, r.tbl);
    else
      execute format('create trigger %I before insert or update or delete on %I.%I for each row execute function projects.p789_guard(%s)', r.tbl || '_guard', r.sch, r.tbl,
        (select string_agg(quote_literal(x), ', ') from unnest(string_to_array(r.allowed, ',')) as x));
    end if;
  end loop;
end $$;

-- ═══ P7-ARC-01: the certificate ════════════════════════════════════════════
create or replace function projects.render_completion_certificate(p_project_id uuid)
returns table (outcome text, certificate_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_svc boolean := coalesce((select auth.role()), '') = 'service_role'; v_actor uuid := (select auth.uid());
  v_p projects.projects; v_rec projects.p7_completion_records; v_org_name text; v_client text; v_existing uuid;
  v_num text; v_html text; v_id uuid; v_pl jsonb; v_limits int;
  fmt text := 'YYYY-MM-DD HH24:MI "UTC"';
begin
  select * into v_p from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_p.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if not v_svc then
    if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
    if v_p.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_manage_delivery()), false) then
      return query select 'not_authorized'::text, null::uuid; return;
    end if;
  end if;
  select * into v_rec from projects.p7_completion_records c where c.project_id = p_project_id;
  if v_rec.id is null then return query select 'not_completed'::text, null::uuid; return; end if;
  select c.id into v_existing from projects.p789_completion_certificates c where c.completion_record_id = v_rec.id;
  if v_existing is not null then return query select 'already_rendered'::text, v_existing; return; end if;

  select o.name into v_org_name from core.organizations o where o.id = v_p.organization_id;
  select a.name into v_client from core.client_accounts a where a.id = v_p.client_account_id;
  v_pl := v_rec.payload;
  v_limits := coalesce(jsonb_array_length(case when jsonb_typeof(v_pl -> 'knownLimitations') = 'array' then v_pl -> 'knownLimitations' else '[]'::jsonb end), 0);
  v_num := 'CERT-' || coalesce(nullif(btrim(v_p.project_code), ''), upper(left(replace(v_p.id::text, '-', ''), 8))) || '-' || to_char(v_rec.completed_at at time zone 'UTC', 'YYYYMMDD');

  v_html := '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' || projects.p789_html_escape('Completion certificate ' || v_num) || '</title>'
    || '<style>@page{size:A4;margin:18mm}body{font-family:Georgia,serif;color:#111;max-width:170mm;margin:0 auto;line-height:1.5}h1{font-size:22pt;margin:0 0 4pt}'
    || 'table{border-collapse:collapse;width:100%;margin:12pt 0}td,th{border:1px solid #999;padding:5pt 8pt;text-align:left;vertical-align:top;font-size:10.5pt}th{width:38%;background:#f2f2f2}'
    || '.note{font-size:9.5pt;color:#444;border-top:1px solid #999;margin-top:18pt;padding-top:8pt}</style></head><body>'
    || '<h1>Certificate of completion</h1><p>' || projects.p789_html_escape(v_org_name) || '</p>'
    || '<p>This certifies that the delivery recorded below reached completion in the system of record.</p><table>'
    || '<tr><th>Certificate number</th><td>' || projects.p789_html_escape(v_num) || '</td></tr>'
    || '<tr><th>Client</th><td>' || projects.p789_html_escape(v_client) || '</td></tr>'
    || '<tr><th>Project</th><td>' || projects.p789_html_escape(v_p.name) || '</td></tr>'
    || '<tr><th>Completed</th><td>' || projects.p789_html_escape(to_char(v_rec.completed_at at time zone 'UTC', fmt)) || '</td></tr>'
    || '<tr><th>Release version</th><td>' || projects.p789_html_escape(coalesce(v_pl #>> '{release,version}', 'not recorded')) || '</td></tr>'
    || '<tr><th>Production commit</th><td>' || projects.p789_html_escape(left(v_rec.commit_ref, 40)) || '</td></tr>'
    || '<tr><th>Deployed</th><td>' || projects.p789_html_escape(coalesce(v_pl #>> '{production,deployedAt}', 'not recorded')) || '</td></tr>'
    || '<tr><th>Handover package version</th><td>' || projects.p789_html_escape(coalesce(v_pl #>> '{handover,version}', 'not recorded')) || '</td></tr>'
    || '<tr><th>Client acceptance</th><td>' || case when v_pl #>> '{acceptance,client}' is not null
         then projects.p789_html_escape('Accepted by ' || (v_pl #>> '{acceptance,client}') || ' (' || coalesce(v_pl #>> '{acceptance,evidenceKind}', 'evidence recorded') || ')')
         else projects.p789_html_escape('Acceptance not required: ' || coalesce(v_pl #>> '{acceptance,waiverReason}', 'waiver recorded')) end || '</td></tr>'
    || '<tr><th>Final financial status</th><td>' || projects.p789_html_escape(coalesce(v_pl #>> '{finance,status}', 'not recorded')) || '</td></tr>'
    || '<tr><th>Warranty ends</th><td>' || projects.p789_html_escape(coalesce(v_pl #>> '{support,warrantyEndsOn}', 'not stated')) || '</td></tr>'
    || '<tr><th>Known limitations disclosed</th><td>' || v_limits || '</td></tr></table>'
    || '<p class="note">Generated from completion record ' || projects.p789_html_escape(v_rec.id::text) || '. This document is not signed. It states what the system holds; if a signature is required a person signs a copy. '
    || 'Its SHA-256 is stored beside it.</p></body></html>';

  perform set_config('projects.p789_door', 'on', true);
  insert into projects.p789_completion_certificates (organization_id, project_id, completion_record_id, certificate_number, body_html, content_sha256, rendered_by)
  values (v_p.organization_id, p_project_id, v_rec.id, v_num, v_html, encode(sha256(convert_to(v_html, 'UTF8')), 'hex'), v_actor) returning id into v_id;
  perform core.record_audit(v_p.organization_id, 'completion.certificate_rendered', 'project', p_project_id, null, jsonb_build_object('certificateId', v_id, 'number', v_num));
  perform core.emit_event(v_p.organization_id, 'project.completion_certificate_rendered', 'project', p_project_id, jsonb_build_object('projectId', p_project_id, 'certificateId', v_id));
  return query select 'rendered'::text, v_id;
end $$;
revoke all on function projects.render_completion_certificate(uuid) from public, anon;
grant execute on function projects.render_completion_certificate(uuid) to authenticated, service_role;

-- the document itself: staff of the organization, or the owning client once the portal is not expired
create or replace function projects.p789_completion_certificate(p_project_id uuid)
returns table (certificate_id uuid, certificate_number text, rendered_at timestamptz, content_sha256 text, body_html text, intact boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if projects.p7b_portal_project(p_project_id) is null then return; end if;
  if coalesce((select core.is_client()), false) and projects.p7b_portal_access(p_project_id) = 'expired' then return; end if;
  return query select c.id, c.certificate_number, c.rendered_at, c.content_sha256, c.body_html,
                      (encode(sha256(convert_to(c.body_html, 'UTF8')), 'hex') = c.content_sha256)
                 from projects.p789_completion_certificates c where c.project_id = p_project_id;
end $$;
revoke all on function projects.p789_completion_certificate(uuid) from public, anon, service_role;
grant execute on function projects.p789_completion_certificate(uuid) to authenticated;

-- ═══ P7-FIN-05/06: the receipt document ════════════════════════════════════
create or replace function finance.p789_render_receipt_documents(p_receipt_id uuid default null, p_limit int default 100)
returns table (outcome text, rendered int)
language plpgsql security definer set search_path = '' as $$
declare
  v_svc boolean := coalesce((select auth.role()), '') = 'service_role'; v_actor uuid := (select auth.uid()); v_org uuid := (select core.current_organization_id());
  r record; v_html text; v_n int := 0; v_proj text;
begin
  if not v_svc then
    if v_actor is null then return query select 'no_actor'::text, 0; return; end if;
    if not (coalesce((select core.is_admin()), false) or coalesce((select core.is_finance()), false)) then return query select 'not_authorized'::text, 0; return; end if;
    if p_receipt_id is null then return query select 'a_receipt_is_required'::text, 0; return; end if;
  end if;
  for r in
    select rc.id as receipt_id, rc.organization_id, rc.payment_id, rc.invoice_id, rc.number, rc.amount_minor, rc.currency::text as currency, rc.issued_at,
           y.verified_at, i.number as invoice_number, i.project_id, a.name as client_name, o.name as org_name
      from finance.receipts rc
      join finance.payments y on y.id = rc.payment_id and y.status = 'captured' and y.verified_at is not null
      join finance.invoices i on i.id = rc.invoice_id
      join core.client_accounts a on a.id = i.client_account_id
      join core.organizations o on o.id = rc.organization_id
     where (p_receipt_id is null or rc.id = p_receipt_id)
       and (v_svc or rc.organization_id = v_org)
       and not exists (select 1 from finance.p789_receipt_documents d where d.receipt_id = rc.id)
     order by rc.issued_at, rc.id limit greatest(1, least(coalesce(p_limit, 100), 500))
  loop
    select p.name into v_proj from projects.projects p where p.id = r.project_id;
    v_html := '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' || projects.p789_html_escape('Receipt ' || r.number) || '</title>'
      || '<style>@page{size:A4;margin:18mm}body{font-family:Helvetica,Arial,sans-serif;color:#111;max-width:170mm;margin:0 auto;line-height:1.5}h1{font-size:20pt;margin:0 0 4pt}'
      || 'table{border-collapse:collapse;width:100%;margin:12pt 0}td,th{border:1px solid #999;padding:5pt 8pt;text-align:left;font-size:10.5pt}th{width:38%;background:#f2f2f2}'
      || '.note{font-size:9.5pt;color:#444;margin-top:14pt}</style></head><body>'
      || '<h1>Payment receipt</h1><p>' || projects.p789_html_escape(r.org_name) || '</p><table>'
      || '<tr><th>Receipt number</th><td>' || projects.p789_html_escape(r.number) || '</td></tr>'
      || '<tr><th>Received from</th><td>' || projects.p789_html_escape(r.client_name) || '</td></tr>'
      || '<tr><th>Invoice</th><td>' || projects.p789_html_escape(r.invoice_number) || '</td></tr>'
      || case when v_proj is not null then '<tr><th>Project</th><td>' || projects.p789_html_escape(v_proj) || '</td></tr>' else '' end
      || '<tr><th>Amount received</th><td>' || projects.p789_html_escape(r.currency || ' ' || to_char(r.amount_minor / 100.0, 'FM999,999,999,990.00')) || '</td></tr>'
      || '<tr><th>Verified as received</th><td>' || projects.p789_html_escape(to_char(r.verified_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')) || '</td></tr></table>'
      || '<p class="note">Issued only after a person at ' || projects.p789_html_escape(r.org_name) || ' verified that this money arrived. It is not a tax invoice.</p></body></html>';
    perform set_config('projects.p789_door', 'on', true);
    insert into finance.p789_receipt_documents (organization_id, receipt_id, payment_id, invoice_id, receipt_number, body_html, content_sha256, rendered_by)
    values (r.organization_id, r.receipt_id, r.payment_id, r.invoice_id, r.number, v_html, encode(sha256(convert_to(v_html, 'UTF8')), 'hex'), v_actor);
    perform core.record_audit(r.organization_id, 'receipt.document_rendered', 'receipt', r.receipt_id, null, jsonb_build_object('receiptNumber', r.number));
    v_n := v_n + 1;
  end loop;
  return query select case when v_n > 0 then 'rendered' else 'nothing_to_render' end, v_n;
end $$;
revoke all on function finance.p789_render_receipt_documents(uuid, int) from public, anon;
grant execute on function finance.p789_render_receipt_documents(uuid, int) to authenticated, service_role;

-- the client reads only its own receipt, for a verified payment on an issued invoice (the same filter as the statement)
create or replace function projects.p789_client_receipt_document(p_payment_id uuid)
returns table (receipt_number text, content_sha256 text, body_html text)
language plpgsql stable security definer set search_path = '' as $$
declare v_acct uuid := projects.p7c_statement_account(); v_org uuid := (select core.current_organization_id());
begin
  if v_acct is null or v_org is null then return; end if;
  return query
    select d.receipt_number, d.content_sha256, d.body_html
      from finance.p789_receipt_documents d
      join finance.payments y on y.id = d.payment_id
      join finance.invoices i on i.id = d.invoice_id
     where d.payment_id = p_payment_id and d.organization_id = v_org and i.organization_id = v_org and i.client_account_id = v_acct
       and i.status not in ('draft', 'pending_approval') and y.status = 'captured' and y.verified_at is not null
       and (i.project_id is null or projects.p7b_portal_access(i.project_id) <> 'expired');
end $$;
revoke all on function projects.p789_client_receipt_document(uuid) from public, anon, service_role;
grant execute on function projects.p789_client_receipt_document(uuid) to authenticated;

-- ═══ P7-PM-07: reminders ═══════════════════════════════════════════════════
create or replace function projects.p789_sweep_client_action_reminders(p_organization_id uuid default null, p_now timestamptz default null, p_due_soon_days int default 3)
returns table (outcome text, scheduled int)
language plpgsql security definer set search_path = '' as $$
declare
  v_svc boolean := coalesce((select auth.role()), '') = 'service_role'; v_org uuid; v_now timestamptz; v_n int := 0; r record; v_id uuid;
begin
  if v_svc then v_org := p_organization_id; v_now := coalesce(p_now, clock_timestamp());
  else
    if (select auth.uid()) is null then return query select 'no_actor'::text, 0; return; end if;
    if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, 0; return; end if;
    v_org := (select core.current_organization_id()); v_now := clock_timestamp();   -- a person cannot move the clock
  end if;
  if p_due_soon_days is null or p_due_soon_days < 1 or p_due_soon_days > 60 then return query select 'bad_window'::text, 0; return; end if;
  for r in
    select q.id, q.organization_id, q.project_id, q.due_at, case when q.due_at <= v_now then 'overdue' else 'due_soon' end as kind
      from projects.p7c_client_action_requests q
     where q.status = 'open' and (v_org is null or q.organization_id = v_org) and q.due_at <= v_now + make_interval(days => p_due_soon_days)
  loop
    perform set_config('projects.p789_door', 'on', true);
    insert into projects.p789_client_action_reminders (organization_id, project_id, request_id, kind, due_at_seen, scheduled_at)
    values (r.organization_id, r.project_id, r.id, r.kind, r.due_at, v_now)
    on conflict (request_id, kind) do nothing returning id into v_id;
    if v_id is not null then
      v_n := v_n + 1;
      perform core.emit_event(r.organization_id, 'project.client_action_reminder_due', 'client_action_request', r.id, jsonb_build_object('projectId', r.project_id, 'kind', r.kind));
      v_id := null;
    end if;
  end loop;
  return query select case when v_n > 0 then 'scheduled' else 'nothing_to_schedule' end, v_n;
end $$;
revoke all on function projects.p789_sweep_client_action_reminders(uuid, timestamptz, int) from public, anon;
grant execute on function projects.p789_sweep_client_action_reminders(uuid, timestamptz, int) to authenticated, service_role;

create or replace function projects.p789_record_client_action_reminder_sent(p_reminder_id uuid, p_channel text, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.p789_client_action_reminders; v_req projects.p7c_client_action_requests;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_channel is null or p_channel not in ('call', 'whatsapp', 'email', 'portal', 'meeting') then return query select 'bad_channel'::text; return; end if;
  if p_note is null or length(btrim(p_note)) < 10 then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_r from projects.p789_client_action_reminders x where x.id = p_reminder_id and x.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if v_r.state = 'delivered' then return query select 'already_recorded'::text; return; end if;
  select * into v_req from projects.p7c_client_action_requests q where q.id = v_r.request_id;
  if v_req.status <> 'open' then return query select 'request_no_longer_open'::text; return; end if;
  perform set_config('projects.p789_door', 'on', true);
  update projects.p789_client_action_reminders set state = 'delivered', delivered_by = v_actor, delivered_at = clock_timestamp(), delivered_channel = p_channel, delivery_note = btrim(p_note) where id = v_r.id;
  perform core.record_audit(v_org, 'client_action.reminder_sent', 'client_action_request', v_r.request_id, null, jsonb_build_object('kind', v_r.kind, 'channel', p_channel));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.p789_record_client_action_reminder_sent(uuid, text, text) from public, anon, service_role;
grant execute on function projects.p789_record_client_action_reminder_sent(uuid, text, text) to authenticated;

-- the reminders still waiting for a person: derived (a request that is no longer open drops out)
create or replace function projects.p789_pending_client_action_reminders(p_project_id uuid default null)
returns table (reminder_id uuid, request_id uuid, project_id uuid, title text, kind text, due_at timestamptz, scheduled_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query select m.id, q.id, q.project_id, q.title, m.kind, q.due_at, m.scheduled_at
    from projects.p789_client_action_reminders m join projects.p7c_client_action_requests q on q.id = m.request_id
   where m.organization_id = v_org and m.state = 'due' and q.status = 'open' and (p_project_id is null or m.project_id = p_project_id)
   order by q.due_at, m.kind;
end $$;
revoke all on function projects.p789_pending_client_action_reminders(uuid) from public, anon, service_role;
grant execute on function projects.p789_pending_client_action_reminders(uuid) to authenticated;

-- ═══ P7-INC-07: the Admin notification policy ══════════════════════════════
create or replace function projects.p789_set_admin_notification_policy(p_severity text, p_channel text, p_acknowledge_within_min int, p_reason text)
returns table (outcome text, version int)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_v int;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::int; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::int; return; end if;
  if p_severity is null or p_severity not in ('sev1', 'sev2', 'sev3') then return query select 'bad_severity'::text, null::int; return; end if;
  if p_channel is null or p_channel not in ('internal_inbox', 'email', 'whatsapp') then return query select 'bad_channel'::text, null::int; return; end if;
  if p_acknowledge_within_min is null or p_acknowledge_within_min < 1 or p_acknowledge_within_min > 10080 then return query select 'bad_minutes'::text, null::int; return; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then return query select 'reason_required'::text, null::int; return; end if;
  if projects.p7_has_secret(p_reason) then return query select 'contains_secret'::text, null::int; return; end if;
  perform pg_advisory_xact_lock(hashtextextended('p789_policy:' || v_org::text || p_severity, 0));
  select coalesce(max(x.version), 0) + 1 into v_v from projects.p789_admin_notification_policies x where x.organization_id = v_org and x.severity = p_severity;
  perform set_config('projects.p789_door', 'on', true);
  insert into projects.p789_admin_notification_policies (organization_id, severity, version, channel, acknowledge_within_min, reason, set_by)
  values (v_org, p_severity, v_v, p_channel, p_acknowledge_within_min, btrim(p_reason), v_actor);
  perform core.record_audit(v_org, 'incident.notification_policy_set', 'organization', v_org, null, jsonb_build_object('severity', p_severity, 'channel', p_channel, 'minutes', p_acknowledge_within_min, 'version', v_v));
  return query select 'set'::text, v_v;
end $$;
revoke all on function projects.p789_set_admin_notification_policy(text, text, int, text) from public, anon, service_role;
grant execute on function projects.p789_set_admin_notification_policy(text, text, int, text) to authenticated;

-- an incident opens -> an Admin notification row, by the policy (or, with no policy, the internal inbox within 60 minutes, and it says so)
create or replace function projects.p789_notify_admin_on_incident()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_pol projects.p789_admin_notification_policies; v_channel text; v_min int; v_text text;
begin
  select * into v_pol from projects.p789_admin_notification_policies x where x.organization_id = new.organization_id and x.severity = new.severity order by x.version desc limit 1;
  v_channel := coalesce(v_pol.channel, 'internal_inbox'); v_min := coalesce(v_pol.acknowledge_within_min, 60);
  v_text := case new.severity
    when 'sev1' then 'We found a serious problem with your live system and our team is working on it now. We will update you as soon as we know more.'
    when 'sev2' then 'We found a problem with your live system and our team is looking into it. We will update you shortly.'
    else 'We noticed a minor issue with your live system and our team is looking into it. No action is needed from you.' end;
  perform set_config('projects.p789_door', 'on', true);
  insert into projects.p789_admin_notifications (organization_id, incident_id, project_id, severity, policy_id, channel, delivery, due_by, technical_summary, client_safe_text)
  values (new.organization_id, new.id, new.project_id, new.severity, v_pol.id, v_channel, case when v_channel = 'internal_inbox' then 'inbox' else 'relay_by_person_required' end,
          new.opened_at + make_interval(mins => v_min),
          left(new.incident_type || ' on commit ' || left(new.commit_ref, 12) || coalesce(' - ' || new.impact, ''), 1000), v_text)
  on conflict (incident_id) do nothing;
  perform core.emit_event(new.organization_id, 'project.incident_admin_notification_due', 'incident', new.id, jsonb_build_object('projectId', new.project_id, 'severity', new.severity, 'channel', v_channel));
  return new;
end $$;
revoke all on function projects.p789_notify_admin_on_incident() from public, anon, authenticated, service_role;
drop trigger if exists p789_incident_notifies_admin on projects.p7_incidents;
create trigger p789_incident_notifies_admin after insert on projects.p7_incidents for each row execute function projects.p789_notify_admin_on_incident();

create or replace function projects.p789_acknowledge_admin_notification(p_notification_id uuid, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_n projects.p789_admin_notifications;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_note is null or length(btrim(p_note)) < 5 then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_n from projects.p789_admin_notifications x where x.id = p_notification_id and x.organization_id = v_org for update;
  if v_n.id is null then return query select 'not_found'::text; return; end if;
  if v_n.status = 'acknowledged' then return query select 'already_acknowledged'::text; return; end if;
  perform set_config('projects.p789_door', 'on', true);
  update projects.p789_admin_notifications set status = 'acknowledged', acknowledged_by = v_actor, acknowledged_at = clock_timestamp(), acknowledge_note = btrim(p_note) where id = v_n.id;
  perform core.record_audit(v_org, 'incident.admin_notification_acknowledged', 'incident', v_n.incident_id, null, jsonb_build_object('late', clock_timestamp() > v_n.due_by));
  return query select 'acknowledged'::text;
end $$;
revoke all on function projects.p789_acknowledge_admin_notification(uuid, text) from public, anon, service_role;
grant execute on function projects.p789_acknowledge_admin_notification(uuid, text) to authenticated;

create or replace function projects.p789_admin_notification_queue(p_now timestamptz default null)
returns table (notification_id uuid, incident_id uuid, project_id uuid, severity text, channel text, delivery text, due_by timestamptz, overdue boolean, status text, technical_summary text)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_now timestamptz := coalesce(p_now, clock_timestamp());
begin
  if v_org is null or not coalesce((select core.is_admin()), false) then return; end if;
  return query select n.id, n.incident_id, n.project_id, n.severity, n.channel, n.delivery, n.due_by, (n.status = 'pending' and n.due_by < v_now), n.status, n.technical_summary
    from projects.p789_admin_notifications n where n.organization_id = v_org order by (n.status = 'pending') desc, n.due_by;
end $$;
revoke all on function projects.p789_admin_notification_queue(timestamptz) from public, anon, service_role;
grant execute on function projects.p789_admin_notification_queue(timestamptz) to authenticated;

-- ═══ P7-INC-08: provider-outage decisions ══════════════════════════════════
create or replace function projects.p789_record_provider_decision(
  p_incident_id uuid, p_provider_kind text, p_provider_name text, p_decision text, p_evidence_ref text, p_next_check_at timestamptz default null, p_failover_target text default null)
returns table (outcome text, record_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.p7_incidents; v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_i from projects.p7_incidents i where i.id = p_incident_id and i.organization_id = v_org;
  if v_i.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_i.state = 'closed' then return query select 'incident_closed'::text, null::uuid; return; end if;
  if v_i.incident_type <> 'provider_outage' and v_i.recovery_path <> 'provider' then return query select 'not_a_provider_incident'::text, null::uuid; return; end if;
  if p_decision is null or p_decision not in ('wait', 'retry', 'failover', 'escalate_to_provider', 'stop') then return query select 'bad_decision'::text, null::uuid; return; end if;
  if p_decision in ('wait', 'retry') and (p_next_check_at is null or p_next_check_at <= clock_timestamp()) then return query select 'next_check_in_the_future_required'::text, null::uuid; return; end if;
  if p_decision not in ('wait', 'retry') and p_next_check_at is not null then return query select 'next_check_only_for_wait_or_retry'::text, null::uuid; return; end if;
  if p_decision = 'failover' and (p_failover_target is null or length(btrim(p_failover_target)) = 0) then return query select 'failover_target_required'::text, null::uuid; return; end if;
  if p_decision <> 'failover' and p_failover_target is not null then return query select 'target_only_for_failover'::text, null::uuid; return; end if;
  if p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0 then return query select 'evidence_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_evidence_ref) or projects.p7_has_secret(p_provider_name) or projects.p7_has_secret(p_failover_target) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if p_provider_kind is null or p_provider_kind not in ('hosting', 'database', 'email', 'payment', 'whatsapp', 'ai_model', 'dns', 'other') then return query select 'bad_provider_kind'::text, null::uuid; return; end if;
  if p_provider_name is null or length(btrim(p_provider_name)) = 0 then return query select 'provider_name_required'::text, null::uuid; return; end if;
  if p_decision = 'failover' and exists (select 1 from projects.p789_provider_failover_records f where f.incident_id = p_incident_id and f.decision = 'failover' and f.executed_at is null) then
    return query select 'a_failover_is_already_pending'::text, null::uuid; return;
  end if;
  perform set_config('projects.p789_door', 'on', true);
  insert into projects.p789_provider_failover_records (organization_id, incident_id, provider_kind, provider_name, decision, next_check_at, failover_target, evidence_ref, recorded_by)
  values (v_org, p_incident_id, p_provider_kind, btrim(p_provider_name), p_decision, p_next_check_at, nullif(btrim(coalesce(p_failover_target, '')), ''), btrim(p_evidence_ref), v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'incident.provider_decision_recorded', 'incident', p_incident_id, null, jsonb_build_object('decision', p_decision, 'providerKind', p_provider_kind));
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.p789_record_provider_decision(uuid, text, text, text, text, timestamptz, text) from public, anon, service_role;
grant execute on function projects.p789_record_provider_decision(uuid, text, text, text, text, timestamptz, text) to authenticated;

create or replace function projects.p789_approve_provider_failover(p_record_id uuid, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_f projects.p789_provider_failover_records;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_note is null or length(btrim(p_note)) < 5 then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_f from projects.p789_provider_failover_records x where x.id = p_record_id and x.organization_id = v_org for update;
  if v_f.id is null then return query select 'not_found'::text; return; end if;
  if v_f.decision <> 'failover' then return query select 'not_a_failover'::text; return; end if;
  if v_f.approved_by is not null then return query select 'already_approved'::text; return; end if;
  if v_f.recorded_by = v_actor then return query select 'self_approval'::text; return; end if;
  perform set_config('projects.p789_door', 'on', true);
  update projects.p789_provider_failover_records set approved_by = v_actor, approved_at = clock_timestamp(), approval_note = btrim(p_note) where id = v_f.id;
  perform core.record_audit(v_org, 'incident.provider_failover_approved', 'incident', v_f.incident_id, null, jsonb_build_object('recordId', v_f.id));
  return query select 'approved'::text;
end $$;
revoke all on function projects.p789_approve_provider_failover(uuid, text) from public, anon, service_role;
grant execute on function projects.p789_approve_provider_failover(uuid, text) to authenticated;

create or replace function projects.p789_record_provider_failover_executed(p_record_id uuid, p_evidence text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_f projects.p789_provider_failover_records;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_evidence is null or length(btrim(p_evidence)) = 0 then return query select 'evidence_required'::text; return; end if;
  if projects.p7_has_secret(p_evidence) then return query select 'contains_secret'::text; return; end if;
  select * into v_f from projects.p789_provider_failover_records x where x.id = p_record_id and x.organization_id = v_org for update;
  if v_f.id is null then return query select 'not_found'::text; return; end if;
  if v_f.approved_by is null then return query select 'not_approved'::text; return; end if;
  if v_f.executed_at is not null then return query select 'already_recorded'::text; return; end if;
  perform set_config('projects.p789_door', 'on', true);
  update projects.p789_provider_failover_records set executed_by = v_actor, executed_at = clock_timestamp(), execution_evidence = btrim(p_evidence) where id = v_f.id;
  perform core.record_audit(v_org, 'incident.provider_failover_executed', 'incident', v_f.incident_id, null, jsonb_build_object('recordId', v_f.id));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.p789_record_provider_failover_executed(uuid, text) from public, anon, service_role;
grant execute on function projects.p789_record_provider_failover_executed(uuid, text) to authenticated;

-- ═══ P7-NEG-01: outage cases ═══════════════════════════════════════════════
create or replace function projects.p789_record_outage_case(p_kind text, p_handling text, p_observed_from timestamptz, p_summary text,
                                                            p_project_id uuid default null, p_incident_id uuid default null, p_audit_gap boolean default false)
returns table (outcome text, case_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind is null or p_kind not in ('cloud_timeout', 'provider_outage', 'audit_store_failure', 'monitoring_gap') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_handling is null or p_handling not in ('waited', 'retried', 'failed_over', 'degraded', 'work_held', 'manual_workaround') then return query select 'bad_handling'::text, null::uuid; return; end if;
  if p_observed_from is null or p_observed_from > clock_timestamp() + interval '5 minutes' then return query select 'bad_observed_time'::text, null::uuid; return; end if;
  if p_summary is null or length(btrim(p_summary)) < 10 then return query select 'summary_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_summary) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if p_kind = 'audit_store_failure' and not coalesce(p_audit_gap, false) then return query select 'audit_gap_must_be_stated'::text, null::uuid; return; end if;
  if p_handling = 'failed_over' and not exists (select 1 from projects.p789_provider_failover_records f where f.organization_id = v_org and f.incident_id = p_incident_id and f.executed_at is not null) then
    return query select 'no_recorded_failover_execution'::text, null::uuid; return;
  end if;
  if p_project_id is not null and not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return query select 'project_not_found'::text, null::uuid; return; end if;
  if p_incident_id is not null and not exists (select 1 from projects.p7_incidents i where i.id = p_incident_id and i.organization_id = v_org) then return query select 'incident_not_found'::text, null::uuid; return; end if;
  perform set_config('projects.p789_door', 'on', true);
  insert into projects.p789_outage_cases (organization_id, project_id, incident_id, kind, handling, observed_from, summary, audit_gap, recorded_by)
  values (v_org, p_project_id, p_incident_id, p_kind, p_handling, p_observed_from, btrim(p_summary), coalesce(p_audit_gap, false), v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'outage.case_recorded', 'outage_case', v_id, null, jsonb_build_object('kind', p_kind, 'handling', p_handling, 'auditGap', coalesce(p_audit_gap, false)));
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.p789_record_outage_case(text, text, timestamptz, text, uuid, uuid, boolean) from public, anon, service_role;
grant execute on function projects.p789_record_outage_case(text, text, timestamptz, text, uuid, uuid, boolean) to authenticated;

create or replace function projects.p789_resolve_outage_case(p_case_id uuid, p_observed_until timestamptz, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c projects.p789_outage_cases;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_c from projects.p789_outage_cases x where x.id = p_case_id and x.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status = 'resolved' then return query select 'already_resolved'::text; return; end if;
  -- an audit-store failure is closed by an Admin: the gap in the audit trail is theirs to accept
  if v_c.kind = 'audit_store_failure' and not coalesce((select core.is_admin()), false) then return query select 'admin_required_for_audit_gap'::text; return; end if;
  if p_observed_until is null or p_observed_until < v_c.observed_from or p_observed_until > clock_timestamp() + interval '5 minutes' then return query select 'bad_end_time'::text; return; end if;
  if p_note is null or length(btrim(p_note)) < 10 then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  perform set_config('projects.p789_door', 'on', true);
  update projects.p789_outage_cases set observed_until = p_observed_until, status = 'resolved', resolved_by = v_actor, resolved_at = clock_timestamp(), resolution_note = btrim(p_note) where id = v_c.id;
  perform core.record_audit(v_org, 'outage.case_resolved', 'outage_case', v_c.id, null, jsonb_build_object('kind', v_c.kind));
  return query select 'resolved'::text;
end $$;
revoke all on function projects.p789_resolve_outage_case(uuid, timestamptz, text) from public, anon, service_role;
grant execute on function projects.p789_resolve_outage_case(uuid, timestamptz, text) to authenticated;

-- ═══ P7-QA-07: events from the rows that change ════════════════════════════
create or replace function projects.p789_emit_validation_events()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'smoke' and old.status = 'running' and new.status = 'passed' then
    perform core.emit_event(new.organization_id, 'project.production_smoke_passed', 'deployment', new.deployment_id, jsonb_build_object('projectId', new.project_id, 'runId', new.id, 'commit', new.commit_ref));
  elsif new.kind = 'smoke' and old.status = 'running' and new.status in ('failed', 'blocked') then
    perform core.emit_event(new.organization_id, 'project.production_smoke_failed', 'deployment', new.deployment_id, jsonb_build_object('projectId', new.project_id, 'runId', new.id, 'commit', new.commit_ref, 'status', new.status));
  end if;
  return new;
end $$;
revoke all on function projects.p789_emit_validation_events() from public, anon, authenticated, service_role;
drop trigger if exists p789_validation_runs_events on projects.p7_validation_runs;
create trigger p789_validation_runs_events after update of status on projects.p7_validation_runs for each row execute function projects.p789_emit_validation_events();

create or replace function projects.p789_emit_rollback_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'rolled_back' and old.status is distinct from 'rolled_back' then
    perform core.emit_event(new.organization_id, 'project.production_rollback_completed', 'deployment', new.id, jsonb_build_object('projectId', new.project_id, 'commit', new.commit_ref));
  end if;
  return new;
end $$;
revoke all on function projects.p789_emit_rollback_event() from public, anon, authenticated, service_role;
drop trigger if exists p789_deployments_rollback_event on projects.p7_deployments;
create trigger p789_deployments_rollback_event after update of status on projects.p7_deployments for each row execute function projects.p789_emit_rollback_event();

notify pgrst, 'reload schema';
