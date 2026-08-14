-- ═══════════════════════════════════════════════════════════════════════════
-- Work that comes after handover.
--
-- Gap G-034. The business documentation defines maintenance **nowhere**. The
-- word appears exactly once in the whole of `docs/business-os`, in one arrow:
--
--   delivery → handover → completed → maintenance → repeat business
--
-- That is the entire specification, and this migration is deliberately no
-- larger than it.
--
-- ── the definition taken, and how narrow it is ───────────────────────────
--
-- **Maintenance is post-handover work performed for an existing client
-- relationship, represented internally.** Nothing more.
--
-- What is *not* here, because inventing any of it would be inventing a
-- product nobody has decided to sell:
--
--   · no price, no rate, no amount column of any kind
--   · no SLA, no response time, no due date — a due date on a support item
--     reads as a commitment, and no document makes one
--   · no packages, plans, tiers or subscriptions
--   · no renewal, no expiry, no guarantee
--   · no client-facing surface: no RLS policy for clients, no send path
--
-- A due date is the one worth naming, because it looks harmless. "Due on
-- Friday" is a promise to somebody, and the agency has not agreed to make one.
--
-- ── why post-handover is enforced rather than assumed ────────────────────
--
-- The lifecycle puts maintenance after handover, and a maintenance item on a
-- project that was never delivered is not maintenance — it is delivery work
-- filed in the wrong place, which makes both records mean less.
--
-- A CHECK cannot reach another table, so it is a trigger. It refuses rather
-- than corrects: which of the two records is wrong is a judgement, and
-- guessing would move somebody's work without telling them.
--
-- If this proves too strict against real use, relaxing it is a one-line
-- change to a trigger. That direction is far easier than discovering later
-- that half the maintenance log is not maintenance.
--
-- ── what this unblocks, and what it deliberately does not ────────────────
--
-- G-036 implements two of §2.7's three upsell signals and leaves out "a
-- support pattern", because there was nothing to observe. There is now.
--
-- It is still not implemented here, and that is on purpose: a *pattern* means
-- a threshold — how many items, over how long — and no business rule states
-- one. Choosing a number would be exactly the invention G-036 refused.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.maintenance_items (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,

  -- The relationship it belongs to. Maintenance is something done for a
  -- client, and the client outlives the project — which is the whole reason
  -- the lifecycle continues past `completed`.
  client_account_id uuid not null references core.client_accounts(id) on delete cascade,

  -- The delivered work it follows from. Required: post-handover work with no
  -- project behind it has nothing to be "after".
  project_id        uuid not null references projects.projects(id) on delete cascade,

  title             text not null check (length(trim(title)) > 0),
  description       text,

  -- Deliberately four states and no more. `declined` is kept because "we were
  -- asked and said no" is a different fact from "nobody asked", and losing it
  -- would make the log read as though the request never happened.
  status            text not null default 'open'
                      check (status in ('open', 'in_progress', 'resolved', 'declined')),

  raised_at         timestamptz not null default now(),
  raised_by         uuid references core.users(id) on delete set null,

  -- Closed is a time and a state together, or neither. The same rule the
  -- validation stamps and the payment verification already follow: half of one
  -- reads as finished to anybody scanning.
  closed_at         timestamptz,
  closed_by         uuid references core.users(id) on delete set null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint maintenance_items_closed_together
    check ((status in ('resolved', 'declined')) = (closed_at is not null))
);

comment on table projects.maintenance_items is
  'Post-handover work for an existing client relationship (G-034). The business documentation defines maintenance NOWHERE - the word appears once, in a lifecycle arrow - so this is deliberately the smallest model consistent with it. It carries NO price, rate or amount, NO SLA, response time or due date, NO package, plan or tier, and NO client-facing surface. A due date is the one that looks harmless and is not: it reads as a commitment, and no document makes one.';

comment on column projects.maintenance_items.status is
  'open, in_progress, resolved or declined. declined is kept because "we were asked and said no" is a different fact from "nobody asked", and losing it would make the log read as though the request never happened.';

create index if not exists maintenance_items_open_idx
  on projects.maintenance_items (organization_id, client_account_id, raised_at desc)
  where status in ('open', 'in_progress');

-- ── internal only ────────────────────────────────────────────────────────
--
-- No client policy at all, matching `sales.upsell_signals`: an absent policy
-- is a stronger guarantee than one that excludes them, because there is
-- nothing to get wrong. Whether a client should be able to raise or read a
-- support item is a product decision nobody has taken.

alter table projects.maintenance_items enable row level security;

drop policy if exists maintenance_items_select on projects.maintenance_items;
create policy maintenance_items_select on projects.maintenance_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists maintenance_items_write on projects.maintenance_items;
create policy maintenance_items_write on projects.maintenance_items
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists set_updated_at on projects.maintenance_items;
create trigger set_updated_at
  before update on projects.maintenance_items
  for each row execute function core.set_updated_at();

-- ── after handover, and the database says so ─────────────────────────────

create or replace function projects.enforce_post_handover()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from projects.handovers h
     where h.project_id = new.project_id
       and h.status in ('delivered', 'accepted')
  ) then
    raise exception
      'maintenance refused: project % has no delivered handover, so there is nothing for this work to come after (G-034). The lifecycle is delivery, handover, completed, maintenance.',
      new.project_id
      using errcode = 'check_violation';
  end if;

  -- The client account must be the project's own. Without this a maintenance
  -- item could attach one client's relationship to another's delivered work,
  -- which RLS would not catch because both rows are in the same organization.
  if not exists (
    select 1
      from projects.projects p
     where p.id = new.project_id
       and p.client_account_id = new.client_account_id
  ) then
    raise exception
      'maintenance refused: the client account does not own project % (G-034).',
      new.project_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function projects.enforce_post_handover() is
  'Refuses a maintenance item on a project with no delivered handover, and one whose client account does not own the project (G-034). A CHECK cannot reach another table, so the rule lives here. It refuses rather than corrects: which of the two records is wrong is a judgement, and guessing would move somebody work without telling them.';

drop trigger if exists enforce_post_handover on projects.maintenance_items;
create trigger enforce_post_handover
  before insert or update of project_id, client_account_id on projects.maintenance_items
  for each row execute function projects.enforce_post_handover();
