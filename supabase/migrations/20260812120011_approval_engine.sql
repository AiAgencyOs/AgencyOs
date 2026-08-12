-- ═══════════════════════════════════════════════════════════════════════════
-- The approval engine — one table for every decision a human has to make.
--
-- Gap G-040, decision ADM-08, designed in ARCHITECTURE.md §4.6. It is the
-- keystone: G-022 (client approval of an artifact), G-041 (trust levels) and
-- G-044 (the approval centre) all wait behind it, and the delivery and upsell
-- phases wait behind those.
--
-- Until now AgencyOS had exactly one approval — accepting a requirement
-- version — enforced by a policy on that one table. Thirteen more are coming
-- (approval policy §7). Building each as its own gate would produce thirteen
-- mechanisms, thirteen shapes of "who decided", and no single place to see
-- what is waiting, which is the thing an approval centre is.
--
-- ── what the Admin decided (ADM-08, 2026-08-12) ───────────────────────────
--
--   a. Build the full engine as designed, not a narrowed first slice.
--   b. Policy lives in DATA — owner-editable, audited — not in migrations, so
--      "invoices over ₹5L need owner sign-off" is an UPDATE, not a deploy.
--   c. An unanswered request EXPIRES and escalates to the owner. It is never
--      auto-approved. Directive §29: absence of a response is never approval.
--   d. A client approves over WhatsApp and a staff member records that
--      decision against the versioned artifact, with the message as evidence.
--      decided_by is the staff member. The row never pretends the client
--      clicked.
--
-- ── why the policy floor exists even though (b) chose data ────────────────
--
-- Owner-editable policy is a lever that can be pulled the wrong way. Two
-- guards, both in DDL rather than in the application:
--
--   A policy may only ever say who must approve. It grants nothing. Every
--   capability check and every RLS policy that stands today still stands —
--   an approved request does not let anybody issue an invoice they could not
--   already issue. The engine records consent; it does not confer authority.
--
--   approval_policies_money_floor refuses a policy that puts a refund below
--   owner, or money below ops_admin. That is the "can never remove the
--   database-level gate on money" half of what (b) was granted on.
--
-- ── the requested role is snapshotted, and that is deliberate ─────────────
--
-- required_role is copied onto the request when it is raised, and the decision
-- is judged against the copy. A policy edited while a request is pending must
-- not silently change the rule that request was raised under — that is the
-- read-decide-write defect this repository has now fixed eight times, in the
-- one place where the stale copy is the correct answer rather than the bug.
--
-- ── what this migration does NOT do ───────────────────────────────────────
--
-- Nothing expires yet. sla_due_at is written and indexed, the `expired` state
-- exists, and escalated_from is here to carry the chain — but no job walks
-- them, so an overdue request stays pending and visible rather than escalating.
-- That is ADM-08c's other half and it is recorded as G-096, not implied.
--
-- No consumer is wired. `finance.issue_invoice` does not call this, and
-- neither does anything else. The engine is built, the callers arrive with the
-- features that need them (Phase 12). What is NOT shipped here is a mechanism
-- that would be wrong if used — the G-082 lesson — which is why there is no
-- unused expire function sitting ready to hand a milestone to the wrong role.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists approvals;

comment on schema approvals is
  'The approval engine (ARCHITECTURE.md §4.6, ADM-08). One request table serving internal and client decisions across every subject type, and the policy rows that say who must decide.';

-- ── the schema has to be reachable, and that is not a migration by default ──
--
-- Found by running the live verification rather than by reasoning: every call
-- came back 406 PGRST106, "Invalid schema: approvals". PostgREST's exposed
-- list is `pgrst.db_schemas` on the `authenticator` role, which is what the
-- dashboard's "Exposed schemas" setting writes and what supabase/config.toml
-- seeds locally — and neither of them knows about a schema a migration just
-- created. Left as a deployment step it would be forgotten exactly once, and
-- the failure mode is every approval call in production returning 406.
--
-- So the migration adds itself to the list, and does it by APPENDING: it reads
-- what is configured and adds one entry if it is missing. It never writes a
-- list of its own, because doing that would silently drop whatever a later
-- schema or a dashboard edit had added.
--
-- Best effort by design. If the role cannot be altered — a hosted project
-- where `postgres` lacks the grant — the migration says so and carries on
-- rather than failing the deploy, and AGENCYOS_OPERATIONS.md §2.4 names the
-- dashboard toggle that does the same thing by hand.
do $$
declare
  v_list text;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    raise notice 'no authenticator role: nothing to expose (a plain Postgres, not a Supabase project)';
    return;
  end if;

  select split_part(cfg, '=', 2)
    into v_list
    from pg_roles r, unnest(r.rolconfig) as cfg
   where r.rolname = 'authenticator'
     and cfg like 'pgrst.db_schemas=%';

  if v_list is null then
    raise notice 'pgrst.db_schemas is unset; leaving the platform default alone';
    return;
  end if;

  if position('approvals' in v_list) > 0 then
    return;
  end if;

  execute format('alter role authenticator set pgrst.db_schemas = %L', v_list || ', approvals');
  notify pgrst, 'reload config';
exception
  when insufficient_privilege then
    raise warning
      'could not expose the approvals schema (%). Add it in Dashboard -> Project Settings -> API -> Exposed schemas, or every approval call answers 406 PGRST106.',
      sqlerrm;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Policy — who must approve what, as data
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists approvals.approval_policies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  subject_type     text not null check (subject_type in (
                     'proposal', 'deliverable', 'invoice', 'refund',
                     'scope_change', 'prototype', 'agent_action', 'ticket_plan')),

  -- The condition, deliberately one dimension rather than an expression
  -- language. Every rule the agency has actually stated is a money threshold
  -- ("over ₹5L needs the owner"), and a jsonb predicate nobody can read is a
  -- worse answer than a column somebody can. A second dimension is a migration
  -- away; an expression evaluator is a security surface.
  --
  -- Resolution takes the highest threshold at or below the amount, so a policy
  -- set is a ladder: 0 → ops_admin, 500000000 → owner.
  min_amount_minor bigint not null default 0 check (min_amount_minor >= 0),

  required_role    text not null check (required_role in ('owner', 'ops_admin', 'delivery_lead')),

  -- Hours, not an interval: it is the unit every SLA conversation uses, and it
  -- keeps the column comparable and averageable without casting.
  sla_hours        int not null check (sla_hours > 0 and sla_hours <= 8760),

  audience         text not null default 'internal' check (audience in ('internal', 'client')),

  active           boolean not null default true,
  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Money never drops below the role that already holds it today. A refund is
  -- owner-only in the capability matrix; an invoice is owner or ops_admin.
  -- Policy may make either stricter. It may not make them looser.
  constraint approval_policies_money_floor check (
    case
      when subject_type = 'refund'  then required_role = 'owner'
      when subject_type = 'invoice' then required_role in ('owner', 'ops_admin')
      else true
    end
  )
);

comment on table approvals.approval_policies is
  'Who must approve a given subject type, above a given amount, and how long they have. Data rather than migrations (ADM-08b), so a threshold changes with an UPDATE. Owner-only to write, audited on every change. A policy row grants nothing — it only ever says who must consent.';

-- Two active policies at the same threshold would make resolution a coin
-- flip decided by whichever row the planner returned first. That is D22
-- exactly — an unordered LIMIT 1 over an ambiguity nobody had forbidden — and
-- it is closed the same way it was closed there: the ambiguous state is made
-- unrepresentable rather than the read made to pick a side.
create unique index if not exists approval_policies_threshold_key
  on approvals.approval_policies (organization_id, subject_type, min_amount_minor)
  where active;

create index if not exists approval_policies_lookup_idx
  on approvals.approval_policies (organization_id, subject_type, min_amount_minor desc)
  where active;

drop trigger if exists set_updated_at on approvals.approval_policies;
create trigger set_updated_at
  before update on approvals.approval_policies
  for each row execute function core.set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- Requests — one row per decision somebody owes
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists approvals.approval_requests (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,

  subject_type      text not null check (subject_type in (
                      'proposal', 'deliverable', 'invoice', 'refund',
                      'scope_change', 'prototype', 'agent_action', 'ticket_plan')),
  subject_id        uuid not null,

  policy_id         uuid references approvals.approval_policies(id) on delete set null,

  -- The rule in force when this was raised. Judged against the copy, not
  -- against the policy row, which may have been edited since — see the header.
  required_role     text not null check (required_role in ('owner', 'ops_admin', 'delivery_lead')),

  -- Agents are first-class requesters (§4.6). 'system' is the job runner and
  -- carries no id; a user or an agent must name itself.
  requested_by_type text not null check (requested_by_type in ('user', 'agent', 'system')),
  requested_by_id   uuid,

  audience          text not null default 'internal' check (audience in ('internal', 'client')),

  state             text not null default 'pending' check (state in (
                      'pending', 'approved', 'rejected', 'changes_requested',
                      'expired', 'cancelled')),

  summary           text,
  -- A snapshot of what is being approved, so the decision is readable a year
  -- later even if the subject has moved on. Not a foreign key by design: the
  -- point is what it looked like when it was asked.
  payload           jsonb,
  amount_minor      bigint check (amount_minor is null or amount_minor >= 0),

  sla_due_at        timestamptz not null,

  decided_at        timestamptz,
  decided_by        uuid references core.users(id) on delete set null,
  decision_note     text,

  -- ADM-08d. A client decision is recorded by a member of staff, and the row
  -- says so: decided_by is the staff member, client_contact_id is who actually
  -- agreed, evidence_ref is where to go and read it.
  client_contact_id uuid references crm.contacts(id) on delete set null,
  evidence_ref      text,

  -- ADM-08c. When expiry lands (G-096), the escalation names its parent, so a
  -- chain of unanswered requests reads as one story rather than three rows.
  escalated_from    uuid references approvals.approval_requests(id) on delete set null,

  correlation_id    uuid,
  created_at        timestamptz not null default now(),

  -- A pending row has decided nothing; a settled row was settled at some time.
  --
  -- It deliberately does NOT require decided_by on a settled row, and the
  -- reason is a `on delete set null` that would otherwise make people
  -- undeletable: removing a user fires an UPDATE nulling decided_by on every
  -- request they ever settled, and a constraint demanding it would refuse the
  -- delete. Found by trying to remove a fixture user, which is the cheapest
  -- possible way to find it.
  --
  -- The durable record of who decided is the audit row, which carries the
  -- actor and a snapshot of the whole request and cannot be edited or deleted
  -- (audit.reject_mutation). decided_by here is a live pointer for display; a
  -- decision whose decider has since been removed reads as an empty column and
  -- a full audit entry, which is the honest pair. What still holds always is
  -- that `decide_approval` writes the actor at the moment it settles — it has
  -- already refused a caller without one.
  constraint approval_requests_decision_shape check (
    case state
      when 'pending' then decided_at is null and decided_by is null and decision_note is null
      else decided_at is not null
    end
  ),

  -- ADM-08d, in DDL rather than in a service that could forget: a client
  -- decision recorded without saying where it came from is hearsay.
  constraint approval_requests_client_evidence check (
    audience <> 'client'
    or state in ('pending', 'expired', 'cancelled')
    or (evidence_ref is not null and length(btrim(evidence_ref)) > 0)
  ),

  constraint approval_requests_requester_shape check (
    case requested_by_type
      when 'system' then requested_by_id is null
      else requested_by_id is not null
    end
  )
);

comment on table approvals.approval_requests is
  'One row per decision a human owes: proposals, deliverables, invoices, refunds, scope changes, prototypes, agent actions and ticket plans, internal or client. Raised through approvals.request_approval and settled through approvals.decide_approval; direct writes are refused by RLS, because a decision that skipped the role check would look identical to one that passed it.';

-- One open request per subject. Two pending approvals for the same invoice is
-- two people about to answer the same question, and whichever answer lands
-- second has no meaning. The D21 shape: partial on the unsettled state, so a
-- subject may be raised again after its first request is settled — a rejected
-- deliverable is resubmitted, which is the ordinary path, not an error.
create unique index if not exists approval_requests_open_subject_key
  on approvals.approval_requests (organization_id, subject_type, subject_id)
  where state = 'pending';

-- The approval centre's query: what is waiting, oldest deadline first.
create index if not exists approval_requests_queue_idx
  on approvals.approval_requests (organization_id, state, sla_due_at);

create index if not exists approval_requests_subject_idx
  on approvals.approval_requests (subject_type, subject_id);

-- ── the transitions, held by the database ────────────────────────────────
--
-- pending → approved | rejected | changes_requested | expired | cancelled,
-- and nothing else ever moves again. Held here rather than in TypeScript for
-- the reason SECURITY.md gives: anything two callers could race is enforced in
-- Postgres. Two people opening the same request and clicking opposite buttons
-- is exactly that race.
create or replace function approvals.approval_requests_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.state <> 'pending' then
    -- One exception, and it is not a loophole: four columns here are foreign
    -- keys declared `on delete set null` — policy_id, decided_by,
    -- client_contact_id and escalated_from. Deleting the row on the other end
    -- of any of them fires an UPDATE against this settled request, and
    -- refusing it makes the parent undeletable rather than protecting
    -- anything. Found by trying: an approval policy could not be removed once
    -- a single settled request referenced it, and neither could the user who
    -- had decided one.
    --
    -- What is allowed is exactly that: a non-null becoming null in those four
    -- columns and nothing else changing. The comparison is total — every
    -- other column, by value — so this cannot be widened by accident.
    if new.policy_id         is not distinct from (case when old.policy_id         is null then null else new.policy_id end)
       and to_jsonb(new) - 'policy_id' - 'decided_by' - 'client_contact_id' - 'escalated_from'
         = to_jsonb(old) - 'policy_id' - 'decided_by' - 'client_contact_id' - 'escalated_from'
       and (new.policy_id         is null or new.policy_id         is not distinct from old.policy_id)
       and (new.decided_by        is null or new.decided_by        is not distinct from old.decided_by)
       and (new.client_contact_id is null or new.client_contact_id is not distinct from old.client_contact_id)
       and (new.escalated_from    is null or new.escalated_from    is not distinct from old.escalated_from)
    then
      return new;
    end if;

    raise exception
      'approval request % is already %; a settled decision is not re-decided',
      old.id, old.state
      using errcode = 'restrict_violation';
  end if;

  if new.state = 'pending' and old.state = 'pending' then
    -- Editing a pending request in place would move the question after it was
    -- asked. Cancel it and raise another.
    if new.subject_type is distinct from old.subject_type
       or new.subject_id      is distinct from old.subject_id
       or new.required_role   is distinct from old.required_role
       or new.audience        is distinct from old.audience
       or new.payload         is distinct from old.payload
       or new.amount_minor    is distinct from old.amount_minor
    then
      raise exception
        'approval request % cannot be rewritten while pending; cancel it and raise another',
        old.id
        using errcode = 'restrict_violation';
    end if;
  end if;

  if new.organization_id  is distinct from old.organization_id
     or new.created_at    is distinct from old.created_at
     or new.requested_by_type is distinct from old.requested_by_type
     or new.requested_by_id   is distinct from old.requested_by_id
  then
    raise exception
      'approval request % may not change tenancy, requester or creation time',
      old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists approval_requests_guard on approvals.approval_requests;
create trigger approval_requests_guard
  before update on approvals.approval_requests
  for each row execute function approvals.approval_requests_guard();

-- Deleting a decision is rewriting history. The audit log refuses it
-- (audit.reject_mutation); so does this.
create or replace function approvals.reject_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'approval requests are never deleted; cancel them'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists approval_requests_no_delete on approvals.approval_requests;
create trigger approval_requests_no_delete
  before delete on approvals.approval_requests
  for each row execute function approvals.reject_delete();

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS
--
-- Requests: internal roles read their organization's queue. Nobody writes
-- directly — there is no insert, update or delete policy, so PostgREST refuses
-- all three and the only way in is the two functions below, which check the
-- role themselves. This is deliberately stricter than the finance pattern,
-- where SECURITY INVOKER plus a write policy is enough: there the RLS policy
-- *is* the rule ("owner or ops_admin"), while here the rule is per-request and
-- lives in the row. A write policy wide enough to let a delivery_lead settle
-- their own request would be D16 again — RLS materially wider than the
-- capability it is standing in for.
--
-- The client portal is not opened here. ADM-08d put the client's decision in a
-- staff member's hands, so a client-audience row is still read and settled
-- internally. When the portal exists (G-057) that is a select policy on
-- client_account, not a change to any of this.
-- ═══════════════════════════════════════════════════════════════════════════

alter table approvals.approval_policies  enable row level security;
alter table approvals.approval_requests  enable row level security;

drop policy if exists approval_requests_select on approvals.approval_requests;
create policy approval_requests_select on approvals.approval_requests
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists approval_policies_select on approvals.approval_policies;
create policy approval_policies_select on approvals.approval_policies
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- ADM-08b: owner-editable. Exactly owner — ops_admin may decide within a
-- policy but may not rewrite the policy that binds them.
drop policy if exists approval_policies_write on approvals.approval_policies;
create policy approval_policies_write on approvals.approval_policies
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_owner())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_owner())
  );

-- ── every policy change is audited, from inside its own transaction ──────
--
-- The G-079 rule: a history row that is never written can never be written
-- later, because audit.audit_log is append-only by trigger. A trigger is the
-- right shape here rather than a service call, because the write path is RLS
-- plus PostgREST — there is no service function to put the audit inside.
create or replace function approvals.audit_policy_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform core.record_audit(
    coalesce(new.organization_id, old.organization_id),
    'approval_policy.' || lower(tg_op),
    'approval_policy',
    coalesce(new.id, old.id),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists approval_policies_audit on approvals.approval_policies;
create trigger approval_policies_audit
  after insert or update or delete on approvals.approval_policies
  for each row execute function approvals.audit_policy_change();

-- ═══════════════════════════════════════════════════════════════════════════
-- Resolution
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function approvals.resolve_policy(
  p_organization_id uuid,
  p_subject_type    text,
  p_amount_minor    bigint default null
)
returns approvals.approval_policies
language sql
stable
security definer
set search_path = ''
as $$
  select *
    from approvals.approval_policies
   where organization_id = p_organization_id
     and subject_type    = p_subject_type
     and active
     and min_amount_minor <= coalesce(p_amount_minor, 0)
   order by min_amount_minor desc
   limit 1;
$$;

comment on function approvals.resolve_policy(uuid, text, bigint) is
  'The active policy binding this subject type at this amount: the highest threshold at or below it. approval_policies_threshold_key makes the ordering total, so this cannot be the unordered LIMIT 1 that D22 was.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Raising a request
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function approvals.request_approval(
  p_organization_id   uuid,
  p_subject_type      text,
  p_subject_id        uuid,
  p_requested_by_type text,
  p_requested_by_id   uuid default null,
  p_summary           text default null,
  p_payload           jsonb default null,
  p_amount_minor      bigint default null,
  p_audience          text default null,
  p_correlation_id    uuid default null
)
returns table (
  -- 'requested' | 'already_pending' | 'no_policy' | 'forbidden'
  outcome        text,
  request_id     uuid,
  state          text,
  required_role  text,
  sla_due_at     timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_policy   approvals.approval_policies;
  v_existing approvals.approval_requests;
  v_row      approvals.approval_requests;
begin
  -- G-084's lesson, one schema along: a caller that HAS an identity is bound
  -- to its own tenant, and only a caller with none — the service role running
  -- a job or an agent — may name an organization freely. Without this, a
  -- signed-in user could raise a request inside somebody else's tenant, which
  -- would then appear in that agency's approval queue.
  if v_actor is not null
     and p_organization_id is distinct from (select core.current_organization_id())
  then
    return query select 'forbidden'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  v_policy := approvals.resolve_policy(p_organization_id, p_subject_type, p_amount_minor);

  -- No policy is not a default-open. Nothing is approved, nothing is raised,
  -- and the caller is told why — the alternative is a request nobody is named
  -- to answer, which is a queue entry that rots.
  if v_policy.id is null then
    return query select 'no_policy'::text, null::uuid, null::text, null::text, null::timestamptz;
    return;
  end if;

  begin
    insert into approvals.approval_requests (
      organization_id, subject_type, subject_id, policy_id, required_role,
      requested_by_type, requested_by_id, audience, summary, payload,
      amount_minor, sla_due_at, correlation_id
    )
    values (
      p_organization_id, p_subject_type, p_subject_id, v_policy.id, v_policy.required_role,
      p_requested_by_type, p_requested_by_id, coalesce(p_audience, v_policy.audience),
      p_summary, p_payload, p_amount_minor,
      now() + make_interval(hours => v_policy.sla_hours), p_correlation_id
    )
    returning * into v_row;
  exception
    when unique_violation then
      -- approval_requests_open_subject_key. Two callers raised the same
      -- question at once, or a retry arrived: answer with the request that
      -- exists rather than failing, which is what makes this idempotent for
      -- a webhook or a job that runs twice.
      -- Every column is qualified, and that is not style. `state`,
      -- `required_role`, `sla_due_at`, `outcome` and `request_id` are also the
      -- names of this function's OUT parameters, so an unqualified `state`
      -- here is ambiguous and plpgsql refuses it at run time — which is
      -- exactly what the live verification hit, and only on the second raise,
      -- because the first one never reaches this branch.
      select r.* into v_existing
        from approvals.approval_requests r
       where r.organization_id = p_organization_id
         and r.subject_type    = p_subject_type
         and r.subject_id      = p_subject_id
         and r.state           = 'pending';

      return query select 'already_pending'::text, v_existing.id, v_existing.state,
                          v_existing.required_role, v_existing.sla_due_at;
      return;
  end;

  perform core.record_audit(
    p_organization_id,
    'approval.requested',
    'approval_request',
    v_row.id,
    null,
    to_jsonb(v_row),
    p_correlation_id
  );

  return query select 'requested'::text, v_row.id, v_row.state, v_row.required_role, v_row.sla_due_at;
end;
$$;

comment on function approvals.request_approval(uuid, text, uuid, text, uuid, text, jsonb, bigint, text, uuid) is
  'Raises one approval request, or answers with the pending one that already exists. SECURITY DEFINER because the table takes no direct writes; a caller with an identity is bound to its own organization, and only an identity-less caller (the job runner, an agent) may name one.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Settling one
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function approvals.decide_approval(
  p_request_id        uuid,
  p_decision          text,
  p_note              text default null,
  p_evidence_ref      text default null,
  p_client_contact_id uuid default null
)
returns table (
  -- 'decided' | 'not_found' | 'already_decided' | 'forbidden' | 'no_actor'
  -- | 'evidence_required' | 'invalid_decision'
  outcome    text,
  request_id uuid,
  state      text,
  decided_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_role  text := (select core.current_user_role());
  v_org   uuid := (select core.current_organization_id());
  v_req   approvals.approval_requests;
  v_row   approvals.approval_requests;
begin
  if p_decision not in ('approved', 'rejected', 'changes_requested', 'cancelled') then
    return query select 'invalid_decision'::text, p_request_id, null::text, null::timestamptz;
    return;
  end if;

  -- Directive §29, in the one place it can be enforced rather than stated: a
  -- decision needs somebody who made it. The service role has no identity, so
  -- it may raise a request and it may never settle one. This is what stops an
  -- automation from quietly approving its own work.
  if v_actor is null then
    return query select 'no_actor'::text, p_request_id, null::text, null::timestamptz;
    return;
  end if;

  -- The lock is the point. Two people with the request open, one approving and
  -- one rejecting, is the ordinary case rather than the exotic one, and
  -- without this the second write would overwrite the first decision and its
  -- decider. Locked, the second sees a settled row and is told so.
  select r.* into v_req
    from approvals.approval_requests r
   where r.id = p_request_id
   for update;

  if v_req.id is null then
    return query select 'not_found'::text, p_request_id, null::text, null::timestamptz;
    return;
  end if;

  if v_req.organization_id is distinct from v_org then
    -- Answered as not_found rather than forbidden: whether a request exists in
    -- another tenant is not this caller's business either.
    return query select 'not_found'::text, p_request_id, null::text, null::timestamptz;
    return;
  end if;

  if v_req.state <> 'pending' then
    return query select 'already_decided'::text, v_req.id, v_req.state, v_req.decided_at;
    return;
  end if;

  -- The snapshot, not the policy row: see the header. owner outranks
  -- ops_admin outranks delivery_lead, and nothing else may settle anything.
  if not (
    v_role = 'owner'
    or (v_req.required_role = 'ops_admin'     and v_role = 'ops_admin')
    or (v_req.required_role = 'delivery_lead' and v_role in ('ops_admin', 'delivery_lead'))
  ) then
    return query select 'forbidden'::text, v_req.id, v_req.state, null::timestamptz;
    return;
  end if;

  -- ADM-08d. The constraint would refuse this write anyway; refusing it here
  -- means the caller gets a named outcome instead of a 23514 to interpret.
  if v_req.audience = 'client'
     and p_decision in ('approved', 'rejected', 'changes_requested')
     and (p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0)
  then
    return query select 'evidence_required'::text, v_req.id, v_req.state, null::timestamptz;
    return;
  end if;

  update approvals.approval_requests
     set state             = p_decision,
         decided_at        = now(),
         decided_by        = v_actor,
         decision_note     = p_note,
         evidence_ref      = coalesce(p_evidence_ref, evidence_ref),
         client_contact_id = coalesce(p_client_contact_id, client_contact_id)
   where approval_requests.id = v_req.id
     -- Restated on the write even though the row is held, because the lock and
     -- the predicate answer different questions, and D18's review is the
     -- reason this repository restates both.
     --
     -- Qualified for the same reason as the select above: `state` and
     -- `decided_at` are OUT parameters of this function as well as columns of
     -- this table. Unqualified, every settle failed and only the early
     -- returns — forbidden, evidence_required — appeared to work.
     and approval_requests.state = 'pending'
  returning * into v_row;

  perform core.record_audit(
    v_row.organization_id,
    'approval.' || p_decision,
    'approval_request',
    v_row.id,
    to_jsonb(v_req),
    to_jsonb(v_row),
    v_row.correlation_id
  );

  return query select 'decided'::text, v_row.id, v_row.state, v_row.decided_at;
end;
$$;

comment on function approvals.decide_approval(uuid, text, text, text, uuid) is
  'Settles one pending request under a row lock, against the required_role snapshotted when it was raised. Refuses a caller with no identity (directive §29: absence of a response is never approval, and neither is a service role), a caller in another tenant, a settled request, and a client-audience decision with no evidence (ADM-08d).';

-- ═══════════════════════════════════════════════════════════════════════════
-- Grants — the functions are the surface
-- ═══════════════════════════════════════════════════════════════════════════

revoke all on function approvals.request_approval(uuid, text, uuid, text, uuid, text, jsonb, bigint, text, uuid) from public;
revoke all on function approvals.decide_approval(uuid, text, text, text, uuid) from public;
revoke all on function approvals.resolve_policy(uuid, text, bigint) from public;

grant execute on function approvals.request_approval(uuid, text, uuid, text, uuid, text, jsonb, bigint, text, uuid) to authenticated, service_role;
grant execute on function approvals.decide_approval(uuid, text, text, text, uuid) to authenticated;
grant execute on function approvals.resolve_policy(uuid, text, bigint) to authenticated, service_role;

grant usage on schema approvals to authenticated, service_role;
grant select on approvals.approval_requests to authenticated;
grant select, insert, update, delete on approvals.approval_policies to authenticated;
grant select, insert, update on approvals.approval_requests to service_role;
grant select, insert, update, delete on approvals.approval_policies to service_role;
