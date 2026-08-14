-- ═══════════════════════════════════════════════════════════════════════════
-- An opportunity the team is told about.
--
-- Gap G-036. The boundary is not mine and is not new. `docs/business-os`
-- §2.7 (ADM-22) states it outright:
--
--   "There is no price catalog. Every price is quoted per client, by a human.
--    AgencyOS may identify an opportunity — a completed project, a support
--    pattern, a feature request — and tell the team. **It must never state a
--    price**, and there is no list for it to state one from."
--
-- ── the trigger was not invented either ──────────────────────────────────
--
-- That sentence names the three signals. The only work here was mapping them
-- to facts this repository already records, and refusing to add a fourth:
--
--   completed project  →  `projects.projects.status = 'completed'`
--   feature request    →  a module added after the project started, which is
--                         scope arriving after the quotation was built
--   support pattern    →  **not implemented**. Maintenance has no model yet
--                         (G-034), so there is no pattern to observe. An
--                         invented proxy would be a made-up signal wearing
--                         §2.7's clothes.
--
-- No thresholds, no scores, no financial arithmetic. A threshold like "three
-- modules in thirty days" would be a business rule nobody wrote.
--
-- ── what this table cannot hold, structurally ────────────────────────────
--
-- **There is no price column, and no amount column of any kind.** ADM-22 says
-- an agent must never state a price; the surest enforcement is that there is
-- nowhere to put one. A future change that wanted to price an opportunity
-- would have to alter this table, which is a reviewable act rather than a
-- quiet one.
--
-- There is also **no client-facing anything**: no send path, no message body,
-- no template, no client visibility in RLS. An opportunity is a note to the
-- team. Turning one into an offer is a human's job, and the human decides the
-- price while they are at it.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists sales.upsell_signals (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- Who it concerns. Both are recorded because an opportunity is about a
  -- relationship, and the project is the evidence for it.
  client_account_id uuid not null references core.client_accounts(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,

  -- §2.7's own vocabulary, minus the one that has nothing to observe yet.
  kind             text not null check (kind in ('project_completed', 'scope_added')),

  -- What was seen, in the system's own terms: ids and counts, never prose that
  -- reads like a recommendation. A reader should be able to check the claim.
  evidence         jsonb not null default '{}'::jsonb,

  -- `open` until somebody looks at it. `dismissed` is a real outcome and is
  -- kept rather than deleted: the same signal firing again after a human said
  -- no is noise, and the only way to know is to remember the no.
  status           text not null default 'open'
                     check (status in ('open', 'acted_on', 'dismissed')),

  detected_at      timestamptz not null default now(),
  reviewed_by      uuid references core.users(id) on delete set null,
  reviewed_at      timestamptz,
  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One signal of a kind per project, forever. The detector runs every minute;
  -- without this it would file the same completed project sixty times an hour.
  -- Idempotence belongs in the constraint rather than in the detector, because
  -- a second detector would not inherit a detector's caution.
  constraint upsell_signals_once unique (organization_id, project_id, kind),

  -- A review is a person and a time, or neither. Half of one reads as reviewed
  -- to anybody scanning - the same rule ADM-83 applied to validation stamps.
  constraint upsell_signals_reviewed_together
    check ((reviewed_by is null) = (reviewed_at is null))
);

comment on table sales.upsell_signals is
  'Opportunities AgencyOS noticed and told the team about (G-036, ADM-22 section 2.7). INTERNAL ONLY: no client visibility in RLS, no send path, no message body. It has NO price or amount column of any kind, deliberately - ADM-22 says an agent must never state a price, and the surest enforcement is nowhere to put one. Pricing an opportunity would require altering this table, which is a reviewable act rather than a quiet one.';

comment on column sales.upsell_signals.kind is
  'project_completed or scope_added, which are two of the three signals section 2.7 names. The third - a support pattern - is deliberately absent: maintenance has no model yet (G-034), so there is no pattern to observe, and an invented proxy would be a made-up signal wearing section 2.7 clothes.';

comment on column sales.upsell_signals.evidence is
  'What was seen, in ids and counts rather than prose. A reader should be able to check the claim rather than take it.';

create index if not exists upsell_signals_open_idx
  on sales.upsell_signals (organization_id, detected_at desc)
  where status = 'open';

-- ── internal only, and that is the whole point ───────────────────────────
--
-- No client policy exists here at all. A client reading "we think they need
-- more work" is exactly what §2.7's boundary is protecting against, and the
-- absence of a policy is a stronger guarantee than a policy that excludes
-- them: there is nothing to get wrong.

alter table sales.upsell_signals enable row level security;

drop policy if exists upsell_signals_select on sales.upsell_signals;
create policy upsell_signals_select on sales.upsell_signals
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists upsell_signals_write on sales.upsell_signals;
create policy upsell_signals_write on sales.upsell_signals
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists set_updated_at on sales.upsell_signals;
create trigger set_updated_at
  before update on sales.upsell_signals
  for each row execute function core.set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- The detector
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Shaped like the other sweeps the tick already runs — `expire_overdue` and
-- `lapse_overdue_proposals` — because it is the same kind of job and a third
-- shape would be a third thing to reason about.
--
-- `on conflict do nothing` rather than a "have I seen this" query: the
-- constraint is the authority, and asking first would leave a race between the
-- asking and the writing.

create or replace function sales.detect_upsell_signals(p_limit int default 50)
-- The OUT names are prefixed because `project_id` and `kind` would otherwise
-- be ambiguous inside `on conflict (...)`, which reads them as PL/pgSQL
-- variables rather than columns. Postgres says so plainly; it is only a trap
-- because the function still creates cleanly and fails at call time.
returns table (signal_id uuid, signal_project_id uuid, signal_kind text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- ── a completed project ────────────────────────────────────────────────
  --
  -- §2.7's first signal, and the least ambiguous: the work is done, the
  -- relationship is live, and somebody should think about what comes next.
  return query
  insert into sales.upsell_signals (
    organization_id, client_account_id, project_id, kind, evidence
  )
  select p.organization_id, p.client_account_id, p.id, 'project_completed',
         jsonb_build_object(
           'projectName', p.name,
           'completedAt', p.completed_at,
           'signal', 'the project reached completed'
         )
    from projects.projects p
   where p.status = 'completed'
     and p.deleted_at is null
     and p.client_account_id is not null
   order by p.completed_at desc nulls last
   limit p_limit
  on conflict (organization_id, project_id, kind) do nothing
  returning sales.upsell_signals.id, sales.upsell_signals.project_id, sales.upsell_signals.kind;

  -- ── scope arriving after the quotation ─────────────────────────────────
  --
  -- §2.7's "feature request", in the terms this system records. A module
  -- created after the project started is work that was not in the shape the
  -- quotation was built against.
  --
  -- `started_at` rather than `created_at`: a project is planned before it
  -- starts, and modules added during planning are the original scope.
  -- Projects that never started are excluded rather than guessed at.
  return query
  insert into sales.upsell_signals (
    organization_id, client_account_id, project_id, kind, evidence
  )
  select p.organization_id, p.client_account_id, p.id, 'scope_added',
         jsonb_build_object(
           'projectName', p.name,
           'startedAt', p.started_at,
           'modulesAddedAfterStart', count(m.id),
           'signal', 'modules were added after the project started'
         )
    from projects.projects p
    join projects.modules m
      on m.project_id = p.id
     and m.created_at > p.started_at
   where p.started_at is not null
     and p.deleted_at is null
     and p.client_account_id is not null
     and p.status not in ('cancelled', 'completed')
   group by p.id, p.organization_id, p.client_account_id, p.name, p.started_at
   limit p_limit
  on conflict (organization_id, project_id, kind) do nothing
  returning sales.upsell_signals.id, sales.upsell_signals.project_id, sales.upsell_signals.kind;
end;
$$;

comment on function sales.detect_upsell_signals(int) is
  'Notices the opportunities section 2.7 names and files them for the team (G-036). It states no price, contacts nobody, and writes only to sales.upsell_signals. Idempotent through the unique constraint rather than a lookup, because the constraint is the authority and asking first leaves a race. The support-pattern signal is absent until maintenance has a model (G-034).';

revoke all on function sales.detect_upsell_signals(int) from public;
grant execute on function sales.detect_upsell_signals(int) to service_role;
