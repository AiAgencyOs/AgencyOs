-- ═══════════════════════════════════════════════════════════════════════════
-- The conversation somebody has to have, prepared before they have it.
--
-- Document 17 §18 lists eleven things the Customer Success agent is for.
-- Nine of them are the same act: *review support history, identify unresolved
-- issues, identify training needs, identify renewal timing, identify potential
-- new requirements, route commercial opportunities to Sales.* Read what the
-- project left behind, and say what is worth raising.
--
-- The eleventh is the constraint that shapes all of it: **"Never promise free
-- work outside contract/policy."**
--
-- §17 says when: *"Day 0: Handover and acceptance. Early follow-up: confirm
-- access, launch/use and immediate blockers."* So the brief is drafted the
-- moment a handover is accepted — which until now was an audit row and
-- nothing more. `handover.accepted` is a real event from this migration on.
--
-- ── what a brief is, and what it is not ─────────────────────────────────
--
-- It is a list of points for a human to raise, each one a kind and a note.
-- It is not a message. Nothing sends it, no column holds a recipient, and
-- ADM-61 §3 puts client-facing work behind a person for exactly this reason:
-- §22 lists the check-in as customer success COMMUNICATION, and communicating
-- is the part the agent may not do alone.
--
-- Four absences, each one a rule:
--
--   no amount, price or discount   ADM-22 — every price is a human's, and
--                                  §18's "never promise free work" is the
--                                  same prohibition from the other side
--   no date or commitment          a brief that says "we'll fix it Friday"
--                                  is a promise, and promising is not
--                                  reviewing
--   no health score                §24 wants health "explainable and based on
--                                  recorded signals", and §12/§15 of Doc 18
--                                  put the weights in the Admin's hands.
--                                  ADM-88 already refused an invented lead
--                                  score; this is the same number
--   no status on anything          the brief moves no ticket, closes no
--                                  issue and opens no opportunity. It says
--                                  what to look at



insert into core.event_types (type, description, canonical)
values (
  'handover.accepted',
  'A client accepted the handover, so the project is theirs (Doc 17 §17 Day 0).',
  'HandoverAccepted'
)
on conflict (type) do nothing;

create or replace function projects.emit_handover_accepted()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only the transition, and only once. `accept_handover` already refuses to
  -- re-accept, but the event is emitted from the row's own change so a second
  -- path to acceptance would not need to remember to raise it.
  if new.status = 'accepted' and coalesce(old.status, '') <> 'accepted' then
    perform core.emit_event(
      new.organization_id, 'handover.accepted', 'handover', new.id,
      jsonb_build_object('project_id', new.project_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists emit_handover_accepted on projects.handovers;
create trigger emit_handover_accepted
  after update of status on projects.handovers
  for each row execute function projects.emit_handover_accepted();

create table if not exists crm.check_in_briefs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,

  -- The moment the brief is about. Doc 17 §17's Day 0, and the reason there
  -- is exactly one brief: a second handover is a different conversation.
  handover_id       uuid not null references projects.handovers(id) on delete cascade,

  drafted_by_agent  text references ai.agents(key),
  drafted_by        uuid references core.users(id),
  created_at        timestamptz not null default now(),

  constraint check_in_briefs_has_an_author check (
    drafted_by_agent is not null or drafted_by is not null
  )
);

create unique index if not exists check_in_briefs_one_per_handover
  on crm.check_in_briefs (handover_id);

create table if not exists crm.check_in_points (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  brief_id         uuid not null references crm.check_in_briefs(id) on delete cascade,

  -- Document 17 §18's responsibilities, as the only things a point can be.
  -- `possible_new_work` is §18's *"identify potential new requirements"* and
  -- *"route commercial opportunities to Sales"* — naming one, which is all
  -- the agent may do with it. There is no column here for what it would cost
  -- or whether it is included, because §18's last line is that it may not say.
  kind             text not null check (kind in (
    'confirm_access',
    'confirm_use',
    'unresolved_issue',
    'training_need',
    'feedback_to_collect',
    'renewal_timing',
    'possible_new_work'
  )),

  note             text not null check (length(btrim(note)) between 1 and 600),

  -- When the point is about something already recorded, it points at it. Doc
  -- 17 §18's *"review support history"* is only worth anything if the review
  -- refers to the history rather than to a memory of it.
  maintenance_item_id uuid references projects.maintenance_items(id) on delete set null,

  created_at       timestamptz not null default now()
);

comment on table crm.check_in_briefs is
  'Document 17 sections 17 and 18. What is worth raising with a client after they accept a handover, prepared for the person who will raise it. Carries no price (ADM-22), no commitment, no health score (section 24 and Doc 18 sections 12/15 put the weights with the Admin) and no status on anything - a brief says what to look at, and moves nothing.';

comment on table crm.check_in_points is
  'One point to raise, of one of Document 17 section 18''s kinds, with the note that says why. `possible_new_work` names a commercial opportunity and nothing more: section 18''s last line is "Never promise free work outside contract/policy", and there is no column here a promise could go in.';

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table crm.check_in_briefs enable row level security;
alter table crm.check_in_briefs force row level security;
alter table crm.check_in_points enable row level security;
alter table crm.check_in_points force row level security;

drop policy if exists check_in_briefs_select on crm.check_in_briefs;
create policy check_in_briefs_select on crm.check_in_briefs
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists check_in_points_select on crm.check_in_points;
create policy check_in_points_select on crm.check_in_points
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_check_in_briefs_project on crm.check_in_briefs;
create trigger org_match_check_in_briefs_project
  before insert or update of project_id, organization_id on crm.check_in_briefs
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_check_in_briefs_handover on crm.check_in_briefs;
create trigger org_match_check_in_briefs_handover
  before insert or update of handover_id, organization_id on crm.check_in_briefs
  for each row execute function core.enforce_parent_org('handover_id', 'projects.handovers');

drop trigger if exists freeze_org_check_in_briefs on crm.check_in_briefs;
create trigger freeze_org_check_in_briefs
  before update of organization_id on crm.check_in_briefs
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_check_in_points_brief on crm.check_in_points;
create trigger org_match_check_in_points_brief
  before insert or update of brief_id, organization_id on crm.check_in_points
  for each row execute function core.enforce_parent_org('brief_id', 'crm.check_in_briefs');

drop trigger if exists org_match_check_in_points_item on crm.check_in_points;
create trigger org_match_check_in_points_item
  before insert or update of maintenance_item_id, organization_id on crm.check_in_points
  for each row execute function core.enforce_parent_org('maintenance_item_id', 'projects.maintenance_items');

drop trigger if exists freeze_org_check_in_points on crm.check_in_points;
create trigger freeze_org_check_in_points
  before update of organization_id on crm.check_in_points
  for each row execute function core.freeze_organization_id();

grant select on crm.check_in_briefs to authenticated;
grant select, insert on crm.check_in_briefs to service_role;
grant select on crm.check_in_points to authenticated;
grant select, insert on crm.check_in_points to service_role;

-- ── and the agent that drafts them ───────────────────────────────────────

update ai.agents
   set enabled = true,
       disabled_reason = null
 where key = 'customer_success';

notify pgrst, 'reload schema';
