-- ═══════════════════════════════════════════════════════════════════════════
-- What the project was, once it is over.
--
-- Phase 12, gap G-033, directive §23: project value, payments, outstanding
-- balance, duration, revisions, bugs, final version, completion date, handover
-- status. Every one of those facts was already in the database and no query
-- assembled them, so the answer to "how did that project actually go" was a
-- person opening five screens and adding up.
--
-- ── it computes, and decides nothing ──────────────────────────────────────
--
-- Deliberately a read. It does not mark a project complete, does not gate on
-- the outstanding balance, and does not judge whether the revision count was
-- reasonable. Directive §23 asks for a summary; what a summary implies about
-- whether the project *should* be closed is ADM-13/ADM-14 and ADM-19, still
-- unanswered, and a function that quietly enforced one of them would be the
-- invented gate this repository has refused three times now.
--
-- ── what "revisions" means, stated rather than assumed ────────────────────
--
-- The count is versions beyond the first, per kind. Design v1, v2, v3 and
-- prototype v1 is two revisions, not four and not one — the client asked for
-- changes twice. Directive §23 says "revisions" and means the going-round
-- again, which is the number an agency argues about at the end of a project.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.completion_summary(p_project_id uuid)
returns table (
  project_id        uuid,
  name              text,
  status            text,

  -- Money, all in minor units, all four separately: the budget somebody
  -- agreed, what was actually billed, what arrived, and what did not. They
  -- differ often enough that collapsing any two would hide the interesting
  -- case.
  budget_minor      bigint,
  invoiced_minor    bigint,
  paid_minor        bigint,
  outstanding_minor bigint,

  started_at        timestamptz,
  completed_at      timestamptz,
  duration_days     int,

  milestones_total  bigint,
  milestones_met    bigint,

  deliverables      bigint,
  revisions         bigint,
  final_version     text,

  defects_total     bigint,
  defects_open      bigint,

  handover_status   text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with money as (
    select
      coalesce(sum(i.total_minor), 0) as invoiced,
      coalesce(sum(i.paid_minor), 0)  as paid,
      coalesce(sum(i.total_minor - i.paid_minor) filter (
        where i.status in ('issued', 'partially_paid', 'overdue')), 0) as outstanding
    from finance.invoices i
   where i.project_id = p_project_id
  ),
  handover as (
    select h.status, h.accepted_at
      from projects.handovers h
     where h.project_id = p_project_id
     order by h.created_at desc
     limit 1
  ),
  -- Versions beyond the first, per kind: three designs and one prototype is
  -- two revisions.
  revs as (
    -- Counted in two steps because `sum(count(*))` is a nested aggregate and
    -- Postgres refuses it: per kind first, then added up.
    select coalesce(sum(per_kind.versions - 1), 0) as n
      from (
        select count(*) as versions
          from projects.deliverables d
         where d.project_id = p_project_id
         group by d.kind
      ) per_kind
  ),
  final as (
    select d.kind || ' v' || d.version as label
      from projects.deliverables d
     where d.project_id = p_project_id
       and d.status = 'approved'
     order by d.created_at desc
     limit 1
  )
  select
    p.id, p.name, p.status,
    p.budget_minor,
    (select invoiced from money),
    (select paid from money),
    (select outstanding from money),
    p.created_at,
    (select accepted_at from handover),
    -- Null while it is still running: a duration measured to `now()` reads as
    -- a fact and is a moving number.
    case
      when (select accepted_at from handover) is null then null
      else extract(day from (select accepted_at from handover) - p.created_at)::int
    end,
    (select count(*) from projects.milestones m where m.project_id = p.id),
    (select count(*) from projects.milestones m where m.project_id = p.id and m.status = 'met'),
    (select count(*) from projects.deliverables d where d.project_id = p.id),
    coalesce((select n from revs), 0),
    (select label from final),
    (select count(*) from qa.defects q where q.project_id = p.id),
    (select count(*) from qa.defects q where q.project_id = p.id and q.status = 'open'),
    (select status from handover)
  from projects.projects p
 where p.id = p_project_id;
$$;

comment on function projects.completion_summary(uuid) is
  'Directive §23''s end-of-project summary, assembled from facts that already existed in five different tables. A read: it marks nothing complete, gates on nothing, and judges nothing — what the numbers imply about whether a project should close is ADM-13/ADM-14 and ADM-19, still unanswered.';

revoke all on function projects.completion_summary(uuid) from public;
grant execute on function projects.completion_summary(uuid) to authenticated, service_role;
