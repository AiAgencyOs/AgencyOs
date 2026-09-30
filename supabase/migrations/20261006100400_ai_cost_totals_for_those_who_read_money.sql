-- AI cost totals for the roles that read money (PDF gap W1; SCR-055 "AI/tooling
-- costs", and finance-role parity).
--
-- A project's margin is verified revenue less expenses, AI cost and time cost.
-- Expenses and time cost are readable by the finance role
-- (finance.expenses_select, projects.time_log_costs — G-314, 20260921150000);
-- the AI cost lives on ai.agent_runs, whose SELECT policy is core.is_internal(),
-- a predicate that deliberately excludes `finance`. So the same project showed a
-- different margin to the owner and to finance — the AI term was silently zero
-- for one of them. Widening that policy would hand the role every run's prompt
-- and output (the `input` / `output` JSON), which is exactly what it must not
-- read. This function hands over only what a margin needs: per project, per
-- agent and per UTC month, the run count, tokens and recorded cost.
--
-- SECURITY DEFINER but scoped: the caller's own organization, and only for the
-- roles that already read this data (the five internal roles) or the finance
-- role. Anyone else gets no rows. It names no model, no prompt, no output.
-- Idempotent.

create or replace function finance.ai_cost_buckets()
returns table (
  project_id uuid,
  agent_key text,
  month text,
  runs bigint,
  input_tokens bigint,
  output_tokens bigint,
  cost_minor bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.project_id,
         r.agent_key,
         to_char(r.created_at at time zone 'UTC', 'YYYY-MM') as month,
         count(*)::bigint,
         coalesce(sum(r.input_tokens), 0)::bigint,
         coalesce(sum(r.output_tokens), 0)::bigint,
         coalesce(sum(r.cost_minor), 0)::bigint
    from ai.agent_runs r
   where r.organization_id = (select core.current_organization_id())
     and ((select core.is_internal()) or (select core.is_finance()))
   group by 1, 2, 3;
$$;

revoke all on function finance.ai_cost_buckets() from public, anon;
grant execute on function finance.ai_cost_buckets() to authenticated, service_role;

comment on function finance.ai_cost_buckets() is
  'Recorded AI cost per project, agent and UTC month for the caller''s organization: runs, tokens, cost_minor. For the internal roles and the finance role only; names no model and exposes no prompt or output. The margin''s AI term, readable by the role that reads the rest of it.';

notify pgrst, 'reload schema';
