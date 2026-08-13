-- ═══════════════════════════════════════════════════════════════════════════
-- A won deal becomes a workspace.
--
-- Gap G-017, decision ADM-06. `convertToProject` has existed since the sales
-- module was built and does three things: it creates a client account, it
-- creates a project, and it marks the lead converted. Document 10 asks for
-- rather more than that, and §1 says why in one sentence — onboarding must
-- *"convert sales context into a clean, verified project workspace without
-- making the client repeat information already provided."*
--
-- ── what is carried forward, and what was being dropped ───────────────────
--
-- §1's list: sales history preserved, client identity reusable, **accepted
-- quotation becomes commercial project context**, confirmed requirements
-- become initial scope, payment state carried forward, ownership assigned,
-- WhatsApp linked.
--
-- Most of those already have a home. The lead, the opportunity and the client
-- account survive conversion; requirement versions are already keyed to the
-- conversation; the payment plan and milestones exist; the WhatsApp group is
-- `crm.conversations.kind = 'project_group'` and start already gates on it
-- (ADM-13). **The accepted quotation had nowhere to go at all** — until
-- G-011 there were no quotations, and now that there are, a project raised
-- from one keeps no reference to the numbers the client actually agreed to.
-- That is §7's "Accepted quote/version", and it is what this adds.
--
-- ── the gate §2 asks for, and why it is not built here ────────────────────
--
-- §2 says a project *"should not be created"* without commercial acceptance
-- and an available accepted quotation. That is deliberately **not** enforced,
-- and the reason is a decision the Admin already gave rather than an oversight:
--
--   ADM-13 answers the question "when does a project officially start?" with
--   exactly three conditions — the advance is verified, a requirement version
--   is approved, and the WhatsApp group exists — and an accepted quotation is
--   **not** among them. An advance is not paid without acceptance, so the
--   commercial reality §2 is protecting is already covered, at *start* rather
--   than at *creation*.
--
--   And every project in this system today predates quotations entirely. A
--   hard creation gate would strand each of them, refusing conversions that
--   are legitimate for the only reason that the feature did not exist when
--   the deal was won.
--
-- So the link is **carried when it exists and never demanded**. Whether §2's
-- sentence should become a fourth condition on `projects.start_project` is
-- **ADM-63**, and it is a business question: it decides whether an agency may
-- do work it has not written a price for.
--
-- ── the checklist blocks nothing, and that is the whole decision ──────────
--
-- ADM-06, in full: *"The onboarding checklist blocks nothing. Every item is a
-- reminder."* So this table has no gate function, nothing reads it to refuse
-- anything, and `projects.start_project` is untouched. It is a list somebody
-- works through, and the schema is shaped so it cannot quietly become more
-- than that.
--
-- The seventeen items are Document 10 §6's, in its order and its words. They
-- are not invented here, which matters because a checklist somebody made up is
-- a checklist nobody follows.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The numbers the client agreed to
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.projects
  -- §7's "Accepted quote/version". `on delete set null` rather than restrict:
  -- a quotation is never deleted in ordinary operation, so this arm is reached
  -- only when an organization is torn down, and taking the project with it
  -- would be worse than losing the link.
  add column if not exists proposal_id uuid
    references sales.proposals(id) on delete set null;

comment on column projects.projects.proposal_id is
  'The accepted quotation this project was raised from (Document 10 §7). Null for every project raised before quotations existed, and for any raised without one - ADM-13 does not make an accepted quotation a condition of starting, and ADM-63 asks whether it should.';

create index if not exists projects_proposal_idx
  on projects.projects (proposal_id)
  where proposal_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The checklist
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.onboarding_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- The order Document 10 §6 lists them in. Not a priority: the document's
  -- sequence is roughly the order the work happens in, and re-sorting it would
  -- lose that for no gain.
  position         int not null check (position >= 0),

  -- A stable machine name, so a rename of the label is a display change rather
  -- than a migration, and so `seed_onboarding` can be idempotent.
  key              text not null check (length(trim(key)) > 0),
  label            text not null check (length(trim(label)) > 0),

  -- `not_applicable` is a real answer and not a dodge: §6 says the checklist
  -- "should be configurable by project type", and until it is (G-113), a
  -- project that genuinely has no design references needs a way to say so that
  -- is not a lie in either direction.
  status           text not null default 'pending' check (status in
                     ('pending', 'done', 'not_applicable')),
  note             text,

  completed_by     uuid references core.users(id) on delete set null,
  completed_at     timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (project_id, key),

  -- A settled item knows when it was settled; a pending one carries neither
  -- half of an answer nobody gave. The same shape `approval_requests_decision_shape`
  -- uses, and for the same reason: half a decision is worse than none.
  constraint onboarding_items_completion_shape check (
    case status
      when 'pending' then completed_at is null and completed_by is null
      else completed_at is not null
    end
  )
);

comment on table projects.onboarding_items is
  'The onboarding checklist from Document 10 §6, one row per item per project. ADM-06: it blocks nothing - every item is a reminder, nothing reads this table to refuse anything, and projects.start_project is deliberately untouched by it.';

create index if not exists onboarding_items_project_idx
  on projects.onboarding_items (project_id, position);

create index if not exists onboarding_items_open_idx
  on projects.onboarding_items (organization_id, project_id)
  where status = 'pending';

drop trigger if exists set_updated_at on projects.onboarding_items;
create trigger set_updated_at
  before update on projects.onboarding_items
  for each row execute function core.set_updated_at();

-- ── RLS ───────────────────────────────────────────────────────────────────
--
-- Internal only, and `can_manage_delivery()` to write — the same set that
-- already owns milestones, tasks and deliverables. **Not** visible to the
-- client: the checklist names what the agency still has to chase out of them,
-- and half of it is internal assignment. Document 10 §12's rule, one table
-- along: internal operations are not exposed to the client.

alter table projects.onboarding_items enable row level security;

drop policy if exists onboarding_items_select on projects.onboarding_items;
create policy onboarding_items_select on projects.onboarding_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists onboarding_items_write on projects.onboarding_items;
create policy onboarding_items_write on projects.onboarding_items
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.can_manage_delivery())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.can_manage_delivery())
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Seeding it — Document 10 §6, in its order and its words
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.seed_onboarding(p_project_id uuid)
returns table (
  -- 'seeded' | 'already_seeded' | 'not_found'
  outcome text,
  items   int
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org      uuid;
  v_existing int;
  v_inserted int;
begin
  select p.organization_id into v_org
    from projects.projects p
   where p.id = p_project_id
   for update;

  if v_org is null then
    return query select 'not_found'::text, null::int;
    return;
  end if;

  select count(*) into v_existing
    from projects.onboarding_items i
   where i.project_id = p_project_id;

  -- Idempotent by the count rather than only by `on conflict`: a project whose
  -- checklist has been worked through and had an item deleted must not have it
  -- silently reinstated by a re-run of the conversion.
  if v_existing > 0 then
    return query select 'already_seeded'::text, v_existing;
    return;
  end if;

  insert into projects.onboarding_items (organization_id, project_id, position, key, label)
  select v_org, p_project_id, t.position, t.key, t.label
    from (values
      ( 0, 'client_identity_confirmed',     'Client identity confirmed'),
      ( 1, 'accepted_quotation_confirmed',  'Accepted quotation confirmed'),
      ( 2, 'commercial_terms_confirmed',    'Commercial terms confirmed'),
      ( 3, 'payment_verified',              'Payment or approved exception verified'),
      ( 4, 'project_name_confirmed',        'Project name confirmed'),
      ( 5, 'requirements_imported',         'Requirements imported'),
      ( 6, 'scope_version_created',         'Scope version created'),
      ( 7, 'timeline_assumptions_recorded', 'Timeline assumptions recorded'),
      ( 8, 'stakeholders_identified',       'Client stakeholders identified'),
      ( 9, 'assets_requested',              'Required assets requested'),
      (10, 'design_references_requested',   'Brand and design references requested'),
      (11, 'technical_access_identified',   'Technical access requirements identified'),
      (12, 'whatsapp_group_mapped',         'WhatsApp group created and mapped'),
      (13, 'project_manager_assigned',      'Project manager assigned'),
      (14, 'specialist_agents_assigned',    'Specialist agents assigned'),
      (15, 'kickoff_sent',                  'Kickoff communication sent'),
      (16, 'project_activated',             'Project status activated')
    ) as t(position, key, label)
  on conflict (project_id, key) do nothing;

  get diagnostics v_inserted = row_count;

  return query select 'seeded'::text, v_inserted;
end;
$$;

comment on function projects.seed_onboarding(uuid) is
  'Creates the Document 10 §6 checklist for a project, once. Idempotent by the existing count rather than only by the unique key, so an item somebody deleted is not silently reinstated by a repeated conversion.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Working through it
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.set_onboarding_item(
  p_item_id uuid,
  p_status  text,
  p_note    text default null,
  p_actor   uuid default null
)
returns table (
  -- 'set' | 'not_found' | 'invalid_status'
  outcome text,
  status  text,
  done    int,
  total   int
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row     projects.onboarding_items;
  v_project uuid;
  v_done    int;
  v_total   int;
begin
  if p_status not in ('pending', 'done', 'not_applicable') then
    return query select 'invalid_status'::text, null::text, null::int, null::int;
    return;
  end if;

  select i.* into v_row
    from projects.onboarding_items i
   where i.id = p_item_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text, null::int, null::int;
    return;
  end if;

  v_project := v_row.project_id;

  -- Un-ticking is allowed, and clears the answer with it: an item back in
  -- `pending` that still carried who ticked it and when would be a record of
  -- a decision that no longer holds. `onboarding_items_completion_shape`
  -- refuses the half-state outright.
  update projects.onboarding_items
     set status       = p_status,
         note         = coalesce(p_note, projects.onboarding_items.note),
         completed_by = case when p_status = 'pending' then null else p_actor end,
         completed_at = case when p_status = 'pending' then null else clock_timestamp() end
   where projects.onboarding_items.id = p_item_id;

  select count(*) filter (where i.status <> 'pending'), count(*)
    into v_done, v_total
    from projects.onboarding_items i
   where i.project_id = v_project;

  return query select 'set'::text, p_status, v_done, v_total;
end;
$$;

comment on function projects.set_onboarding_item(uuid, text, text, uuid) is
  'Ticks, un-ticks or excuses one checklist item and hands back the project''s progress. Gates nothing - ADM-06 says every item is a reminder - and un-ticking clears who answered, because a cleared item carrying an answer is a record of a decision that no longer holds.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Grants
-- ═══════════════════════════════════════════════════════════════════════════

revoke all on function projects.seed_onboarding(uuid) from public;
revoke all on function projects.set_onboarding_item(uuid, text, text, uuid) from public;

grant execute on function projects.seed_onboarding(uuid) to authenticated, service_role;
grant execute on function projects.set_onboarding_item(uuid, text, text, uuid) to authenticated, service_role;

grant select, insert, update, delete on projects.onboarding_items to authenticated, service_role;
