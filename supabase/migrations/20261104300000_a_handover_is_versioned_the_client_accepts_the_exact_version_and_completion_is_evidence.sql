-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7, part 3: the handover package, client acceptance, financial clearance, the completion gate and the Phase 8 intake.
-- Spec: P701 §10-§13, P707 (handover), P708 (acceptance + completion), P710 (final financial clearance), P711 (completion record), P709 (CS handoff).
--
--   projects.p7_contract_deliverables / p7_handover_packages / p7_handover_items / p7_access_transfers
--        a STRUCTURED, VERSIONED package for the exact validated release. Credentials are handed over BY REFERENCE (method, status, an evidence receipt): there is no
--        column for a secret value and every text column refuses anything shaped like one. A package is immutable once it leaves draft: an edit is a NEW version.
--   projects.p7_handover_reviews / p7_client_acceptances
--        Admin review of the exact version; the CLIENT's acceptance recorded by staff with evidence (an informal "looks good" is not acceptance).
--        The client accepts, never an agent. Acceptance of one version never approves a later one.
--   projects.p7_financial_clearance / p7_financial_exceptions
--        final financial clearance READ from finance rows (M4 verified in full, no outstanding balance, a receipt, no pending refund, no open dispute); Finance does not
--        declare completion.
--   projects.complete_phase_seven
--        the completion gate. It closes the project only when deployment is validated in production, the handover is delivered and accepted, and final payment is cleared.
--        It writes ONE immutable completion record and a frozen Customer Success / Phase 8 intake (projects.phase_seven_handoffs) in the same transaction.
--
-- A NEW rule applies only to projects that have a phase_seven row; a legacy project's completion is unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.p7_contract_deliverables (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  kind             text not null check (kind in ('source_repository', 'deployment_docs', 'config_docs', 'db_docs', 'api_docs', 'admin_guide', 'user_guide', 'invoices_receipts', 'training')),
  label            text not null check (length(btrim(label)) > 0 and not projects.p7_has_secret(label)),
  required         boolean not null,
  exclusion_reason text check (not projects.p7_has_secret(exclusion_reason)),
  recorded_by      uuid references core.users(id) on delete set null,
  recorded_at      timestamptz not null default now(),
  unique (project_id, kind),
  check (required or (exclusion_reason is not null and length(btrim(exclusion_reason)) > 0))
);

create table if not exists projects.p7_handover_packages (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  project_id               uuid not null references projects.projects(id) on delete cascade,
  phase_seven_id           uuid not null references projects.phase_seven(id) on delete cascade,
  version                  int not null check (version > 0),
  status                   text not null default 'draft' check (status in ('draft', 'admin_review', 'changes_requested', 'approved', 'delivered', 'superseded')),
  deployment_id            uuid not null references projects.p7_deployments(id) on delete restrict,
  validation_run_id        uuid not null references projects.p7_validation_runs(id) on delete restrict,
  candidate_id             uuid not null references qa.release_candidates(id) on delete restrict,
  commit_ref               text not null,
  artifact_sha256          text not null,
  production_url           text check (not projects.p7_has_secret(production_url)),
  support_terms            text check (not projects.p7_has_secret(support_terms)),
  warranty_ends_on         date,
  emergency_contacts       text check (not projects.p7_has_secret(emergency_contacts)),
  disclosed_limitation_ids uuid[] not null default '{}',
  supersedes_id            uuid references projects.p7_handover_packages(id) on delete restrict,
  created_by               uuid references core.users(id) on delete set null,
  created_at               timestamptz not null default clock_timestamp(),
  admin_approved_by        uuid references core.users(id) on delete set null,
  admin_approved_at        timestamptz,
  delivered_by             uuid references core.users(id) on delete set null,
  delivered_at             timestamptz,
  delivery_channel         text check (not projects.p7_has_secret(delivery_channel)),
  unique (project_id, version),
  check (status not in ('approved', 'delivered') or (admin_approved_by is not null and admin_approved_at is not null)),
  check (status <> 'delivered' or (delivered_by is not null and delivered_at is not null))
);
-- one canonical live version per project (a duplicate package event creates no second one)
create unique index if not exists p7_packages_one_live on projects.p7_handover_packages (project_id) where status in ('draft', 'admin_review', 'changes_requested', 'approved', 'delivered');

create table if not exists projects.p7_handover_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  package_id       uuid not null references projects.p7_handover_packages(id) on delete cascade,
  kind             text not null check (kind in ('scope', 'release', 'production_url', 'known_limitations', 'support_warranty', 'emergency_contacts',
                                                 'source_repository', 'deployment_docs', 'config_docs', 'db_docs', 'api_docs', 'admin_guide', 'user_guide', 'invoices_receipts', 'training')),
  label            text not null check (length(btrim(label)) > 0 and not projects.p7_has_secret(label)),
  required         boolean not null default true,
  status           text not null default 'pending' check (status in ('pending', 'ready', 'not_required')),
  artifact_ref     text check (not projects.p7_has_secret(artifact_ref)),
  evidence_ref     text check (not projects.p7_has_secret(evidence_ref)),
  reason           text check (not projects.p7_has_secret(reason)),
  updated_by       uuid references core.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  unique (package_id, kind),
  check (status <> 'ready' or (artifact_ref is not null and length(btrim(artifact_ref)) > 0)),
  check (status <> 'not_required' or (not required and reason is not null and length(btrim(reason)) > 0))
);

-- a credential handover is a RECEIPT, never a value: the method, the status, and a reference to where the transfer is evidenced
create table if not exists projects.p7_access_transfers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  package_id       uuid not null references projects.p7_handover_packages(id) on delete cascade,
  system_name      text not null check (length(btrim(system_name)) > 0 and not projects.p7_has_secret(system_name)),
  kind             text not null check (kind in ('repository_ownership', 'hosting_account', 'domain', 'database', 'third_party_account', 'signing_key', 'other')),
  from_party       text check (not projects.p7_has_secret(from_party)),
  to_party         text check (not projects.p7_has_secret(to_party)),
  method           text not null check (method in ('password_manager_share', 'ownership_transfer', 'sealed_envelope', 'in_person_or_call', 'provider_invite', 'not_applicable')),
  status           text not null default 'planned' check (status in ('planned', 'in_progress', 'completed', 'blocked', 'not_applicable')),
  temporary_credentials_rotated boolean not null default false,
  support_access_retained boolean not null default false,
  support_access_authorized_by uuid references core.users(id) on delete set null,
  evidence_ref     text check (not projects.p7_has_secret(evidence_ref)),
  note             text check (not projects.p7_has_secret(note)),
  updated_by       uuid references core.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  unique (package_id, system_name),
  check (status <> 'completed' or (evidence_ref is not null and length(btrim(evidence_ref)) > 0)),
  check (status <> 'not_applicable' or (note is not null and length(btrim(note)) > 0)),
  check (not support_access_retained or support_access_authorized_by is not null)
);

create table if not exists projects.p7_handover_reviews (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  package_id       uuid not null references projects.p7_handover_packages(id) on delete cascade,
  package_version  int not null,
  decision         text not null check (decision in ('approve', 'edit_requested')),
  note             text check (not projects.p7_has_secret(note)),
  decided_by       uuid not null references core.users(id) on delete restrict,
  decided_at       timestamptz not null default clock_timestamp(),
  check (decision = 'approve' or (note is not null and length(btrim(note)) > 0))
);

create table if not exists projects.p7_client_acceptances (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  package_id       uuid not null references projects.p7_handover_packages(id) on delete restrict,
  package_version  int not null,
  commit_ref       text not null,
  decision         text not null check (decision in ('accepted', 'changes_requested', 'disputed')),
  -- a formal record only: an informal "looks good" in a chat is not one of these
  evidence_kind    text not null check (evidence_kind in ('signed_document', 'portal_confirmation', 'email_reply', 'recorded_call', 'meeting_minutes')),
  evidence_ref     text not null check (length(btrim(evidence_ref)) > 0 and not projects.p7_has_secret(evidence_ref)),
  client_name      text not null check (length(btrim(client_name)) > 0 and not projects.p7_has_secret(client_name)),
  note             text check (not projects.p7_has_secret(note)),
  recorded_by      uuid not null references core.users(id) on delete restrict,
  recorded_at      timestamptz not null default clock_timestamp()
);

create table if not exists projects.p7_handover_feedback (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  package_id       uuid not null references projects.p7_handover_packages(id) on delete restrict,
  classification   text not null check (classification in ('handover_correction', 'production_defect', 'clarification', 'new_feature', 'scope_change', 'access_issue', 'support_question')),
  route            text not null check (route in ('handover_revision', 'support_bug', 'pm_clarification', 'change_request', 'client_action', 'customer_success')),
  body             text not null check (length(btrim(body)) > 0 and not projects.p7_has_secret(body)),
  status           text not null default 'open' check (status in ('open', 'resolved')),
  resolution       text check (not projects.p7_has_secret(resolution)),
  recorded_by      uuid references core.users(id) on delete set null,
  recorded_at      timestamptz not null default now(),
  resolved_by      uuid references core.users(id) on delete set null,
  resolved_at      timestamptz,
  check (status = 'open' or (resolution is not null and length(btrim(resolution)) > 0 and resolved_at is not null))
);

create table if not exists projects.p7_financial_exceptions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  kind             text not null check (kind in ('balance_outstanding', 'refund_pending', 'dispute', 'chargeback', 'adjustment')),
  amount_minor     bigint check (amount_minor is null or amount_minor >= 0),
  note             text not null check (length(btrim(note)) > 0 and not projects.p7_has_secret(note)),
  status           text not null default 'open' check (status in ('open', 'resolved', 'waived')),
  resolution       text check (not projects.p7_has_secret(resolution)),
  evidence_ref     text check (not projects.p7_has_secret(evidence_ref)),
  opened_by        uuid references core.users(id) on delete set null,
  opened_at        timestamptz not null default now(),
  decided_by       uuid references core.users(id) on delete set null,
  decided_at       timestamptz,
  check (status = 'open' or (resolution is not null and length(btrim(resolution)) > 0 and decided_by is not null and decided_at is not null)),
  -- a waiver is an Admin's written decision with evidence
  check (status <> 'waived' or (evidence_ref is not null and length(btrim(evidence_ref)) > 0))
);

create table if not exists projects.p7_completion_exceptions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  gate             text not null check (gate in ('scope_complete', 'client_acceptance')),
  package_id       uuid not null references projects.p7_handover_packages(id) on delete restrict,
  commit_ref       text not null,
  reason           text not null check (length(btrim(reason)) > 0 and not projects.p7_has_secret(reason)),
  risk             text not null check (length(btrim(risk)) > 0 and not projects.p7_has_secret(risk)),
  approved_by      uuid not null references core.users(id) on delete restrict,
  approved_at      timestamptz not null default clock_timestamp(),
  unique (project_id, gate, package_id)
);

create table if not exists projects.p7_completion_records (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  phase_seven_id    uuid not null references projects.phase_seven(id) on delete restrict,
  package_id        uuid not null references projects.p7_handover_packages(id) on delete restrict,
  acceptance_id     uuid references projects.p7_client_acceptances(id) on delete restrict,
  deployment_id     uuid not null references projects.p7_deployments(id) on delete restrict,
  validation_run_id uuid not null references projects.p7_validation_runs(id) on delete restrict,
  candidate_id      uuid not null references qa.release_candidates(id) on delete restrict,
  commit_ref        text not null,
  payload           jsonb not null,
  completed_by      uuid references core.users(id) on delete set null,
  completed_at      timestamptz not null default now(),
  unique (project_id)
);

-- the Phase 8 / Customer Success intake: a frozen snapshot written with ProjectCompleted (the same shape as the Phase 5 and Phase 6 handoffs)
create table if not exists projects.phase_seven_handoffs (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  completion_record_id  uuid not null references projects.p7_completion_records(id) on delete restrict,
  commit_ref            text not null,
  payload               jsonb not null,
  phase8_ready          boolean not null default true check (phase8_ready),
  created_at            timestamptz not null default now(),
  unique (project_id)
);

-- ── guards ─────────────────────────────────────────────────────────────────
create or replace function projects.p7_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then raise exception '% is a completed project''s history and is never edited or deleted', tg_table_name using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception '% is written through its Phase 7 door', tg_table_name using errcode = 'restrict_violation'; end if;
  return new;
end $$;

-- a package's identity is fixed; its content is editable only while it is a draft; its status moves only along the governed edges
create or replace function projects.p7_package_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a handover package version is never deleted: an old version is preserved' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception 'a handover package changes through its doors, never by a direct statement' using errcode = 'restrict_violation'; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then raise exception 'a package version is born a draft' using errcode = 'restrict_violation'; end if;
    return new;
  end if;
  if new.project_id is distinct from old.project_id or new.version is distinct from old.version or new.deployment_id is distinct from old.deployment_id
     or new.validation_run_id is distinct from old.validation_run_id or new.commit_ref is distinct from old.commit_ref or new.artifact_sha256 is distinct from old.artifact_sha256
     or new.candidate_id is distinct from old.candidate_id then
    raise exception 'a package version is about one exact release and keeps it' using errcode = 'restrict_violation';
  end if;
  if old.status <> 'draft' and (new.production_url is distinct from old.production_url or new.support_terms is distinct from old.support_terms or new.warranty_ends_on is distinct from old.warranty_ends_on
     or new.emergency_contacts is distinct from old.emergency_contacts or new.disclosed_limitation_ids is distinct from old.disclosed_limitation_ids) then
    raise exception 'a package version that left draft is not overwritten: an edit is a new version' using errcode = 'restrict_violation';
  end if;
  if new.status is distinct from old.status and not ((old.status, new.status) in (('draft', 'admin_review'), ('admin_review', 'approved'), ('admin_review', 'changes_requested'), ('approved', 'delivered'),
        ('delivered', 'changes_requested'), ('draft', 'superseded'), ('admin_review', 'superseded'), ('changes_requested', 'superseded'), ('approved', 'superseded'), ('delivered', 'superseded'))) then
    raise exception 'a handover package does not go from % to %: only an Admin-approved version is delivered', old.status, new.status using errcode = 'restrict_violation';
  end if;
  if new.status = 'approved' and old.status <> 'approved' and new.admin_approved_by is null then raise exception 'a package is approved by an Admin' using errcode = 'restrict_violation'; end if;
  return new;
end $$;
drop trigger if exists p7_package_guard on projects.p7_handover_packages;
create trigger p7_package_guard before insert or update or delete on projects.p7_handover_packages for each row execute function projects.p7_package_guard();

create or replace function projects.p7_package_child_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_status text; v_pkg uuid;
begin
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception '% is written through its Phase 7 door', tg_table_name using errcode = 'restrict_violation'; end if;
  v_pkg := coalesce(new.package_id, old.package_id);
  select p.status into v_status from projects.p7_handover_packages p where p.id = v_pkg;
  if tg_op = 'DELETE' then raise exception '% rows are preserved with their package version', tg_table_name using errcode = 'restrict_violation'; end if;
  if v_status is distinct from 'draft' then raise exception 'a package version that left draft is not overwritten: an edit is a new version' using errcode = 'restrict_violation'; end if;
  return new;
end $$;
drop trigger if exists p7_items_guard on projects.p7_handover_items;
create trigger p7_items_guard before insert or update or delete on projects.p7_handover_items for each row execute function projects.p7_package_child_guard();
drop trigger if exists p7_transfers_guard on projects.p7_access_transfers;
create trigger p7_transfers_guard before insert or update or delete on projects.p7_access_transfers for each row execute function projects.p7_package_child_guard();

-- completion exceptions and financial exceptions: no deletion; a decided financial exception is final
create or replace function projects.p7_financial_exception_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a financial exception is audit history' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception 'a financial exception changes through its doors' using errcode = 'restrict_violation'; end if;
  if tg_op = 'UPDATE' and (old.status <> 'open' or new.kind is distinct from old.kind or new.amount_minor is distinct from old.amount_minor or new.note is distinct from old.note) then
    raise exception 'a decided financial exception is history' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p7_financial_exception_guard on projects.p7_financial_exceptions;
create trigger p7_financial_exception_guard before insert or update or delete on projects.p7_financial_exceptions for each row execute function projects.p7_financial_exception_guard();

create or replace function projects.p7_feedback_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'handover feedback is history and is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception 'handover feedback is written through its doors' using errcode = 'restrict_violation'; end if;
  if tg_op = 'UPDATE' and (old.status <> 'open' or new.body is distinct from old.body or new.classification is distinct from old.classification or new.package_id is distinct from old.package_id) then
    raise exception 'resolved handover feedback is history' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p7_feedback_guard on projects.p7_handover_feedback;
create trigger p7_feedback_guard before insert or update or delete on projects.p7_handover_feedback for each row execute function projects.p7_feedback_guard();

do $$
declare t text;
begin
  for t in select unnest(array['p7_contract_deliverables', 'p7_handover_packages', 'p7_handover_items', 'p7_access_transfers', 'p7_handover_reviews', 'p7_client_acceptances', 'p7_handover_feedback',
                               'p7_financial_exceptions', 'p7_completion_exceptions', 'p7_completion_records', 'phase_seven_handoffs']) loop
    perform projects.p7_harden('projects', t);
  end loop;
  perform projects.p7_guard_fk('p7_contract_deliverables', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_handover_packages', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_handover_packages', 'phase_seven_id', 'projects.phase_seven');
  perform projects.p7_guard_fk('p7_handover_packages', 'deployment_id', 'projects.p7_deployments');
  perform projects.p7_guard_fk('p7_handover_packages', 'validation_run_id', 'projects.p7_validation_runs');
  perform projects.p7_guard_fk('p7_handover_packages', 'candidate_id', 'qa.release_candidates');
  perform projects.p7_guard_fk('p7_handover_packages', 'supersedes_id', 'projects.p7_handover_packages');
  perform projects.p7_guard_fk('p7_handover_items', 'package_id', 'projects.p7_handover_packages');
  perform projects.p7_guard_fk('p7_access_transfers', 'package_id', 'projects.p7_handover_packages');
  perform projects.p7_guard_fk('p7_handover_reviews', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_handover_reviews', 'package_id', 'projects.p7_handover_packages');
  perform projects.p7_guard_fk('p7_client_acceptances', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_client_acceptances', 'package_id', 'projects.p7_handover_packages');
  perform projects.p7_guard_fk('p7_handover_feedback', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_handover_feedback', 'package_id', 'projects.p7_handover_packages');
  perform projects.p7_guard_fk('p7_financial_exceptions', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_completion_exceptions', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_completion_exceptions', 'package_id', 'projects.p7_handover_packages');
  perform projects.p7_guard_fk('p7_completion_records', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('p7_completion_records', 'phase_seven_id', 'projects.phase_seven');
  perform projects.p7_guard_fk('p7_completion_records', 'package_id', 'projects.p7_handover_packages');
  perform projects.p7_guard_fk('p7_completion_records', 'acceptance_id', 'projects.p7_client_acceptances');
  perform projects.p7_guard_fk('p7_completion_records', 'deployment_id', 'projects.p7_deployments');
  perform projects.p7_guard_fk('p7_completion_records', 'validation_run_id', 'projects.p7_validation_runs');
  perform projects.p7_guard_fk('p7_completion_records', 'candidate_id', 'qa.release_candidates');
  perform projects.p7_guard_fk('phase_seven_handoffs', 'project_id', 'projects.projects');
  perform projects.p7_guard_fk('phase_seven_handoffs', 'completion_record_id', 'projects.p7_completion_records');
  for t in select unnest(array['p7_handover_reviews', 'p7_client_acceptances', 'p7_completion_exceptions']) loop
    execute format('drop trigger if exists %I on projects.%I', t || '_append_only', t);
    execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p7_append_only()', t || '_append_only', t);
  end loop;
  for t in select unnest(array['p7_completion_records', 'phase_seven_handoffs']) loop
    execute format('drop trigger if exists %I on projects.%I', t || '_frozen', t);
    execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p7_frozen()', t || '_frozen', t);
  end loop;
  execute 'drop trigger if exists p7_contract_deliverables_door_only on projects.p7_contract_deliverables';
  execute 'create trigger p7_contract_deliverables_door_only before insert or update or delete on projects.p7_contract_deliverables for each row execute function projects.p7_door_only()';
end $$;

insert into core.event_types (type, description, canonical) values
  ('project.handover_admin_review_requested', 'A complete handover package version (every contractual item accounted for, access transferred by reference, limitations disclosed) waits for an Admin.', true),
  ('project.handover_approved', 'An Admin approved this exact handover package version. Only an approved version may be delivered to the client.', true),
  ('project.handover_delivered', 'The Admin-approved handover package was delivered to the client for review. Delivery is not acceptance.', true),
  ('project.client_handover_accepted', 'The client formally accepted this exact handover package version (recorded by staff with evidence). The completion gate is evaluated next.', true),
  ('project.client_handover_changes_requested', 'The client asked for changes, or disputed, the delivered handover package: a corrected version is needed.', true),
  ('project.completed', 'ProjectCompleted: the completion gate passed (production validated, handover accepted, final payment cleared). One immutable completion record and a Customer Success intake exist.', true)
on conflict (type) do nothing;

-- ── contract deliverables and the package ──────────────────────────────────
create or replace function projects.record_contract_deliverable(p_project_id uuid, p_kind text, p_label text, p_required boolean, p_exclusion_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_kind not in ('source_repository', 'deployment_docs', 'config_docs', 'db_docs', 'api_docs', 'admin_guide', 'user_guide', 'invoices_receipts', 'training') then return query select 'bad_kind'::text; return; end if;
  if p_label is null or length(btrim(p_label)) = 0 then return query select 'label_required'::text; return; end if;
  if not coalesce(p_required, true) and (p_exclusion_reason is null or length(btrim(p_exclusion_reason)) = 0) then return query select 'exclusion_reason_required'::text; return; end if;
  if projects.p7_has_secret(p_label) or projects.p7_has_secret(p_exclusion_reason) then return query select 'contains_secret'::text; return; end if;
  if not exists (select 1 from projects.phase_seven s where s.project_id = p_project_id and s.organization_id = v_org) then return query select 'not_found'::text; return; end if;
  if exists (select 1 from projects.p7_handover_packages p where p.project_id = p_project_id and p.status in ('approved', 'delivered')) then return query select 'package_already_approved'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_contract_deliverables (organization_id, project_id, kind, label, required, exclusion_reason, recorded_by)
  values (v_org, p_project_id, p_kind, btrim(p_label), coalesce(p_required, true), p_exclusion_reason, v_actor)
  on conflict (project_id, kind) do update set label = excluded.label, required = excluded.required, exclusion_reason = excluded.exclusion_reason, recorded_by = excluded.recorded_by, recorded_at = now();
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_contract_deliverable(uuid, text, text, boolean, text) from public, anon;
grant execute on function projects.record_contract_deliverable(uuid, text, text, boolean, text) to authenticated;

create or replace function projects.create_handover_package(p_project_id uuid, p_production_url text default null, p_support_terms text default null, p_warranty_ends_on date default null, p_emergency_contacts text default null)
returns table (outcome text, package_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_s projects.phase_seven; v_v record; v_existing uuid; v_new uuid; v_next int; c record;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_production_url) or projects.p7_has_secret(p_support_terms) or projects.p7_has_secret(p_emergency_contacts) then return query select 'contains_secret'::text, null::uuid; return; end if;
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id and s.organization_id = v_org for update;
  if v_s.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  select p.id into v_existing from projects.p7_handover_packages p where p.project_id = p_project_id and p.status in ('draft', 'admin_review', 'changes_requested', 'approved', 'delivered');
  if v_existing is not null then return query select 'already_exists'::text, v_existing; return; end if;
  -- the handover is for the exact PRODUCTION-VALIDATED release
  select * into v_v from projects.p7_production_validation(p_project_id);
  if v_v.deployment_id is null then return query select 'production_not_validated'::text, null::uuid; return; end if;
  if not projects.m4_verified_paid(p_project_id) then return query select 'm4_not_verified'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.p7_contract_deliverables d where d.project_id = p_project_id) then return query select 'contract_deliverables_missing'::text, null::uuid; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  select coalesce(max(version), 0) + 1 into v_next from projects.p7_handover_packages where project_id = p_project_id;
  insert into projects.p7_handover_packages (organization_id, project_id, phase_seven_id, version, deployment_id, validation_run_id, candidate_id, commit_ref, artifact_sha256, production_url, support_terms, warranty_ends_on, emergency_contacts, created_by)
  values (v_org, p_project_id, v_s.id, v_next, v_v.deployment_id, v_v.run_id, v_s.candidate_id, v_s.commit_ref, v_s.artifact_sha256, nullif(btrim(p_production_url), ''), nullif(btrim(p_support_terms), ''), p_warranty_ends_on, nullif(btrim(p_emergency_contacts), ''), v_actor)
  returning id into v_new;
  -- the always-required items, then one item per contract deliverable (a contract exclusion is NOT_REQUIRED with its reason, never silently dropped)
  insert into projects.p7_handover_items (organization_id, package_id, kind, label, required, updated_by)
  select v_org, v_new, k.kind, k.label, true, v_actor from (values ('scope', 'Final approved scope'), ('release', 'Release / build / version'), ('production_url', 'Production URL and environment'),
         ('known_limitations', 'Known limitations'), ('support_warranty', 'Support and warranty terms'), ('emergency_contacts', 'Emergency and support contacts')) as k(kind, label);
  for c in select * from projects.p7_contract_deliverables d where d.project_id = p_project_id loop
    insert into projects.p7_handover_items (organization_id, package_id, kind, label, required, status, reason, updated_by)
    values (v_org, v_new, c.kind, c.label, c.required, case when c.required then 'pending' else 'not_required' end, case when c.required then null else c.exclusion_reason end, v_actor);
  end loop;
  perform projects.p7_set_state(p_project_id, 'handover_preparing');
  perform core.record_audit(v_org, 'handover_package.created', 'handover_package', v_new, null, jsonb_build_object('projectId', p_project_id, 'version', v_next, 'deploymentId', v_v.deployment_id));
  return query select 'created'::text, v_new;
end $$;
revoke all on function projects.create_handover_package(uuid, text, text, date, text) from public, anon;
grant execute on function projects.create_handover_package(uuid, text, text, date, text) to authenticated;

create or replace function projects.update_handover_package(p_package_id uuid, p_production_url text, p_support_terms text, p_warranty_ends_on date, p_emergency_contacts text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.p7_handover_packages;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if projects.p7_has_secret(p_production_url) or projects.p7_has_secret(p_support_terms) or projects.p7_has_secret(p_emergency_contacts) then return query select 'contains_secret'::text; return; end if;
  select * into v_p from projects.p7_handover_packages p where p.id = p_package_id and p.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if v_p.status <> 'draft' then return query select 'package_frozen'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_handover_packages set production_url = nullif(btrim(p_production_url), ''), support_terms = nullif(btrim(p_support_terms), ''), warranty_ends_on = p_warranty_ends_on, emergency_contacts = nullif(btrim(p_emergency_contacts), '') where id = p_package_id;
  return query select 'updated'::text;
end $$;
revoke all on function projects.update_handover_package(uuid, text, text, date, text) from public, anon;
grant execute on function projects.update_handover_package(uuid, text, text, date, text) to authenticated;

create or replace function projects.set_handover_item(p_package_id uuid, p_kind text, p_status text, p_artifact_ref text default null, p_evidence_ref text default null, p_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.p7_handover_packages; v_i projects.p7_handover_items;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_status not in ('pending', 'ready') then return query select 'bad_status'::text; return; end if;
  -- a credential-looking value never enters a package note or reference
  if projects.p7_has_secret(p_artifact_ref) or projects.p7_has_secret(p_evidence_ref) or projects.p7_has_secret(p_reason) then return query select 'contains_secret'::text; return; end if;
  select * into v_p from projects.p7_handover_packages p where p.id = p_package_id and p.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if v_p.status <> 'draft' then return query select 'package_frozen'::text; return; end if;
  select * into v_i from projects.p7_handover_items i where i.package_id = p_package_id and i.kind = p_kind;
  if v_i.id is null then return query select 'no_such_item'::text; return; end if;
  if v_i.status = 'not_required' then return query select 'item_not_required_by_contract'::text; return; end if;
  if p_status = 'ready' and (p_artifact_ref is null or length(btrim(p_artifact_ref)) = 0) then return query select 'artifact_ref_required'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_handover_items set status = p_status, artifact_ref = nullif(btrim(p_artifact_ref), ''), evidence_ref = nullif(btrim(p_evidence_ref), ''), reason = nullif(btrim(p_reason), ''), updated_by = v_actor, updated_at = now() where id = v_i.id;
  return query select 'recorded'::text;
end $$;
revoke all on function projects.set_handover_item(uuid, text, text, text, text, text) from public, anon;
grant execute on function projects.set_handover_item(uuid, text, text, text, text, text) to authenticated;

create or replace function projects.record_access_transfer(p_package_id uuid, p_system_name text, p_kind text, p_method text, p_status text, p_from_party text default null, p_to_party text default null,
                                                           p_evidence_ref text default null, p_credentials_rotated boolean default false, p_support_access_retained boolean default false,
                                                           p_support_access_authorized boolean default false, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.p7_handover_packages;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_system_name is null or length(btrim(p_system_name)) = 0 then return query select 'system_required'::text; return; end if;
  if p_kind not in ('repository_ownership', 'hosting_account', 'domain', 'database', 'third_party_account', 'signing_key', 'other') then return query select 'bad_kind'::text; return; end if;
  if p_method not in ('password_manager_share', 'ownership_transfer', 'sealed_envelope', 'in_person_or_call', 'provider_invite', 'not_applicable') then return query select 'bad_method'::text; return; end if;
  if p_status not in ('planned', 'in_progress', 'completed', 'blocked', 'not_applicable') then return query select 'bad_status'::text; return; end if;
  -- THE RULE: this table records THAT a credential was transferred and HOW, never the value
  if projects.p7_has_secret(p_system_name) or projects.p7_has_secret(p_from_party) or projects.p7_has_secret(p_to_party) or projects.p7_has_secret(p_evidence_ref) or projects.p7_has_secret(p_note) then
    return query select 'contains_secret'::text; return;
  end if;
  if p_status = 'completed' and (p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0) then return query select 'evidence_required'::text; return; end if;
  if p_status = 'not_applicable' and (p_note is null or length(btrim(p_note)) = 0) then return query select 'note_required'::text; return; end if;
  -- support access stays only when someone with authority said so (an Admin), never by default
  if coalesce(p_support_access_retained, false) and not (coalesce(p_support_access_authorized, false) and coalesce((select core.is_admin()), false)) then return query select 'support_access_needs_admin_authorization'::text; return; end if;
  select * into v_p from projects.p7_handover_packages p where p.id = p_package_id and p.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if v_p.status <> 'draft' then return query select 'package_frozen'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_access_transfers (organization_id, package_id, system_name, kind, from_party, to_party, method, status, temporary_credentials_rotated, support_access_retained, support_access_authorized_by, evidence_ref, note, updated_by)
  values (v_org, p_package_id, btrim(p_system_name), p_kind, p_from_party, p_to_party, p_method, p_status, coalesce(p_credentials_rotated, false), coalesce(p_support_access_retained, false),
          case when coalesce(p_support_access_retained, false) then v_actor end, p_evidence_ref, p_note, v_actor)
  on conflict (package_id, system_name) do update set kind = excluded.kind, from_party = excluded.from_party, to_party = excluded.to_party, method = excluded.method, status = excluded.status,
         temporary_credentials_rotated = excluded.temporary_credentials_rotated, support_access_retained = excluded.support_access_retained, support_access_authorized_by = excluded.support_access_authorized_by,
         evidence_ref = excluded.evidence_ref, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_access_transfer(uuid, text, text, text, text, text, text, text, boolean, boolean, boolean, text) from public, anon;
grant execute on function projects.record_access_transfer(uuid, text, text, text, text, text, text, text, boolean, boolean, boolean, text) to authenticated;

-- ── completeness (P707 §7), read from rows ─────────────────────────────────
create or replace function projects.p7_handover_completeness(p_package_id uuid)
returns table (gate text, satisfied boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_p projects.p7_handover_packages; v_n int; v_cur record; v_all uuid[]; v_missing uuid[];
begin
  select * into v_p from projects.p7_handover_packages p where p.id = p_package_id;
  if v_p.id is null then return; end if;
  if not v_service and (v_actor is null or v_p.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;

  select * into v_cur from projects.p7_production_validation(v_p.project_id);
  gate := 'production_release_current'; satisfied := v_cur.run_id is not distinct from v_p.validation_run_id and v_cur.run_id is not null;
  detail := case when satisfied then 'the package is about the release that is validated in production now' else 'the validated production release changed (or is no longer validated) since this package version' end;
  return next;

  gate := 'm4_verified'; satisfied := projects.m4_verified_paid(v_p.project_id);
  detail := case when satisfied then 'M4 is verified paid in full' else 'M4 is not verified paid' end;
  return next;

  select count(*) into v_n from projects.p7_handover_items i where i.package_id = p_package_id and i.required and i.status <> 'ready';
  gate := 'contract_items'; satisfied := v_n = 0 and exists (select 1 from projects.p7_handover_items i where i.package_id = p_package_id);
  detail := case when satisfied then 'every contractual item is accounted for (ready, or excluded by the contract with a reason)' else format('%s required item(s) are not ready (a missing contractual deliverable blocks the package)', v_n) end;
  return next;

  select coalesce(array_agg(l.id), '{}') into v_all from projects.p7_known_limitations l where l.project_id = v_p.project_id;
  select coalesce(array_agg(x), '{}') into v_missing from unnest(v_all) x where not (x = any (v_p.disclosed_limitation_ids));
  gate := 'limitations_disclosed'; satisfied := cardinality(v_missing) = 0;
  detail := case when satisfied then 'every known limitation is disclosed in this package version' else format('%s known limitation(s) are not disclosed in this package version', cardinality(v_missing)) end;
  return next;

  select count(*) into v_n from projects.p7_access_transfers t where t.package_id = p_package_id and t.status not in ('completed', 'not_applicable');
  gate := 'access_transfer'; satisfied := v_n = 0 and exists (select 1 from projects.p7_access_transfers t where t.package_id = p_package_id);
  detail := case when satisfied then 'access transfer is recorded by reference for every system and none is outstanding' when v_n > 0 then format('%s access transfer(s) are not completed', v_n) else 'no access-transfer record exists (the access documentation is missing)' end;
  return next;

  gate := 'support_warranty'; satisfied := length(btrim(coalesce(v_p.support_terms, ''))) > 0 and v_p.warranty_ends_on is not null and length(btrim(coalesce(v_p.emergency_contacts, ''))) > 0 and length(btrim(coalesce(v_p.production_url, ''))) > 0;
  detail := case when satisfied then 'production URL, support/warranty terms and emergency contacts are recorded' else 'the production URL, the support/warranty terms (with an end date) or the emergency contacts are missing' end;
  return next;
end $$;
revoke all on function projects.p7_handover_completeness(uuid) from public, anon;
grant execute on function projects.p7_handover_completeness(uuid) to authenticated, service_role;

create or replace function projects.submit_handover_for_review(p_package_id uuid)
returns table (outcome text, missing text[])
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.p7_handover_packages; v_missing text[];
begin
  if v_actor is null then return query select 'no_actor'::text, '{}'::text[]; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, '{}'::text[]; return; end if;
  select * into v_p from projects.p7_handover_packages p where p.id = p_package_id and p.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text, '{}'::text[]; return; end if;
  if v_p.status <> 'draft' then return query select 'wrong_state'::text, '{}'::text[]; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  -- every known limitation at this moment is disclosed in this version: a package cannot silently omit one
  update projects.p7_handover_packages set disclosed_limitation_ids = coalesce((select array_agg(l.id) from projects.p7_known_limitations l where l.project_id = v_p.project_id), '{}') where id = p_package_id;
  select coalesce(array_agg(g.gate || ': ' || g.detail order by g.gate), '{}') into v_missing from projects.p7_handover_completeness(p_package_id) g where not g.satisfied;
  if cardinality(v_missing) > 0 then
    -- not complete: undo the disclosure stamp is unnecessary (still a draft), but nothing moves
    return query select 'incomplete'::text, v_missing; return;
  end if;
  update projects.p7_handover_packages set status = 'admin_review' where id = p_package_id;
  perform projects.p7_set_state(v_p.project_id, 'admin_handover_review');
  perform core.record_audit(v_org, 'handover_package.review_requested', 'handover_package', p_package_id, null, jsonb_build_object('projectId', v_p.project_id, 'version', v_p.version));
  perform core.emit_event(v_org, 'project.handover_admin_review_requested', 'handover_package', p_package_id, jsonb_build_object('projectId', v_p.project_id, 'version', v_p.version));
  return query select 'submitted'::text, '{}'::text[];
end $$;
revoke all on function projects.submit_handover_for_review(uuid) from public, anon;
grant execute on function projects.submit_handover_for_review(uuid) to authenticated;

create or replace function projects.decide_handover_package(p_package_id uuid, p_decision text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.p7_handover_packages; v_gaps int;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('approve', 'edit_requested') then return query select 'bad_decision'::text; return; end if;
  if p_decision = 'edit_requested' and (p_note is null or length(btrim(p_note)) = 0) then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_p from projects.p7_handover_packages p where p.id = p_package_id and p.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if v_p.status <> 'admin_review' then return query select 'wrong_state'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  if p_decision = 'approve' then
    -- the exact version is re-checked at the moment of approval
    select count(*) into v_gaps from projects.p7_handover_completeness(p_package_id) g where not g.satisfied;
    if v_gaps > 0 then return query select 'incomplete'::text; return; end if;
    update projects.p7_handover_packages set status = 'approved', admin_approved_by = v_actor, admin_approved_at = clock_timestamp() where id = p_package_id;
    insert into projects.p7_handover_reviews (organization_id, project_id, package_id, package_version, decision, note, decided_by) values (v_org, v_p.project_id, p_package_id, v_p.version, 'approve', p_note, v_actor);
    perform projects.p7_set_state(v_p.project_id, 'handover_ready');
    perform core.record_audit(v_org, 'handover_package.approved', 'handover_package', p_package_id, null, jsonb_build_object('projectId', v_p.project_id, 'version', v_p.version));
    perform core.emit_event(v_org, 'project.handover_approved', 'handover_package', p_package_id, jsonb_build_object('projectId', v_p.project_id, 'version', v_p.version));
    return query select 'approved'::text; return;
  end if;
  update projects.p7_handover_packages set status = 'changes_requested' where id = p_package_id;
  insert into projects.p7_handover_reviews (organization_id, project_id, package_id, package_version, decision, note, decided_by) values (v_org, v_p.project_id, p_package_id, v_p.version, 'edit_requested', p_note, v_actor);
  perform projects.p7_set_state(v_p.project_id, 'handover_preparing');
  perform core.record_audit(v_org, 'handover_package.edit_requested', 'handover_package', p_package_id, null, jsonb_build_object('projectId', v_p.project_id, 'version', v_p.version));
  return query select 'edit_requested'::text;
end $$;
revoke all on function projects.decide_handover_package(uuid, text, text) from public, anon;
grant execute on function projects.decide_handover_package(uuid, text, text) to authenticated;

-- an edit (or a client correction) is a NEW version: the old one is preserved, superseded, never overwritten
create or replace function projects.revise_handover_package(p_package_id uuid)
returns table (outcome text, package_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.p7_handover_packages; v_v record; v_new uuid; v_next int; v_s projects.phase_seven;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_p from projects.p7_handover_packages p where p.id = p_package_id and p.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_p.status not in ('changes_requested', 'delivered', 'approved') then return query select 'wrong_state'::text, null::uuid; return; end if;
  select * into v_s from projects.phase_seven s where s.project_id = v_p.project_id for update;
  select * into v_v from projects.p7_production_validation(v_p.project_id);
  if v_v.deployment_id is null then return query select 'production_not_validated'::text, null::uuid; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_handover_packages set status = 'superseded' where id = p_package_id;
  select coalesce(max(version), 0) + 1 into v_next from projects.p7_handover_packages where project_id = v_p.project_id;
  insert into projects.p7_handover_packages (organization_id, project_id, phase_seven_id, version, deployment_id, validation_run_id, candidate_id, commit_ref, artifact_sha256, production_url, support_terms, warranty_ends_on, emergency_contacts, supersedes_id, created_by)
  values (v_org, v_p.project_id, v_p.phase_seven_id, v_next, v_v.deployment_id, v_v.run_id, v_s.candidate_id, v_s.commit_ref, v_s.artifact_sha256, v_p.production_url, v_p.support_terms, v_p.warranty_ends_on, v_p.emergency_contacts, v_p.id, v_actor)
  returning id into v_new;
  insert into projects.p7_handover_items (organization_id, package_id, kind, label, required, status, artifact_ref, evidence_ref, reason, updated_by)
    select v_org, v_new, i.kind, i.label, i.required, i.status, i.artifact_ref, i.evidence_ref, i.reason, v_actor from projects.p7_handover_items i where i.package_id = p_package_id;
  insert into projects.p7_access_transfers (organization_id, package_id, system_name, kind, from_party, to_party, method, status, temporary_credentials_rotated, support_access_retained, support_access_authorized_by, evidence_ref, note, updated_by)
    select v_org, v_new, t.system_name, t.kind, t.from_party, t.to_party, t.method, t.status, t.temporary_credentials_rotated, t.support_access_retained, t.support_access_authorized_by, t.evidence_ref, t.note, v_actor
      from projects.p7_access_transfers t where t.package_id = p_package_id;
  perform projects.p7_set_state(v_p.project_id, 'handover_preparing');
  perform core.record_audit(v_org, 'handover_package.revised', 'handover_package', v_new, null, jsonb_build_object('projectId', v_p.project_id, 'version', v_next, 'supersedes', p_package_id));
  return query select 'revised'::text, v_new;
end $$;
revoke all on function projects.revise_handover_package(uuid) from public, anon;
grant execute on function projects.revise_handover_package(uuid) to authenticated;

create or replace function projects.deliver_handover_package(p_package_id uuid, p_channel text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.p7_handover_packages;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_channel is null or length(btrim(p_channel)) = 0 then return query select 'channel_required'::text; return; end if;
  if projects.p7_has_secret(p_channel) then return query select 'contains_secret'::text; return; end if;
  select * into v_p from projects.p7_handover_packages p where p.id = p_package_id and p.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if v_p.status = 'delivered' then return query select 'already_delivered'::text; return; end if;
  -- ONLY an Admin-approved version reaches the client
  if v_p.status <> 'approved' then return query select 'not_admin_approved'::text; return; end if;
  if (select count(*) from projects.p7_handover_completeness(p_package_id) g where not g.satisfied) > 0 then return query select 'incomplete'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_handover_packages set status = 'delivered', delivered_by = v_actor, delivered_at = clock_timestamp(), delivery_channel = btrim(p_channel) where id = p_package_id;
  perform projects.p7_set_state(v_p.project_id, 'client_handover_review');
  perform core.record_audit(v_org, 'handover_package.delivered', 'handover_package', p_package_id, null, jsonb_build_object('projectId', v_p.project_id, 'version', v_p.version));
  perform core.emit_event(v_org, 'project.handover_delivered', 'handover_package', p_package_id, jsonb_build_object('projectId', v_p.project_id, 'version', v_p.version));
  return query select 'delivered'::text;
end $$;
revoke all on function projects.deliver_handover_package(uuid, text) from public, anon;
grant execute on function projects.deliver_handover_package(uuid, text) to authenticated;

-- ── client acceptance: recorded by staff, with evidence, for the EXACT version ──
create or replace function projects.record_client_acceptance(p_package_id uuid, p_decision text, p_evidence_kind text, p_evidence_ref text, p_client_name text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.p7_handover_packages;
begin
  -- the CLIENT accepts; staff RECORD it. An agent (no signed-in person) can never record an acceptance.
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('accepted', 'changes_requested', 'disputed') then return query select 'bad_decision'::text; return; end if;
  if p_evidence_kind in ('informal_chat', 'chat', 'whatsapp', 'verbal') then return query select 'informal_is_not_acceptance'::text; return; end if;
  if p_evidence_kind not in ('signed_document', 'portal_confirmation', 'email_reply', 'recorded_call', 'meeting_minutes') then return query select 'bad_evidence_kind'::text; return; end if;
  if p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0 then return query select 'evidence_required'::text; return; end if;
  if p_client_name is null or length(btrim(p_client_name)) = 0 then return query select 'client_name_required'::text; return; end if;
  if projects.p7_has_secret(p_evidence_ref) or projects.p7_has_secret(p_client_name) or projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_p from projects.p7_handover_packages p where p.id = p_package_id and p.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  -- acceptance of an older version never approves a newer one; only the CURRENT delivered version can be accepted
  if v_p.status = 'superseded' then return query select 'package_superseded'::text; return; end if;
  if v_p.status <> 'delivered' then return query select 'package_not_delivered'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_client_acceptances (organization_id, project_id, package_id, package_version, commit_ref, decision, evidence_kind, evidence_ref, client_name, note, recorded_by)
  values (v_org, v_p.project_id, p_package_id, v_p.version, v_p.commit_ref, p_decision, p_evidence_kind, btrim(p_evidence_ref), btrim(p_client_name), p_note, v_actor);
  if p_decision = 'accepted' then
    perform projects.p7_set_state(v_p.project_id, 'client_accepted');
    perform core.emit_event(v_org, 'project.client_handover_accepted', 'handover_package', p_package_id, jsonb_build_object('projectId', v_p.project_id, 'version', v_p.version));
  else
    perform projects.p7_set_state(v_p.project_id, case p_decision when 'disputed' then 'client_action_required' else 'handover_preparing' end);
    if p_decision = 'changes_requested' then update projects.p7_handover_packages set status = 'changes_requested' where id = p_package_id; end if;
    perform core.emit_event(v_org, 'project.client_handover_changes_requested', 'handover_package', p_package_id, jsonb_build_object('projectId', v_p.project_id, 'version', v_p.version));
  end if;
  perform core.record_audit(v_org, 'handover_acceptance.' || p_decision, 'handover_package', p_package_id, null, jsonb_build_object('projectId', v_p.project_id, 'version', v_p.version, 'evidenceKind', p_evidence_kind));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_client_acceptance(uuid, text, text, text, text, text) from public, anon;
grant execute on function projects.record_client_acceptance(uuid, text, text, text, text, text) to authenticated;

create or replace function projects.set_acceptance_policy(p_project_id uuid, p_required boolean, p_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if not coalesce(p_required, true) and (p_reason is null or length(btrim(p_reason)) = 0) then return query select 'reason_required'::text; return; end if;
  if projects.p7_has_secret(p_reason) then return query select 'contains_secret'::text; return; end if;
  if not exists (select 1 from projects.phase_seven s where s.project_id = p_project_id and s.organization_id = v_org) then return query select 'not_found'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.phase_seven set client_acceptance_required = coalesce(p_required, true), acceptance_waiver_reason = case when coalesce(p_required, true) then null else btrim(p_reason) end,
         acceptance_waived_by = case when coalesce(p_required, true) then null else v_actor end where project_id = p_project_id;
  perform core.record_audit(v_org, 'phase_seven.acceptance_policy', 'phase_seven', (select id from projects.phase_seven where project_id = p_project_id), null, jsonb_build_object('required', coalesce(p_required, true), 'reason', p_reason));
  return query select 'set'::text;
end $$;
revoke all on function projects.set_acceptance_policy(uuid, boolean, text) from public, anon;
grant execute on function projects.set_acceptance_policy(uuid, boolean, text) to authenticated;

-- ── feedback classification (P702 §9, P707 §10, P708): a correction, a defect, a change and a question are routed differently ──
create or replace function projects.p7_feedback_route(p_classification text)
returns text language sql immutable set search_path = '' as $$
  select case p_classification
    when 'handover_correction' then 'handover_revision' when 'production_defect' then 'support_bug' when 'clarification' then 'pm_clarification'
    when 'new_feature' then 'change_request' when 'scope_change' then 'change_request' when 'access_issue' then 'client_action' when 'support_question' then 'customer_success' end
$$;
revoke all on function projects.p7_feedback_route(text) from public, anon;
grant execute on function projects.p7_feedback_route(text) to authenticated, service_role;

create or replace function projects.record_handover_feedback(p_package_id uuid, p_classification text, p_body text)
returns table (outcome text, route text, feedback_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.p7_handover_packages; v_route text; v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::text, null::uuid; return; end if;
  v_route := projects.p7_feedback_route(p_classification);
  if v_route is null then return query select 'bad_classification'::text, null::text, null::uuid; return; end if;
  if p_body is null or length(btrim(p_body)) = 0 then return query select 'body_required'::text, null::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_body) then return query select 'contains_secret'::text, null::text, null::uuid; return; end if;
  select * into v_p from projects.p7_handover_packages p where p.id = p_package_id and p.organization_id = v_org;
  if v_p.id is null then return query select 'not_found'::text, null::text, null::uuid; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_handover_feedback (organization_id, project_id, package_id, classification, route, body, recorded_by) values (v_org, v_p.project_id, p_package_id, p_classification, v_route, btrim(p_body), v_actor) returning id into v_new;
  if p_classification = 'access_issue' then perform projects.p7_set_state(v_p.project_id, 'client_action_required'); end if;
  perform core.record_audit(v_org, 'handover_feedback.recorded', 'handover_package', p_package_id, null, jsonb_build_object('projectId', v_p.project_id, 'classification', p_classification, 'route', v_route));
  return query select 'recorded'::text, v_route, v_new;
end $$;
revoke all on function projects.record_handover_feedback(uuid, text, text) from public, anon;
grant execute on function projects.record_handover_feedback(uuid, text, text) to authenticated;

create or replace function projects.resolve_handover_feedback(p_feedback_id uuid, p_resolution text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_f projects.p7_handover_feedback;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_resolution is null or length(btrim(p_resolution)) = 0 then return query select 'resolution_required'::text; return; end if;
  if projects.p7_has_secret(p_resolution) then return query select 'contains_secret'::text; return; end if;
  select * into v_f from projects.p7_handover_feedback f where f.id = p_feedback_id and f.organization_id = v_org for update;
  if v_f.id is null then return query select 'not_found'::text; return; end if;
  if v_f.status = 'resolved' then return query select 'already_resolved'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_handover_feedback set status = 'resolved', resolution = btrim(p_resolution), resolved_by = v_actor, resolved_at = now() where id = p_feedback_id;
  return query select 'resolved'::text;
end $$;
revoke all on function projects.resolve_handover_feedback(uuid, text) from public, anon;
grant execute on function projects.resolve_handover_feedback(uuid, text) to authenticated;

-- ── final financial clearance (P710): READ from finance rows, never a stored flag; Finance does not declare completion ──
create or replace function projects.p7_financial_clearance(p_project_id uuid)
returns table (gate text, satisfied boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_org uuid; v_m4 uuid; v_n int;
begin
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return; end if;
  if not v_service and (v_actor is null or v_org is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;

  gate := 'm4_verified_in_full'; satisfied := projects.m4_verified_paid(p_project_id);
  detail := case when satisfied then 'the final milestone invoice is verified paid in full by an Admin' else 'the final milestone is not verified paid in full (a claim, a proof or a match is not verification)' end;
  return next;

  select i.id into v_m4 from projects.milestones m join finance.invoices i on i.milestone_id = m.id and i.status <> 'void'
   where m.project_id = p_project_id and m.id = (select m4.id from projects.milestones m4 where m4.project_id = p_project_id and m4.amount_minor is not null order by m4.position, m4.created_at offset 3 limit 1) limit 1;
  gate := 'final_receipt'; satisfied := v_m4 is not null and exists (select 1 from finance.receipts r where r.invoice_id = v_m4 and r.organization_id = v_org);
  detail := case when satisfied then 'a receipt exists for the final invoice' else 'no receipt exists for the final invoice' end;
  return next;

  select count(*) into v_n from finance.invoices i where i.project_id = p_project_id and i.organization_id = v_org and i.status in ('issued', 'partially_paid', 'overdue') and i.verified_minor < i.total_minor;
  gate := 'no_outstanding_balance'; satisfied := v_n = 0 and not exists (select 1 from projects.p7_financial_exceptions e where e.project_id = p_project_id and e.status = 'open' and e.kind = 'balance_outstanding');
  detail := case when satisfied then 'no invoice has an unverified balance' else format('%s invoice(s) have an outstanding balance, or a balance exception is open', v_n) end;
  return next;

  select count(*) into v_n from finance.refunds r join finance.invoices i on i.id = r.invoice_id where i.project_id = p_project_id and i.organization_id = v_org and r.status = 'requested';
  gate := 'no_pending_refund'; satisfied := v_n = 0 and not exists (select 1 from projects.p7_financial_exceptions e where e.project_id = p_project_id and e.status = 'open' and e.kind = 'refund_pending');
  detail := case when satisfied then 'no refund is pending' else 'a refund is pending' end;
  return next;

  gate := 'no_open_dispute'; satisfied := not exists (select 1 from projects.p7_financial_exceptions e where e.project_id = p_project_id and e.status = 'open' and e.kind in ('dispute', 'chargeback', 'adjustment'));
  detail := case when satisfied then 'no dispute, chargeback or adjustment is open' else 'a dispute, chargeback or adjustment is open and stays visible until resolved or waived by an Admin' end;
  return next;
end $$;
revoke all on function projects.p7_financial_clearance(uuid) from public, anon;
grant execute on function projects.p7_financial_clearance(uuid) to authenticated, service_role;

create or replace function projects.open_financial_exception(p_project_id uuid, p_kind text, p_amount_minor bigint, p_note text)
returns table (outcome text, exception_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind not in ('balance_outstanding', 'refund_pending', 'dispute', 'chargeback', 'adjustment') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 then return query select 'note_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.phase_seven s where s.project_id = p_project_id and s.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_financial_exceptions (organization_id, project_id, kind, amount_minor, note, opened_by) values (v_org, p_project_id, p_kind, p_amount_minor, btrim(p_note), v_actor) returning id into v_new;
  perform core.record_audit(v_org, 'financial_exception.opened', 'project', p_project_id, null, jsonb_build_object('kind', p_kind));
  return query select 'opened'::text, v_new;
end $$;
revoke all on function projects.open_financial_exception(uuid, text, bigint, text) from public, anon;
grant execute on function projects.open_financial_exception(uuid, text, bigint, text) to authenticated;

create or replace function projects.decide_financial_exception(p_exception_id uuid, p_decision text, p_resolution text, p_evidence_ref text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_e projects.p7_financial_exceptions;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  -- resolving or waiving money is an Admin decision
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('resolved', 'waived') then return query select 'bad_decision'::text; return; end if;
  if p_resolution is null or length(btrim(p_resolution)) = 0 then return query select 'resolution_required'::text; return; end if;
  if p_decision = 'waived' and (p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0) then return query select 'waiver_needs_evidence'::text; return; end if;
  if projects.p7_has_secret(p_resolution) or projects.p7_has_secret(p_evidence_ref) then return query select 'contains_secret'::text; return; end if;
  select * into v_e from projects.p7_financial_exceptions e where e.id = p_exception_id and e.organization_id = v_org for update;
  if v_e.id is null then return query select 'not_found'::text; return; end if;
  if v_e.status <> 'open' then return query select 'already_decided'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7_financial_exceptions set status = p_decision, resolution = btrim(p_resolution), evidence_ref = p_evidence_ref, decided_by = v_actor, decided_at = now() where id = p_exception_id;
  perform core.record_audit(v_org, 'financial_exception.' || p_decision, 'project', v_e.project_id, null, jsonb_build_object('kind', v_e.kind));
  return query select 'decided'::text;
end $$;
revoke all on function projects.decide_financial_exception(uuid, text, text, text) from public, anon;
grant execute on function projects.decide_financial_exception(uuid, text, text, text) to authenticated;

-- ── completion exceptions (Admin only, exact package + commit) ─────────────
create or replace function projects.approve_completion_exception(p_project_id uuid, p_gate text, p_reason text, p_risk text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.p7_handover_packages;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  -- no silent AI override: only a signed-in Admin, with a reason and the risk
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_gate not in ('scope_complete', 'client_acceptance') then return query select 'gate_not_exceptionable'::text; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 or p_risk is null or length(btrim(p_risk)) = 0 then return query select 'reason_and_risk_required'::text; return; end if;
  if projects.p7_has_secret(p_reason) or projects.p7_has_secret(p_risk) then return query select 'contains_secret'::text; return; end if;
  select * into v_p from projects.p7_handover_packages p where p.project_id = p_project_id and p.organization_id = v_org and p.status = 'delivered';
  if v_p.id is null then return query select 'no_delivered_package'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7_completion_exceptions (organization_id, project_id, gate, package_id, commit_ref, reason, risk, approved_by) values (v_org, p_project_id, p_gate, v_p.id, v_p.commit_ref, btrim(p_reason), btrim(p_risk), v_actor)
  on conflict (project_id, gate, package_id) do nothing;
  perform core.record_audit(v_org, 'completion_exception.approved', 'project', p_project_id, null, jsonb_build_object('gate', p_gate, 'packageId', v_p.id, 'commit', v_p.commit_ref));
  return query select 'approved'::text;
end $$;
revoke all on function projects.approve_completion_exception(uuid, text, text, text) from public, anon;
grant execute on function projects.approve_completion_exception(uuid, text, text, text) to authenticated;

-- ── the completion gate (P701 §11, P708 §7) ────────────────────────────────
create or replace function projects.p7_completion_gate(p_project_id uuid)
returns table (gate text, passed boolean, detail text, excepted boolean, satisfied boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_s projects.phase_seven; v_pkg projects.p7_handover_packages; v_v record; v_n int; v_acc projects.p7_client_acceptances; v_fin int; v_exc boolean;
begin
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id;
  if v_s.id is null then return; end if;
  if not v_service and (v_actor is null or v_s.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;
  select * into v_pkg from projects.p7_handover_packages p where p.project_id = p_project_id and p.status = 'delivered';
  select * into v_v from projects.p7_production_validation(p_project_id);

  -- scope complete (or an Admin exception for this exact delivered package)
  select count(*) into v_n from projects.tasks t where t.project_id = p_project_id and (t.module_id is not null or t.feature_id is not null) and t.status not in ('done', 'completed', 'cancelled') and t.archived_at is null;
  v_exc := v_pkg.id is not null and exists (select 1 from projects.p7_completion_exceptions e where e.project_id = p_project_id and e.gate = 'scope_complete' and e.package_id = v_pkg.id and e.commit_ref = v_pkg.commit_ref);
  gate := 'scope_complete'; passed := v_n = 0; excepted := v_exc and not passed; satisfied := passed or excepted;
  detail := case when passed then 'every planned development task is done or cancelled' else format('%s development task(s) are not done', v_n) end;
  return next;

  -- final QA: the approved candidate is still the build's commit and every Phase 6 hard gate is satisfied now
  select count(*) into v_n from qa.evaluate_hard_gates(v_s.candidate_id) g where not g.satisfied;
  gate := 'final_qa_passed'; passed := projects.p7_candidate_ok(p_project_id, v_s.candidate_id) and v_n = 0; excepted := false; satisfied := passed;
  detail := case when passed then 'the exact candidate is Admin-approved, still current, and every Phase 6 gate is satisfied' else 'the approved candidate is stale, or a Phase 6 gate is no longer satisfied' end;
  return next;

  gate := 'production_validated'; passed := v_v.deployment_id is not null; excepted := false; satisfied := passed;
  detail := case when passed then 'the exact candidate is deployed and validated in production, with no open incident' else 'production is not validated for the current candidate (deployment success alone is not completion)' end;
  return next;

  gate := 'no_open_incident'; passed := not exists (select 1 from projects.p7_incidents i where i.project_id = p_project_id and i.state <> 'closed') and not v_s.completion_paused; excepted := false; satisfied := passed;
  detail := case when passed then 'no production incident is open and completion is not paused' else 'a production incident is open or completion is paused' end;
  return next;

  select count(*) into v_fin from projects.p7_financial_clearance(p_project_id) f where not f.satisfied;
  -- a waived or resolved financial exception is already reflected in the clearance rows above; a waiver does not hide an unverified M4
  gate := 'financial_clearance'; passed := v_fin = 0; excepted := false; satisfied := passed;
  detail := case when passed then 'final payment is verified in full, a receipt exists, and no balance, refund or dispute is open' else format('%s financial clearance check(s) are not satisfied', v_fin) end;
  return next;

  gate := 'handover_complete'; passed := v_pkg.id is not null and not exists (select 1 from projects.p7_handover_completeness(v_pkg.id) c where not c.satisfied); excepted := false; satisfied := passed;
  detail := case when v_pkg.id is null then 'no Admin-approved handover package has been delivered' when passed then 'the delivered package version is complete, current and discloses every limitation' else 'the delivered package version is incomplete or stale for the current release' end;
  return next;

  -- client acceptance: the LATEST formal decision on the exact delivered version is "accepted" (or an Admin-set policy / exception)
  select * into v_acc from projects.p7_client_acceptances a where a.package_id = v_pkg.id order by a.recorded_at desc limit 1;
  v_exc := v_pkg.id is not null and exists (select 1 from projects.p7_completion_exceptions e where e.project_id = p_project_id and e.gate = 'client_acceptance' and e.package_id = v_pkg.id and e.commit_ref = v_pkg.commit_ref);
  gate := 'client_acceptance';
  passed := not v_s.client_acceptance_required or (v_acc.id is not null and v_acc.decision = 'accepted' and v_acc.package_version = v_pkg.version and v_acc.commit_ref = v_pkg.commit_ref);
  excepted := v_exc and not passed; satisfied := passed or excepted;
  detail := case when not v_s.client_acceptance_required then 'acceptance is not required by an Admin-set policy (reason recorded)' when v_acc.id is null then 'no formal client acceptance of the delivered version is recorded (an informal "looks good" is not acceptance)'
                 when v_acc.decision <> 'accepted' then 'the latest client decision on this version is ' || v_acc.decision when passed then 'the client formally accepted this exact version, with evidence' else 'the acceptance is not for the delivered version' end;
  return next;

  select count(*) into v_n from projects.p7_handover_feedback f where f.project_id = p_project_id and f.status = 'open' and f.classification in ('handover_correction', 'production_defect', 'access_issue');
  select count(*) into v_fin from qa.unresolved_product_defects(p_project_id) u where u.s_level <= 1;
  gate := 'no_blocking_issue'; passed := v_n = 0 and v_fin = 0; excepted := false; satisfied := passed;
  detail := case when passed then 'no open handover correction, access issue, production defect or S0/S1 defect' else format('%s open handover/support item(s) and %s S0/S1 defect(s) block completion', v_n, v_fin) end;
  return next;

  gate := 'support_transition_ready'; passed := v_pkg.id is not null and length(btrim(coalesce(v_pkg.support_terms, ''))) > 0 and v_pkg.warranty_ends_on is not null; excepted := false; satisfied := passed;
  detail := case when passed then 'support and warranty terms are known for the Customer Success handoff' else 'the support/warranty terms are not recorded' end;
  return next;
end $$;
revoke all on function projects.p7_completion_gate(uuid) from public, anon;
grant execute on function projects.p7_completion_gate(uuid) to authenticated, service_role;

-- ── complete the project: ONE immutable record, ONE frozen Phase 8 intake ──
create or replace function projects.complete_phase_seven(p_project_id uuid)
returns table (outcome text, missing text[], completion_record_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_project projects.projects; v_s projects.phase_seven; v_pkg projects.p7_handover_packages; v_v record; v_acc projects.p7_client_acceptances; v_missing text[]; v_rec uuid; v_cand qa.release_candidates;
  v_h projects.phase_six_handoffs; v_gates jsonb; v_fin jsonb; v_limits jsonb; v_exc jsonb; v_payload jsonb; v_dep projects.p7_deployments; v_defects int;
begin
  if v_actor is null and not v_service then return query select 'no_actor'::text, '{}'::text[], null::uuid; return; end if;
  select p.* into v_project from projects.projects p where p.id = p_project_id and p.deleted_at is null for update;
  if v_project.id is null then return query select 'not_found'::text, '{}'::text[], null::uuid; return; end if;
  -- an Admin completes, or the runner does once the same evidence exists; the evidence is the authority, not the caller
  if v_actor is not null and (v_project.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_admin()), false)) then
    return query select 'not_authorized'::text, '{}'::text[], null::uuid; return;
  end if;
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id for update;
  if v_s.id is null then return query select 'not_found'::text, '{}'::text[], null::uuid; return; end if;
  select r.id into v_rec from projects.p7_completion_records r where r.project_id = p_project_id;
  if v_rec is not null then return query select 'already_completed'::text, '{}'::text[], v_rec; return; end if;
  select coalesce(array_agg(g.gate || ': ' || g.detail order by g.gate), '{}') into v_missing from projects.p7_completion_gate(p_project_id) g where not g.satisfied;
  if cardinality(v_missing) > 0 then return query select 'gate_not_satisfied'::text, v_missing, null::uuid; return; end if;

  perform set_config('projects.p7_door', 'on', true);
  select * into v_pkg from projects.p7_handover_packages p where p.project_id = p_project_id and p.status = 'delivered';
  select * into v_v from projects.p7_production_validation(p_project_id);
  select * into v_dep from projects.p7_deployments d where d.id = v_v.deployment_id;
  select * into v_acc from projects.p7_client_acceptances a where a.package_id = v_pkg.id and a.decision = 'accepted' order by a.recorded_at desc limit 1;
  select * into v_cand from qa.release_candidates c where c.id = v_s.candidate_id;
  select * into v_h from projects.phase_six_handoffs h where h.project_id = p_project_id;
  select coalesce(jsonb_agg(jsonb_build_object('gate', g.gate, 'passed', g.passed, 'excepted', g.excepted, 'detail', g.detail) order by g.gate), '[]'::jsonb) into v_gates from projects.p7_completion_gate(p_project_id) g;
  select coalesce(jsonb_agg(jsonb_build_object('gate', f.gate, 'satisfied', f.satisfied, 'detail', f.detail) order by f.gate), '[]'::jsonb) into v_fin from projects.p7_financial_clearance(p_project_id) f;
  select coalesce(jsonb_agg(jsonb_build_object('title', l.title, 'source', l.source) order by l.title), '[]'::jsonb) into v_limits from projects.p7_known_limitations l where l.project_id = p_project_id;
  select coalesce(jsonb_agg(jsonb_build_object('gate', e.gate, 'reason', e.reason, 'risk', e.risk, 'approvedBy', e.approved_by, 'approvedAt', e.approved_at) order by e.gate), '[]'::jsonb) into v_exc
    from projects.p7_completion_exceptions e where e.project_id = p_project_id and e.package_id = v_pkg.id;
  select count(*) into v_defects from qa.unresolved_product_defects(p_project_id) u where u.s_level >= 2;

  v_payload := jsonb_build_object(
    'project', jsonb_build_object('id', v_project.id, 'name', v_project.name, 'code', v_project.project_code, 'clientAccountId', v_project.client_account_id),
    'scopeVersionId', v_h.payload -> 'scopeVersionId',
    'release', jsonb_build_object('candidateId', v_cand.id, 'version', v_cand.version, 'commit', v_cand.commit_ref, 'artifactSha256', v_cand.artifact_sha256, 'approvedBy', v_cand.approved_by, 'approvedAt', v_cand.approved_at),
    'qa', jsonb_build_object('readiness', v_h.payload -> 'readiness', 'finalGates', v_gates),
    'production', jsonb_build_object('deploymentId', v_dep.id, 'deployedAt', v_dep.finished_at, 'environment', v_dep.environment, 'validationRunId', v_v.run_id),
    'finance', jsonb_build_object('status', 'closed', 'clearance', v_fin),
    'handover', jsonb_build_object('packageId', v_pkg.id, 'version', v_pkg.version, 'approvedBy', v_pkg.admin_approved_by, 'approvedAt', v_pkg.admin_approved_at, 'deliveredAt', v_pkg.delivered_at),
    'acceptance', case when v_acc.id is not null then jsonb_build_object('id', v_acc.id, 'evidenceKind', v_acc.evidence_kind, 'evidenceRef', v_acc.evidence_ref, 'client', v_acc.client_name, 'recordedBy', v_acc.recorded_by, 'recordedAt', v_acc.recorded_at)
                       else jsonb_build_object('required', v_s.client_acceptance_required, 'waiverReason', v_s.acceptance_waiver_reason) end,
    'knownLimitations', v_limits,
    'support', jsonb_build_object('terms', v_pkg.support_terms, 'warrantyEndsOn', v_pkg.warranty_ends_on, 'emergencyContacts', v_pkg.emergency_contacts),
    'exceptions', v_exc,
    'completedBy', case when v_actor is null then 'runner' else 'admin' end);

  insert into projects.p7_completion_records (organization_id, project_id, phase_seven_id, package_id, acceptance_id, deployment_id, validation_run_id, candidate_id, commit_ref, payload, completed_by)
  values (v_project.organization_id, p_project_id, v_s.id, v_pkg.id, v_acc.id, v_dep.id, v_v.run_id, v_s.candidate_id, v_s.commit_ref, v_payload, v_actor) returning id into v_rec;
  -- the Phase 8 intake: exact production version, support/warranty terms, limitations, open non-blocking issues and SUGGESTED follow-up dates (data, not scheduled work)
  insert into projects.phase_seven_handoffs (organization_id, project_id, completion_record_id, commit_ref, payload)
  values (v_project.organization_id, p_project_id, v_rec, v_s.commit_ref, jsonb_build_object(
    'productionVersion', jsonb_build_object('commit', v_s.commit_ref, 'artifactSha256', v_s.artifact_sha256, 'candidateVersion', v_cand.version, 'deploymentId', v_dep.id, 'url', v_pkg.production_url),
    'handoverPackage', jsonb_build_object('id', v_pkg.id, 'version', v_pkg.version),
    'support', jsonb_build_object('terms', v_pkg.support_terms, 'warrantyStartsOn', current_date, 'warrantyEndsOn', v_pkg.warranty_ends_on, 'emergencyContacts', v_pkg.emergency_contacts),
    'knownLimitations', v_limits,
    'openNonBlockingIssues', v_defects,
    'maintenanceEntitlement', null,
    'followUpSuggestions', jsonb_build_array(jsonb_build_object('type', 'day_0_access_check', 'dueOn', current_date), jsonb_build_object('type', 'week_1_check_in', 'dueOn', current_date + 7),
                                              jsonb_build_object('type', 'warranty_ending', 'dueOn', v_pkg.warranty_ends_on - 7)),
    'note', 'Customer Success starts from this evidence. A new feature is a Change Request, a new module is a new Opportunity, a production defect in warranty is a Support/Bug item. The completed scope is history and is not edited.'));

  update projects.phase_seven set state = 'phase8_ready', completed_at = now(), completion_paused = false, paused_reason = null where id = v_s.id;
  update projects.projects set status = 'completed', completed_at = now() where id = p_project_id;
  perform core.record_audit(v_project.organization_id, 'project.completed', 'project', p_project_id, null, jsonb_build_object('projectId', p_project_id, 'completionRecordId', v_rec, 'commit', v_s.commit_ref));
  perform core.emit_event(v_project.organization_id, 'project.completed', 'project', p_project_id, jsonb_build_object('projectId', p_project_id, 'completionRecordId', v_rec));
  return query select 'completed'::text, '{}'::text[], v_rec;
end $$;
revoke all on function projects.complete_phase_seven(uuid) from public, anon;
grant execute on function projects.complete_phase_seven(uuid) to authenticated, service_role;

-- ── the legacy completion trigger: a pipeline project completes only through its completion record ──
-- (a project with no phase_seven row is judged exactly as before)
create or replace function projects.refuse_undone_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ready record;
  v_unmet text[] := '{}';
begin
  if new.status <> 'completed' or coalesce(old.status, '') = 'completed' then
    return new;
  end if;

  -- Phase 7: deployment alone, payment alone, or an Admin override cannot complete a project that entered the pipeline.
  if exists (select 1 from projects.phase_seven s where s.project_id = new.id) then
    if not exists (select 1 from projects.p7_completion_records r where r.project_id = new.id) then
      raise exception 'this project is in Phase 7: it completes only when the completion gate passes and its completion record is written (projects.complete_phase_seven)'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  select * into v_ready from projects.completion_readiness(new.id);

  if not v_ready.no_blocking_defects then v_unmet := v_unmet || 'blocking_defects_remain'::text; end if;
  if not v_ready.payment_verified    then v_unmet := v_unmet || 'payment_not_verified'::text;    end if;
  if not v_ready.handover_delivered  then v_unmet := v_unmet || 'handover_not_delivered'::text;  end if;
  if not v_ready.client_accepted     then v_unmet := v_unmet || 'client_has_not_accepted'::text; end if;

  if array_length(v_unmet, 1) is not null
     and coalesce(length(btrim(new.completion_override_reason)), 0) = 0
  then
    raise exception
      'this project is not done: %  (Doc 17 §3 — or complete_project with a reason, which §13 requires)',
      array_to_string(v_unmet, ', ')
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

-- ── P703 §7: the Phase 7 task graph, DERIVED from the authoritative rows (never a stored flag that can drift) ──
create or replace function projects.p7_task_graph(p_project_id uuid)
returns table (task text, depends_on text[], state text, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_s projects.phase_seven; v_plan projects.p7_deployment_plans; v_d projects.p7_deployments; v_v record; v_pkg projects.p7_handover_packages; v_done boolean; v_rec boolean;
begin
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id;
  if v_s.id is null then return; end if;
  if not v_service and (v_actor is null or v_s.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;
  select * into v_plan from projects.p7_deployment_plans p where p.project_id = p_project_id order by p.version desc limit 1;
  select * into v_d from projects.p7_deployments d where d.project_id = p_project_id order by d.created_at desc, d.attempt desc limit 1;
  select * into v_v from projects.p7_production_validation(p_project_id);
  select * into v_pkg from projects.p7_handover_packages p where p.project_id = p_project_id and p.status <> 'superseded' order by p.version desc limit 1;
  v_rec := exists (select 1 from projects.p7_completion_records r where r.project_id = p_project_id);

  task := 'deployment_plan'; depends_on := array['phase7_ready']::text[];
  state := case when v_s.state in ('waiting_phase6', 'waiting_m4_verification') then 'blocked' when v_plan.id is not null and v_plan.status in ('ready_for_approval', 'approved') then 'done' else 'ready' end;
  detail := case when v_s.state = 'waiting_m4_verification' then 'M4 is not verified' when v_s.state = 'waiting_phase6' then 'the approved candidate is not current' else coalesce('plan v' || v_plan.version || ' is ' || v_plan.status, 'no plan yet') end;
  return next;

  task := 'deployment_approval'; depends_on := array['deployment_plan']::text[];
  state := case when v_plan.id is null or v_plan.status in ('draft', 'rejected', 'superseded') then 'blocked' when v_plan.status = 'approved' then 'done' else 'ready' end;
  detail := coalesce('plan is ' || v_plan.status, 'no plan'); return next;

  task := 'deployment'; depends_on := array['deployment_approval']::text[];
  state := case when v_d.id is not null and v_d.status in ('succeeded_pending_validation', 'recovered_pending_validation') then 'done' when v_d.status = 'failed' then 'failed' when v_d.status = 'rolled_back' then 'failed'
                when v_plan.status = 'approved' then 'ready' else 'blocked' end;
  detail := coalesce('latest deployment is ' || v_d.status || coalesce(' (blocker: ' || v_d.blocker_code || ')', ''), 'not requested'); return next;

  task := 'production_validation'; depends_on := array['deployment']::text[];
  state := case when v_v.deployment_id is not null then 'done' when v_d.id is not null and v_d.status in ('succeeded_pending_validation', 'recovered_pending_validation') then 'ready' else 'blocked' end;
  detail := case when v_v.deployment_id is not null then 'ProductionValidated' else 'waits for deployment success and a passed live validation' end; return next;

  task := 'handover_package'; depends_on := array['production_validation']::text[];
  state := case when v_pkg.id is not null and v_pkg.status in ('approved', 'delivered') then 'done' when v_pkg.id is not null or v_v.deployment_id is not null then 'ready' else 'blocked' end;
  detail := coalesce('package v' || v_pkg.version || ' is ' || v_pkg.status, 'no package yet'); return next;

  task := 'client_acceptance'; depends_on := array['handover_package']::text[];
  v_done := v_pkg.id is not null and exists (select 1 from projects.p7_client_acceptances a where a.package_id = v_pkg.id and a.decision = 'accepted') ;
  state := case when v_done or not v_s.client_acceptance_required and v_pkg.status = 'delivered' then 'done' when v_pkg.status = 'delivered' then 'ready' else 'blocked' end;
  detail := case when v_done then 'accepted (formal, with evidence)' when v_pkg.status = 'delivered' then 'waiting for the client' else 'the package is not delivered' end; return next;

  task := 'completion_gate'; depends_on := array['client_acceptance', 'production_validation']::text[];
  state := case when v_rec then 'done' when not exists (select 1 from projects.p7_completion_gate(p_project_id) g where not g.satisfied) then 'ready' else 'blocked' end;
  detail := case when v_rec then 'the completion record exists' else coalesce((select string_agg(g.gate, ', ' order by g.gate) from projects.p7_completion_gate(p_project_id) g where not g.satisfied), 'all gates pass') end; return next;

  task := 'customer_success_handoff'; depends_on := array['completion_gate']::text[];
  state := case when exists (select 1 from projects.phase_seven_handoffs h where h.project_id = p_project_id) then 'done' else 'blocked' end;
  detail := 'Phase 8 starts from the frozen completion intake'; return next;
end $$;
revoke all on function projects.p7_task_graph(uuid) from public, anon;
grant execute on function projects.p7_task_graph(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
