-- ═══════════════════════════════════════════════════════════════════════════
-- 003 — audit: append-only trail
--
-- Append-only is enforced by omission: there is no UPDATE policy and no DELETE
-- policy, so no role short of service_role can rewrite history. A trigger
-- blocks it too, in case a policy is ever added by mistake.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists audit.audit_log (
  id               bigserial primary key,
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  actor_type       text not null check (actor_type in ('user', 'agent', 'system', 'client')),
  actor_id         uuid,

  action           text not null,        -- 'lead.qualified', 'deliverable.approved'
  subject_type     text not null,        -- 'lead', 'deliverable'
  subject_id       uuid,

  before           jsonb,
  after            jsonb,

  correlation_id   uuid,
  ip               inet,
  user_agent       text,

  created_at       timestamptz not null default now()
);

create index if not exists audit_log_subject_idx
  on audit.audit_log (organization_id, subject_type, subject_id, created_at desc);

create index if not exists audit_log_actor_idx
  on audit.audit_log (organization_id, actor_id, created_at desc);

create index if not exists audit_log_action_idx
  on audit.audit_log (organization_id, action, created_at desc);

create index if not exists audit_log_correlation_idx
  on audit.audit_log (correlation_id) where correlation_id is not null;

comment on table audit.audit_log is
  'Append-only. Every gated state transition writes here in the same transaction as the change itself.';

-- Immutability guard, independent of RLS.
create or replace function audit.reject_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'audit.audit_log is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists audit_log_no_update on audit.audit_log;
create trigger audit_log_no_update
  before update on audit.audit_log
  for each row execute function audit.reject_mutation();

drop trigger if exists audit_log_no_delete on audit.audit_log;
create trigger audit_log_no_delete
  before delete on audit.audit_log
  for each row execute function audit.reject_mutation();

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table audit.audit_log enable row level security;

-- Owners and ops read the trail. Deliberately not readable by clients.
drop policy if exists audit_log_select on audit.audit_log;
create policy audit_log_select on audit.audit_log
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  );

-- Anyone acting inside the organization may append, but only about themselves:
-- a user cannot attribute an action to someone else.
drop policy if exists audit_log_insert on audit.audit_log;
create policy audit_log_insert on audit.audit_log
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (
      (actor_type = 'user'   and actor_id = (select auth.uid()))
      or (actor_type = 'client' and actor_id = (select auth.uid()))
    )
  );

-- No UPDATE or DELETE policy exists, by design.
