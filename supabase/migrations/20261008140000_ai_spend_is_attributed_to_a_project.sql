-- SCR-065 guardrail: "No hidden spend: every AI call should be attributable
-- to project and agent."
--
-- Every run already carries its agent (agent_key, NOT NULL) and, when the work
-- belongs to a project, its project_id (derived by trigger from the subject).
-- Work that belongs to no project (a lead's reply, the search index) has none,
-- and until now nothing added the two kinds up side by side, so spend with no
-- project could not be seen as such.
--
-- This view groups the SETTLED runs by project, KEEPING the line with no
-- project: a report that listed only the projects it can name would understate
-- the total. Read-only, additive, security_invoker, and visible to the same two
-- roles as ai.cost_ledger (owner, ops_admin). Idempotent.

create or replace view ai.spend_by_project
with (security_invoker = on) as
  select r.organization_id,
         r.project_id,
         count(*)                         as runs,
         coalesce(sum(r.input_tokens), 0)  as input_tokens,
         coalesce(sum(r.output_tokens), 0) as output_tokens,
         coalesce(sum(r.cost_minor), 0)    as cost_minor,
         max(r.created_at)                 as last_run_at
    from ai.agent_runs r
   where r.status not in ('queued', 'running', 'awaiting_approval')
     and (select core.current_user_role()) = any (array['owner', 'ops_admin'])
   group by r.organization_id, r.project_id;

comment on view ai.spend_by_project is
  'Settled agent runs summed per project, with the runs that belong to no project kept as their own row (project_id is null) so no spend is hidden (SCR-065). Owner and ops_admin only; read-only.';

revoke all on ai.spend_by_project from public, anon;
grant select on ai.spend_by_project to authenticated, service_role;
