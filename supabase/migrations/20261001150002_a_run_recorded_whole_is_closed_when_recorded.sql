-- A run recorded whole is closed the moment it is recorded.
--
-- 20261001140000 gave qa.test_runs a life (status open|closed, started_at,
-- ended_at) and the rule `test_runs_closed_has_end`. It backfilled the
-- rows that existed, but every row recorded WHOLE since then — through
-- qa.record_test_run, the door the QA tab and the live verifiers use — is
-- inserted with the default status 'closed' and no ended_at, and the rule
-- refuses it. The migration proved this: `db:verify:gates` went red on the
-- first insert.
--
-- The fix is where the fact lives: a run inserted closed ended when it was
-- recorded (executed_at), exactly as the backfill said of the older rows.
-- The trigger fills the two timestamps only when they are missing and
-- only on a closed row; an open run (open_test_run, a fired suite
-- schedule) still has no end until close_test_run gives it one. Nothing
-- is rewritten afterwards — refuse_test_run_rewrite stands.

create or replace function qa.close_run_recorded_whole()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'closed' then
    new.ended_at   := coalesce(new.ended_at, new.executed_at, now());
    new.started_at := coalesce(new.started_at, new.ended_at);
  end if;
  return new;
end;
$$;

comment on function qa.close_run_recorded_whole() is
  'BEFORE INSERT on qa.test_runs: a row inserted closed (the whole-run path, qa.record_test_run) ended when it was recorded, so ended_at/started_at default to executed_at and test_runs_closed_has_end holds. Open runs are untouched.';

drop trigger if exists close_run_recorded_whole on qa.test_runs;
create trigger close_run_recorded_whole
  before insert on qa.test_runs
  for each row execute function qa.close_run_recorded_whole();
