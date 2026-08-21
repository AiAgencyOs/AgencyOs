-- ═══════════════════════════════════════════════════════════════════════════
-- The events the documents name.
--
-- Document 23 §7 lists twenty-six **Canonical Business Events**. AgencyOS
-- emits nine event types, and not one of them is one of the twenty-six — the
-- two vocabularies barely overlap, because §7 names business milestones
-- (`ScopeFrozen`, `PaymentVerified`, `TestRunCompleted`) and the repository
-- names row states (`invoice.paid`, `proposal.sent`).
--
-- That is not a naming quibble. Six of §7's events describe transitions
-- AgencyOS **now performs and records** — a baseline freezing, a change
-- request submitted and decided, a payment claimed and verified, a test run
-- filed — and every one of them happened silently. Nothing downstream could
-- ever react to them, because there was nothing to react to.
--
-- ── two things, and the difference matters ──────────────────────────────
--
-- `core.event_types` is what this system **emits**. It is a closed set now, so
-- an event type nobody declared cannot be written at all — a typo in an emitter
-- used to produce a durable row that no subscriber would ever match and no
-- check would ever notice, which is the quietest failure in an event system
-- (Doc 23 §5, §18).
--
-- **Closing a set is only as safe as the enumeration behind it**, and this one
-- took three attempts. Reading the SQL migrations found nine types. It missed
-- `followup.queued`, which is emitted from TypeScript through PostgREST, and
-- it missed `proposal.accepted`/`proposal.rejected`, whose type is CONSTRUCTED
-- at runtime as `'proposal.' || p_response` and therefore appears nowhere as a
-- literal for any reader or checker to find. Both were found by replaying the
-- whole verification chain and watching real scripts go red. A repository test
-- now covers the first class and names the second explicitly, because a check
-- that cannot see something should say so rather than imply coverage.
--
-- `core.canonical_events` is what Document 23 §7 **specifies**, all twenty-six,
-- including the twenty this system does not emit. Listed rather than omitted,
-- for the reason Doc 14 §21's unmeasurable gates are listed: a specified thing
-- absent from the record reads as a thing that was never specified. `emitted_as`
-- is null for those twenty, and null is the honest answer — a mapping nobody
-- has decided is not one this migration may invent.
--
-- ── emitted by trigger, not by editing six functions ────────────────────
--
-- The precedent is `events_written_where_the_state_changes`: an event belongs
-- to the row whose change it describes, so it is written where that change
-- lands. Re-emitting six existing functions to add a `perform core.emit_event`
-- to each is how a branch gets silently dropped — this repository has done
-- that once and recorded it — and a trigger also covers every path that moves
-- the row rather than the one that exists today.
--
-- ── what is deliberately NOT added ──────────────────────────────────────
--
-- **No subscriptions.** `src/lib/events/catalog.ts` says why, and it is right:
-- *"listing them here would enqueue jobs nothing consumes, which is a backlog
-- of dead work masquerading as an integration."* These six events are now
-- durable, ordered, correlated facts (Doc 23 §41's automation audit); a
-- handler arrives when there is something for it to do, and the dispatcher
-- already marks an unsubscribed event published rather than leaving it to
-- accumulate.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.event_types (
  type        text primary key check (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  description text not null check (length(trim(description)) > 0),
  -- The Doc 23 §7 name this is, where it is one of them. Null where the
  -- repository emits something §7 does not name.
  canonical   text
);

comment on table core.event_types is
  'Every event type this system may emit. Closed, so a typo in an emitter is refused rather than producing a durable row no subscriber will ever match and no check will ever notice (Doc 23 sections 5 and 18).';

insert into core.event_types (type, description, canonical) values
  -- The nine that already existed. None of them is a Doc 23 §7 name, and
  -- forcing a mapping would be inventing one: `proposal.sent` is not
  -- `QuoteCreated`, and calling it that would make the coverage number a
  -- statement about this migration's optimism rather than about the system.
  ('lead.returned',       'A past client came back (ADM-05).',                        null),
  ('proposal.sent',       'A quotation was sent to a client.',                        null),
  ('proposal.lapsed',     'A sent quotation passed its validity date (ADM-71).',      null),
  ('invoice.created',     'An invoice row was created.',                              null),
  ('invoice.issued',      'An invoice was issued to a client.',                       null),
  ('invoice.paid',        'Recorded payments cover an invoice in full.',              null),
  ('invoice.voided',      'An invoice was voided.',                                   null),
  ('payment.recorded',    'A payment was written into the ledger.',                   null),
  ('approval.requested',  'An approval request was raised (ADM-08).',                 null),
  -- The tenth, and the one that proved this list has to be DERIVED rather
  -- than typed. It is emitted from TypeScript — `src/modules/crm/follow-up-
  -- worker.ts` calls `core.emit_event` through PostgREST — and an enumeration
  -- of the SQL migrations missed it entirely. Three verification scripts went
  -- red before anybody noticed, which is a cheaper way to find out than
  -- production, and only because the whole chain gets replayed.
  ('followup.queued',     'A follow-up message was queued for delivery (ADM-69).',    null),

  -- The eleventh and twelfth, and the ones that show a static scan can never
  -- prove this list complete. `sales.record_proposal_response` emits
  -- `'proposal.' || p_response` — the type is BUILT AT RUNTIME, so no literal
  -- appears anywhere for a reader or a checker to find. It guards
  -- `p_response not in ('accepted', 'rejected')` immediately above, which is
  -- why exactly these two can occur.
  --
  -- Found the same way `followup.queued` was: by replaying the whole chain and
  -- watching `db:verify:quotations` go red. A closed set is only as safe as
  -- the enumeration behind it, and the enumeration cannot be done by reading.
  ('proposal.accepted',   'A client accepted a quotation.',                           null),
  ('proposal.rejected',   'A client declined a quotation.',                           null),

  -- The six Doc 23 §7 names AgencyOS can now honestly emit, because the
  -- transitions they describe exist and are recorded.
  ('scope.frozen',              'A scope baseline became the agreed one (Doc 11 §1).',     'ScopeFrozen'),
  ('change_request.submitted',  'A client asked for something outside the baseline.',      'ChangeRequestSubmitted'),
  ('change_request.approved',   'A change request was approved against a baseline.',       'ChangeRequestApproved'),
  ('payment.submitted',         'A payment was claimed and not yet checked (Doc 15 §11).', 'PaymentSubmitted'),
  ('payment.verified',          'A person verified a payment claim (Doc 15 §12).',         'PaymentVerified'),
  ('test_run.completed',        'A test suite was run against a build (Doc 14).',          'TestRunCompleted')
on conflict (type) do nothing;

-- ── an event type nobody declared cannot be EMITTED ─────────────────────
--
-- In `core.emit_event`, not as a trigger on `core.outbox_events`, and the
-- reason is worth stating because this repository's default is the opposite.
--
-- A row rule binds every path that writes the row, which is normally the
-- stronger choice. Here it binds one path too many. Every emitter in AgencyOS
-- goes through `emit_event` — all nine of the pre-existing types and all six
-- added below — so the rule catches **the entire risk it exists for**: an
-- emitter with a typo in its type string. The paths it would *additionally*
-- catch are verification fixtures inserting marker-typed rows directly
-- (`zztest-backlog.event` and four others), which are not emitters and whose
-- types deliberately cannot collide with a real one.
--
-- Tried as a row trigger first, and the chain replay is what settled it: five
-- scripts failed, none of them because of a defect. The alternative — a
-- `zztest` exemption in production DDL — is a hole that admits anything, to
-- protect a case that is not the case this rule is about.
--
-- `emit_event` is redefined wholly rather than patched, which this repository
-- warns about (re-emitting is how a branch gets silently dropped). Its body is
-- six lines, reproduced below unchanged apart from the guard, and the SECURITY
-- INVOKER stance and the grants are untouched.

create or replace function core.emit_event(
  p_organization_id uuid,
  p_type            text,
  p_subject_type    text,
  p_subject_id      uuid,
  p_payload         jsonb default '{}'::jsonb,
  p_correlation_id  uuid default null
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if not exists (select 1 from core.event_types t where t.type = p_type) then
    raise exception
      'event type "%" is not declared in core.event_types; an undeclared type is a durable row no subscriber will ever match and no check will ever notice (Doc 23 §5)',
      p_type
      using errcode = 'check_violation';
  end if;

  insert into core.outbox_events (
    organization_id, type, subject_type, subject_id, payload, correlation_id
  )
  values (
    p_organization_id, p_type, p_subject_type, p_subject_id,
    coalesce(p_payload, '{}'::jsonb), p_correlation_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function core.emit_event(uuid, text, text, uuid, jsonb, uuid) is
  'Appends one row to core.outbox_events from inside a caller''s transaction, so the event commits with the state change it describes. Refuses a type not declared in core.event_types (Doc 23 sections 5 and 18). SECURITY INVOKER: outbox_insert still decides who may publish and into which organization.';

revoke all on function core.emit_event(uuid, text, text, uuid, jsonb, uuid)
  from public, anon;
grant execute on function core.emit_event(uuid, text, text, uuid, jsonb, uuid)
  to authenticated, service_role;

-- ── Doc 23 §7, all twenty-six ───────────────────────────────────────────

create table if not exists core.canonical_events (
  name        text primary key,
  position    int not null,
  -- The `core.event_types.type` that IS this event, where one exists. Null for
  -- the twenty AgencyOS does not emit — and null is the answer, not a gap
  -- somebody should fill by guessing.
  emitted_as  text references core.event_types(type) on delete set null
);

comment on table core.canonical_events is
  'Document 23 section 7''s twenty-six canonical business events, including the twenty this system does not emit. Listed rather than omitted, for the reason Doc 14 section 21''s unmeasurable gates are listed: a specified thing absent from the record reads as a thing that was never specified.';

insert into core.canonical_events (name, position, emitted_as) values
  ('LeadCreated', 1, null),
  ('LeadQualified', 2, null),
  ('QuoteCreated', 3, null),
  ('QuoteAccepted', 4, null),
  ('ProjectCreated', 5, null),
  ('ScopeApproved', 6, null),
  ('ScopeFrozen', 7, 'scope.frozen'),
  ('ChangeRequestSubmitted', 8, 'change_request.submitted'),
  ('ChangeRequestApproved', 9, 'change_request.approved'),
  ('DesignApproved', 10, null),
  ('PrototypeApproved', 11, null),
  ('DevelopmentTaskReady', 12, null),
  ('BuildCreated', 13, null),
  ('TestRunCompleted', 14, 'test_run.completed'),
  ('ReleaseApproved', 15, null),
  ('PaymentSubmitted', 16, 'payment.submitted'),
  ('PaymentVerified', 17, 'payment.verified'),
  ('MilestoneCompleted', 18, null),
  ('DeploymentSucceeded', 19, null),
  ('HandoverReady', 20, null),
  ('ClientAccepted', 21, null),
  ('ProjectCompleted', 22, null),
  ('MaintenanceRenewalDue', 23, null),
  ('SupportTicketCreated', 24, null),
  ('CustomerHealthChanged', 25, null),
  ('UpsellOpportunityCreated', 26, null)
on conflict (name) do nothing;

create or replace function core.event_coverage()
returns table (
  canonical  text,
  emitted_as text,
  state      text   -- 'emitted' | 'not_emitted'
)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.name, c.emitted_as,
         case when c.emitted_as is null then 'not_emitted' else 'emitted' end
    from core.canonical_events c
   order by c.position;
$$;

comment on function core.event_coverage() is
  'How much of Document 23 section 7 AgencyOS actually emits. Derived from core.canonical_events rather than counted by hand, because a hand-derived coverage number in an audit memo goes stale the moment anybody ships.';

-- ── the six, written where their state changes ──────────────────────────

create or replace function projects.emit_scope_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' then
    perform core.emit_event(
      new.organization_id, 'scope.frozen', 'scope_version', new.id,
      jsonb_build_object('project_id', new.project_id, 'version', new.version)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_scope_frozen on projects.scope_versions;
create trigger emit_scope_frozen
  after update of status on projects.scope_versions
  for each row execute function projects.emit_scope_frozen();

create or replace function projects.emit_change_request_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform core.emit_event(
      new.organization_id, 'change_request.submitted', 'change_request', new.id,
      jsonb_build_object('project_id', new.project_id, 'scope_version_id', new.scope_version_id)
    );
    return new;
  end if;

  if new.status = 'approved' and old.status is distinct from 'approved' then
    perform core.emit_event(
      new.organization_id, 'change_request.approved', 'change_request', new.id,
      jsonb_build_object(
        'project_id', new.project_id,
        'classification', new.classification,
        'proposal_id', new.proposal_id
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_change_request_event on projects.change_requests;
create trigger emit_change_request_event
  after insert or update of status on projects.change_requests
  for each row execute function projects.emit_change_request_event();

create or replace function finance.emit_payment_submission_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform core.emit_event(
      new.organization_id, 'payment.submitted', 'payment_submission', new.id,
      jsonb_build_object('invoice_id', new.invoice_id, 'amountMinor', new.amount_minor)
    );
    return new;
  end if;

  if new.status = 'verified' and old.status is distinct from 'verified' then
    perform core.emit_event(
      new.organization_id, 'payment.verified', 'payment_submission', new.id,
      jsonb_build_object('invoice_id', new.invoice_id, 'amountMinor', new.amount_minor)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_payment_submission_event on finance.payment_submissions;
create trigger emit_payment_submission_event
  after insert or update of status on finance.payment_submissions
  for each row execute function finance.emit_payment_submission_event();

create or replace function qa.emit_test_run_completed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform core.emit_event(
    new.organization_id, 'test_run.completed', 'test_run', new.id,
    jsonb_build_object(
      'project_id', new.project_id, 'deliverable_id', new.deliverable_id,
      'suite', new.suite, 'total', new.total,
      'failed', new.failed, 'skipped', new.skipped
    )
  );
  return new;
end;
$$;

drop trigger if exists emit_test_run_completed on qa.test_runs;
create trigger emit_test_run_completed
  after insert on qa.test_runs
  for each row execute function qa.emit_test_run_completed();

-- ── reference data is readable ──────────────────────────────────────────

alter table core.event_types enable row level security;
alter table core.canonical_events enable row level security;

drop policy if exists event_types_read on core.event_types;
create policy event_types_read on core.event_types
  for select to authenticated using ((select core.is_internal()));

drop policy if exists canonical_events_read on core.canonical_events;
create policy canonical_events_read on core.canonical_events
  for select to authenticated using ((select core.is_internal()));

grant select on core.event_types, core.canonical_events to authenticated, service_role;
grant execute on function core.event_coverage() to authenticated, service_role;

notify pgrst, 'reload schema';
