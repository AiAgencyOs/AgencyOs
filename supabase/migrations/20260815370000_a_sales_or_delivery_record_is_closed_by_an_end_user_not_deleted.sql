-- ═══════════════════════════════════════════════════════════════════════════
-- A sales or delivery record is closed by an end-user through its terminal
-- state — never deleted. The completion of the invoices fix (20260815360000).
--
-- The sanctioned guards freeze these records' state on INSERT/UPDATE, but each
-- carries the ALL write policy (owner/ops_admin, or can_manage_delivery for the
-- delivery ones) with DELETE granted to authenticated, so DELETE was left open —
-- an end-user could erase the record and its audit rather than closing it. Every
-- one of these already has a sanctioned removal-terminal state, so deleting is
-- never the right verb for a person:
--   sales.opportunities   → `lost`        (a dead deal is lost, not deleted)
--   projects.projects      → `cancelled`   (05-project-lifecycle)
--   sales.proposals        → `superseded`/`rejected`/`lapsed`
--   projects.deliverables  → `superseded`
--   projects.handovers     → `cancelled`
-- The application never deletes any of them, and their audit trail (§16 history,
-- audit.audit_log) is meant to survive a closed record. Blocking the parents
-- (opportunities/projects) also closes the only end-user path that reaches the
-- children by CASCADE, so a childless record cannot be erased either.
--
-- A shared BEFORE DELETE guard refuses the delete for any caller with an end-user
-- identity, exactly like finance.invoices_reject_end_user_delete: an authenticated
-- end-user is refused, while an identity-less server-side caller (the service
-- role's fixture cleanup, and the ON DELETE CASCADE from a deleted organization)
-- is unaffected. Only core.organizations cascades into these as a parent with no
-- end-user DELETE policy, so no legitimate cascade reaches this as an end-user.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.reject_end_user_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    raise exception '%.% is closed through its terminal state, not deleted', tg_table_schema, tg_table_name
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

comment on function core.reject_end_user_delete() is
  'Refuses a DELETE by any authenticated end-user: the record is closed through its own terminal state (lost/cancelled/superseded/…), never erased, so its history and audit survive. Identity-less server-side callers — the service role and the ON DELETE CASCADE from a deleted organization — are unaffected. Attached to sales.opportunities, projects.projects, sales.proposals, projects.deliverables and projects.handovers; finance.invoices has its own message-specific twin.';

drop trigger if exists opportunities_reject_end_user_delete on sales.opportunities;
create trigger opportunities_reject_end_user_delete
  before delete on sales.opportunities
  for each row execute function core.reject_end_user_delete();

drop trigger if exists projects_reject_end_user_delete on projects.projects;
create trigger projects_reject_end_user_delete
  before delete on projects.projects
  for each row execute function core.reject_end_user_delete();

drop trigger if exists proposals_reject_end_user_delete on sales.proposals;
create trigger proposals_reject_end_user_delete
  before delete on sales.proposals
  for each row execute function core.reject_end_user_delete();

drop trigger if exists deliverables_reject_end_user_delete on projects.deliverables;
create trigger deliverables_reject_end_user_delete
  before delete on projects.deliverables
  for each row execute function core.reject_end_user_delete();

drop trigger if exists handovers_reject_end_user_delete on projects.handovers;
create trigger handovers_reject_end_user_delete
  before delete on projects.handovers
  for each row execute function core.reject_end_user_delete();
