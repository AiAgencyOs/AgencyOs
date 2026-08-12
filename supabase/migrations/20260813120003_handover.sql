-- ═══════════════════════════════════════════════════════════════════════════
-- Handing it over.
--
-- Phase 12, gap G-032, directive §22. The end of the lifecycle, and until now
-- the only record that a project had been delivered was that somebody stopped
-- working on it.
--
-- ── the credentials rule shaped this table ────────────────────────────────
--
-- Directive §22: *"Never expose secrets in ordinary chat messages. Use
-- approved secure credential-transfer mechanisms."* The tempting design is a
-- handover checklist with a field for each credential, and it is wrong: a
-- database column holding a client's production password is the same leak as
-- the WhatsApp message, with a longer retention period and a backup schedule.
--
-- So a credential item records **that a credential was transferred, and by
-- what method** — never the value. `handover_items_credential_shape` refuses a
-- reference on a credential row in DDL, so the field cannot be misused by a
-- future form that means well. What is auditable is the handover; the secret
-- travels out of band and leaves only a receipt.
--
-- ── what is gated, and what deliberately is not ───────────────────────────
--
-- Delivering refuses while an open blocker or major defect stands against the
-- project. That is not a new rule: ARCHITECTURE.md §4.8 already forbids
-- client-visible work in that state, and a handover is the most client-visible
-- act there is. Directive §20 says the same thing from the other side.
--
-- It does NOT gate on money. Directive §21 says handover follows final
-- payment, but *which* payment is final is the project's own plan, and
-- deciding that here would put an invented gate in front of real revenue —
-- ADM-13/ADM-14, the same reason G-100 stays open. The outstanding balance is
-- reported so a human sees it; nothing is refused on it.
-- ═══════════════════════════════════════════════════════════════════════════

-- The approval engine gains one subject type. A handover is accepted by the
-- client, which is exactly what the engine's client audience is for, and
-- adding a subject beats inventing a second acceptance mechanism beside it.
alter table approvals.approval_requests drop constraint if exists approval_requests_subject_type_check;
alter table approvals.approval_requests add constraint approval_requests_subject_type_check
  check (subject_type in ('proposal', 'deliverable', 'invoice', 'refund',
                          'scope_change', 'prototype', 'agent_action', 'ticket_plan', 'handover'));

alter table approvals.approval_policies drop constraint if exists approval_policies_subject_type_check;
alter table approvals.approval_policies add constraint approval_policies_subject_type_check
  check (subject_type in ('proposal', 'deliverable', 'invoice', 'refund',
                          'scope_change', 'prototype', 'agent_action', 'ticket_plan', 'handover'));

create table if not exists projects.handovers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  status           text not null default 'preparing' check (status in
                     ('preparing', 'delivered', 'accepted', 'cancelled')),

  summary          text,

  delivered_at     timestamptz,
  delivered_by     uuid references core.users(id) on delete set null,

  -- Acceptance is the client's, recorded by staff with evidence — ADM-08d,
  -- through the approval engine rather than beside it.
  approval_request_id uuid references approvals.approval_requests(id) on delete set null,
  accepted_at      timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table projects.handovers is
  'The end of a project: what was handed over, when, and whether the client said they had received it. Directive §22. Holds no secret — a credential item records that a credential was transferred and by what method, never its value.';

-- One live handover per project. A project handed over, then extended and
-- handed over again after maintenance, gets a second row — which is why this
-- is partial rather than a plain unique constraint.
create unique index if not exists handovers_open_project_key
  on projects.handovers (project_id) where status in ('preparing', 'delivered');

create index if not exists handovers_project_idx on projects.handovers (project_id, created_at desc);

drop trigger if exists set_updated_at on projects.handovers;
create trigger set_updated_at
  before update on projects.handovers
  for each row execute function core.set_updated_at();

create table if not exists projects.handover_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  handover_id      uuid not null references projects.handovers(id) on delete cascade,

  kind             text not null check (kind in
                     ('artifact', 'repository', 'deployment', 'documentation',
                      'credential', 'invoice', 'warranty')),

  label            text not null check (length(trim(label)) > 0),

  -- Where the thing is. A link, an account name, a repository — never a
  -- secret, and for a credential never anything at all.
  reference        text,

  -- How a credential reached the client: a password manager share, a sealed
  -- envelope, a call. The method is the auditable part.
  transfer_method  text,

  notes            text,
  created_at       timestamptz not null default now(),

  -- Directive §22, in DDL rather than in a service that could forget. A
  -- credential row carries a method and no reference: the value travels out of
  -- band and leaves a receipt, because a column holding a client's production
  -- password is the same leak as the chat message with a longer retention
  -- period.
  constraint handover_items_credential_shape check (
    kind <> 'credential'
    or (reference is null and transfer_method is not null and length(trim(transfer_method)) > 0)
  )
);

comment on table projects.handover_items is
  'One line of the handover package. A credential item is deliberately incapable of holding the credential: reference must be null and transfer_method must say how it actually reached the client.';

create index if not exists handover_items_handover_idx on projects.handover_items (handover_id);

alter table projects.handovers enable row level security;
alter table projects.handover_items enable row level security;

drop policy if exists handovers_select on projects.handovers;
create policy handovers_select on projects.handovers
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_internal())
      or (
        (select core.is_client())
        and status <> 'preparing'
        and exists (
          select 1 from projects.projects p
           where p.id = project_id
             and p.client_account_id = (select core.current_client_account_id())
        )
      )
    )
  );

drop policy if exists handovers_write on projects.handovers;
create policy handovers_write on projects.handovers
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

drop policy if exists handover_items_select on projects.handover_items;
create policy handover_items_select on projects.handover_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and exists (select 1 from projects.handovers h where h.id = handover_id)
  );

drop policy if exists handover_items_write on projects.handover_items;
create policy handover_items_write on projects.handover_items
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

-- ── a delivered handover is not edited ───────────────────────────────────
create or replace function projects.handover_items_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare v_status text;
begin
  select h.status into v_status
    from projects.handovers h
   where h.id = coalesce(new.handover_id, old.handover_id);

  if v_status in ('delivered', 'accepted') then
    raise exception
      'this handover has already been %; prepare another rather than changing what was delivered', v_status
      using errcode = 'restrict_violation';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists handover_items_guard on projects.handover_items;
create trigger handover_items_guard
  before insert or update or delete on projects.handover_items
  for each row execute function projects.handover_items_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- Delivering
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.deliver_handover(
  p_handover_id  uuid,
  p_delivered_by uuid default null
)
returns table (
  -- 'delivered' | 'already_delivered' | 'not_found' | 'empty' | 'blocked'
  -- | 'no_policy'
  outcome        text,
  request_id     uuid,
  status         text,
  -- Reported, never enforced: which payment is final is the project's own
  -- plan, and gating on it here would be an invented rule in front of real
  -- revenue (ADM-13/ADM-14).
  outstanding_minor bigint
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row         projects.handovers;
  v_items       int;
  v_blocking    int;
  v_outstanding bigint;
  v_approval    record;
begin
  select h.* into v_row
    from projects.handovers h
   where h.id = p_handover_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text, null::bigint;
    return;
  end if;

  if v_row.status in ('delivered', 'accepted') then
    return query select 'already_delivered'::text, v_row.approval_request_id, v_row.status, null::bigint;
    return;
  end if;

  select count(*) into v_items
    from projects.handover_items i
   where i.handover_id = v_row.id;

  if v_items = 0 then
    -- An empty handover is a claim that nothing was delivered, which is never
    -- what the caller meant.
    return query select 'empty'::text, null::uuid, v_row.status, null::bigint;
    return;
  end if;

  -- ARCHITECTURE.md §4.8 and directive §20, applied to the most client-facing
  -- act there is. Not a new rule; the same rule, at the end of the line.
  select count(*) into v_blocking
    from qa.defects d
   where d.project_id = v_row.project_id
     and d.status = 'open'
     and d.severity in ('blocker', 'major');

  if v_blocking > 0 then
    return query select 'blocked'::text, null::uuid, v_row.status, null::bigint;
    return;
  end if;

  select coalesce(sum(i.total_minor - i.paid_minor), 0) into v_outstanding
    from finance.invoices i
   where i.project_id = v_row.project_id
     and i.status in ('issued', 'partially_paid', 'overdue');

  select * into v_approval
    from approvals.request_approval(
      v_row.organization_id, 'handover', v_row.id,
      case when p_delivered_by is null then 'system' else 'user' end,
      p_delivered_by,
      'Handover — ' || coalesce(v_row.summary, 'final delivery'),
      jsonb_build_object('items', v_items, 'outstanding_minor', v_outstanding),
      null, 'client', null
    );

  if v_approval.outcome = 'no_policy' then
    return query select 'no_policy'::text, null::uuid, v_row.status, v_outstanding;
    return;
  end if;

  update projects.handovers
     set status = 'delivered',
         delivered_at = now(),
         delivered_by = p_delivered_by,
         approval_request_id = v_approval.request_id
   where projects.handovers.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'handover.delivered', 'handover', v_row.id,
    to_jsonb(v_row),
    jsonb_build_object('items', v_items, 'outstanding_minor', v_outstanding,
                       'approval_request_id', v_approval.request_id)
  );

  return query select 'delivered'::text, v_approval.request_id, 'delivered'::text, v_outstanding;
end;
$$;

comment on function projects.deliver_handover(uuid, uuid) is
  'Hands a project over: refuses an empty package, refuses while an open blocker or major defect stands (ARCHITECTURE.md §4.8, directive §20), and raises a client-audience approval for the acceptance. Reports the outstanding balance without gating on it — which payment is final is the project''s own plan, and inventing that rule here would put a made-up gate in front of real revenue.';

/** Bring the client's acceptance back onto the handover. */
create or replace function projects.sync_handover_acceptance(p_handover_id uuid)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row   projects.handovers;
  v_state text;
begin
  select h.* into v_row from projects.handovers h where h.id = p_handover_id for update;

  if v_row.id is null or v_row.approval_request_id is null then
    return coalesce(v_row.status, 'not_found');
  end if;

  select r.state into v_state
    from approvals.approval_requests r
   where r.id = v_row.approval_request_id;

  if v_state <> 'approved' or v_row.status = 'accepted' then
    return v_row.status;
  end if;

  update projects.handovers
     set status = 'accepted', accepted_at = now()
   where projects.handovers.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'handover.accepted', 'handover', v_row.id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', 'accepted')
  );

  return 'accepted';
end;
$$;

revoke all on function projects.deliver_handover(uuid, uuid) from public;
revoke all on function projects.sync_handover_acceptance(uuid) from public;

grant execute on function projects.deliver_handover(uuid, uuid) to authenticated, service_role;
grant execute on function projects.sync_handover_acceptance(uuid) to authenticated, service_role;
grant select, insert, update on projects.handovers to authenticated, service_role;
grant select, insert, update, delete on projects.handover_items to authenticated, service_role;
