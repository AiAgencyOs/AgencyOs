-- ═══════════════════════════════════════════════════════════════════════════
-- A payment plan is replaced whole, or not at all — and never out from under
-- a bill the client has already been sent.
--
-- Two findings, one function.
--
-- The first is the serious one. configurePaymentPlan refused a rewrite only
-- when some milestone was 'met', and nothing in the repository ever writes
-- 'met'. It never looked at finance.invoices at all. Because
-- finance.invoices.milestone_id is `on delete set null`, deleting the old plan
-- silently unhooks every invoice raised against it — issued and paid ones
-- included — and then re-inserts the same milestones as fresh `pending` rows.
--
--     plan is 30 / 30 / 40, the first milestone is invoiced and issued
--     somebody reopens the plan to fix a typo in the third name
--       → the issued invoice keeps its status and loses its milestone
--       → invoices_milestone_live_key now guards nothing for that work
--       → the new pending milestone is billable again, for money the client
--         has already been asked for
--
-- projects.tasks.milestone_id is `on delete set null` too, so every task
-- assignment on the plan goes in the same statement.
--
-- The rule is not new. 20260809120002 says there is at most one non-void
-- invoice per milestone and that it is "enforced where concurrency cannot
-- dodge it"; the point of that index is defeated if the milestone it keys on
-- can be deleted and recreated underneath it.
--
-- The second is that the rewrite was two round trips — a committed DELETE,
-- then an INSERT that might fail. The comment in projects/service.ts claimed
-- "all rows land in one transaction", and they did not: a rejected insert (a
-- plan that does not total 100, a constraint, a dropped connection) left the
-- project with no plan at all and no way to tell that it ever had one. Only
-- the *insert* was deferred-trigger atomic; the delete was already gone.
--
-- Both disappear inside one function. It locks the project's milestones,
-- looks for a live invoice through that lock, and does the delete and the
-- insert in the same statement — so the plan is replaced whole or the
-- transaction rolls back and the old one is still there.
--
-- The deferred constraint trigger milestones_payment_plan_total is what makes
-- delete-then-insert legal inside one transaction: the 100% total is checked
-- at COMMIT, when both halves are in, rather than after each row.
--
-- SECURITY INVOKER. milestones_write already admits exactly the roles that
-- hold `milestone.write`, and invoices_select lets them see the bills they
-- are being refused for. Running as definer would re-decide tenancy the
-- policies already answer.
--
-- No schema change: no table, column, index or constraint is added, altered
-- or dropped.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.replace_payment_plan(
  p_project_id uuid,
  p_milestones jsonb
)
returns table (
  -- 'replaced' | 'not_found' | 'billed' | 'met'
  outcome        text,
  -- How many milestones the new plan holds, on the path that replaced it.
  milestone_count int,
  -- The invoice number that refused the rewrite, so the caller can name it.
  blocking_number text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org      uuid;
  v_currency char(3);
  v_blocking text;
  v_met      int;
  v_count    int;
begin
  -- ── 1. the project, and a lock on the plan it owns ───────────────────────
  --
  -- The project row is locked first so two rewrites of the same plan queue
  -- rather than interleave; the milestones are locked because they are what
  -- the decision below is about.
  select p.organization_id, p.currency
    into v_org, v_currency
    from projects.projects p
   where p.id = p_project_id
     and p.deleted_at is null
     for update;

  if not found then
    return query select 'not_found'::text, null::int, null::text;
    return;
  end if;

  perform 1
     from projects.milestones m
    where m.project_id = p_project_id
      for update;

  -- ── 2. work that has been signed off ─────────────────────────────────────
  select count(*)
    into v_met
    from projects.milestones m
   where m.project_id = p_project_id
     and m.payment_percent is not null
     and m.status = 'met';

  if v_met > 0 then
    return query select 'met'::text, null::int, null::text;
    return;
  end if;

  -- ── 3. money that has already been asked for ─────────────────────────────
  --
  -- Read through the lock taken above. A void invoice is not a bill — the
  -- same rule invoices_milestone_live_key encodes — so it does not block a
  -- rewrite, and neither does an invoice on a milestone this plan does not
  -- own.
  select i.number
    into v_blocking
    from finance.invoices i
    join projects.milestones m on m.id = i.milestone_id
   where m.project_id = p_project_id
     and i.status <> 'void'
   order by i.number
   limit 1;

  if v_blocking is not null then
    return query select 'billed'::text, null::int, v_blocking;
    return;
  end if;

  -- ── 4. the replacement, whole ────────────────────────────────────────────
  --
  -- Same statement, same transaction. A rejected insert — a plan that does
  -- not total 100, most likely — rolls the delete back with it, so a refused
  -- rewrite leaves the plan that was already there rather than nothing at
  -- all. milestones_payment_plan_total is DEFERRABLE INITIALLY DEFERRED,
  -- which is what makes the intermediate state legal.
  delete from projects.milestones m
   where m.project_id = p_project_id
     and m.payment_percent is not null;

  insert into projects.milestones (
    organization_id, project_id, name, position,
    payment_percent, amount_minor, currency, due_on
  )
  select v_org,
         p_project_id,
         item.value ->> 'name',
         (item.ordinality - 1)::int,
         (item.value ->> 'percent')::numeric,
         (item.value ->> 'amountMinor')::bigint,
         v_currency,
         nullif(item.value ->> 'dueOn', '')::date
    from jsonb_array_elements(p_milestones) with ordinality as item(value, ordinality);

  get diagnostics v_count = row_count;

  return query select 'replaced'::text, v_count, null::text;
end;
$$;

comment on function projects.replace_payment_plan(uuid, jsonb) is
  'Replaces a project payment plan in one statement, serialised on the project. Refuses when any milestone already carries a non-void invoice, so a bill the client has been sent cannot be unhooked and its milestone billed again. Delete and insert share a transaction, so a rejected plan leaves the previous one intact.';

revoke all on function projects.replace_payment_plan(uuid, jsonb)
  from public, anon;
grant execute on function projects.replace_payment_plan(uuid, jsonb)
  to authenticated, service_role;
