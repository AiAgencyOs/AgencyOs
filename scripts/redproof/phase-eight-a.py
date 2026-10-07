#!/usr/bin/env python3
"""
Red-proof harness for scripts/verify-phase-eight-a.sql.

A verifier that has never failed proves nothing. Each case below removes ONE control from the LIVE definition (a function body is fetched with
pg_get_functiondef and mutated; a constraint, index, trigger or policy is dropped) INSIDE the verifier's own transaction, so nothing persists and
nothing needs restoring: the verifier rolls back at its end, and a failing run rolls back at the error.

  KEEP=1 scripts/apply-migrations-locally.sh               # leaves a scratch Postgres running; it prints its socket directory
  PGHOST=<that directory> PGPORT=<port> python3 scripts/redproof/phase-eight-a.py
  python3 scripts/redproof/phase-eight-a.py --list         # counts only; needs no database

A case that stays green is reported GREEN: the verifier cannot see that control (or another layer covers for it) and the case must be fixed.
A mutation whose pattern is not found raises NO-OP and is reported NOOP: a mutation that changes nothing proves nothing.
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / 'scripts' / 'verify-phase-eight-a.sql'

P = 'projects.'
S = 'sales.'

# (name, kind, target, edits)  kind 'sql' -> target is the SQL text; kind 'fn' -> target is the regprocedure, edits is [(find, replace), ...]
CASES = [
    ('coverage CHECK dropped (new scope covered as warranty)', 'sql', 'alter table projects.support_tickets drop constraint support_tickets_coverage_matches_classification;', None),
    ('classify: coverage_mismatch refusal removed', 'fn', P + 'classify_support_ticket(uuid,text,text,text,text,uuid)',
     [("if not coalesce(v_valid, false) then return query select 'coverage_mismatch'::text; return; end if;", '')]),
    ('classify: warranty window check removed', 'fn', P + 'classify_support_ticket(uuid,text,text,text,text,uuid)',
     [("if p_coverage_decision = 'covered_warranty' and not (", "if false and not (")]),
    ('classify: plan status check removed (a paused plan covers)', 'fn', P + 'classify_support_ticket(uuid,text,text,text,text,uuid)',
     [("or v_plan.status not in ('active', 'renewed', 'renewal_approaching')", "")]),
    ('classify: plan end-date check removed (a lapsed plan covers)', 'fn', P + 'classify_support_ticket(uuid,text,text,text,text,uuid)',
     [("or (v_plan.ends_on is not null and v_day > v_plan.ends_on)", "")]),
    ('classify: organization filter removed (cross-tenant classify)', 'fn', P + 'classify_support_ticket(uuid,text,text,text,text,uuid)',
     [("where t.id = p_ticket_id and t.organization_id = v_org for update;", "where t.id = p_ticket_id for update;")]),
    ('classify: SLA response clock hard-coded', 'fn', P + 'classify_support_ticket(uuid,text,text,text,text,uuid)',
     [("response_due_at = v_t.raised_at + make_interval(hours => projects.p8_hours(v_org, 'response', p_priority)),", "response_due_at = v_t.raised_at + interval '99 hours',")]),
    ('advance: QA-verified check removed', 'fn', P + 'advance_support_ticket(uuid,text,text,text,boolean)',
     [("if v_def.status <> 'verified' then return query select 'qa_not_verified'::text; return; end if;", '')]),
    ('advance: client-confirmation check removed (door layer)', 'fn', P + 'advance_support_ticket(uuid,text,text,text,boolean)',
     [("if v_t.client_confirmed_at is null then return query select 'client_confirmation_required'::text; return; end if;", '')]),
    ('closed-technical CHECK dropped (table layer)', 'sql', 'alter table projects.support_tickets drop constraint support_tickets_closed_technical_needs_confirmation;', None),
    ('advance: how-to closes without the knowledge source', 'fn', P + 'advance_support_ticket(uuid,text,text,text,boolean)',
     [("if not exists (select 1 from projects.ticket_knowledge_citations kc where kc.ticket_id = v_t.id and kc.organization_id = v_org) then", 'if false then')]),
    ('advance: out-of-scope work allowed to start', 'fn', P + 'advance_support_ticket(uuid,text,text,text,boolean)',
     [("if v_t.classification in ('change_request', 'new_project') then return query select 'out_of_scope_is_not_maintenance_work'::text; return; end if;", '')]),
    ('record_client_confirmation: evidence requirement removed', 'fn', P + 'record_client_confirmation(uuid,text,boolean)',
     [("if v_ev is null or length(v_ev) < 5 then return query select 'evidence_required'::text; return; end if;", '')]),
    ('link_support_root_cause: project check removed', 'fn', P + 'link_support_root_cause(uuid,uuid,uuid,uuid,uuid)',
     [("if p_defect_id is not null and not exists (select 1 from qa.defects d where d.id = p_defect_id and d.organization_id = v_org and d.project_id = v_t.project_id) then return query select 'wrong_project'::text; return; end if;", '')]),
    ('acknowledge escalation: admin check removed', 'fn', P + 'acknowledge_support_escalation(uuid,text)',
     [("if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;", '')]),
    ('open_support_ticket: duplicate lookup removed (door layer)', 'fn', P + 'open_support_ticket(uuid,uuid,text,text,text,text,timestamptz)',
     [("if v_id is not null then return query select 'duplicate'::text, v_id; return; end if;", '')]),
    ('source-once unique index dropped (table layer)', 'sql', 'drop index projects.support_tickets_source_once;', None),
    ('SLA sweep: stamp-once condition removed', 'fn', P + 'sweep_support_sla(uuid,timestamptz)',
     [("t.first_response_at is null and t.response_breached_at is null and t.response_due_at < v_now", "t.first_response_at is null and t.response_due_at < v_now"),
      ("v_resp_hit := r.first_response_at is null and r.response_breached_at is null and r.response_due_at < v_now;", "v_resp_hit := r.first_response_at is null and r.response_due_at < v_now;")]),
    ('SLA sweep: in-function service-role check removed', 'fn', P + 'sweep_support_sla(uuid,timestamptz)',
     [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0, 0; return; end if;", '')]),
    ('record_support_proposal: agent sets the classification', 'fn', P + 'record_support_proposal(uuid,uuid,text,text,text,text,text)',
     [("update projects.support_tickets set proposed_classification = p_proposed_classification,", "update projects.support_tickets set classification = p_proposed_classification, proposed_classification = p_proposed_classification,")]),
    ('record_support_proposal: price refusal removed (door layer)', 'fn', P + 'record_support_proposal(uuid,uuid,text,text,text,text,text)',
     [("then return query select 'no_price_here'::text; return; end if;", "then null; end if;")]),
    ('reply-draft price CHECK dropped (table layer)', 'sql', 'alter table projects.support_reply_drafts drop constraint support_reply_drafts_agent_names_no_price;', None),
    ('customer_health_status: critical never reported', 'fn', P + 'customer_health_status(uuid,timestamptz)',
     [("when exists (select 1 from h where h.level = 'critical') then 'critical'", "when false then 'critical'")]),
    ('snapshot: unchanged status written again', 'fn', P + 'p8_take_snapshot(uuid,uuid,text,timestamptz,uuid,boolean)',
     [("if v_prev.id is not null and v_prev.status = v_new.status and not p_force then", "if false then")]),
    ('snapshot: recovery plan opened even when one is live', 'fn', P + 'p8_take_snapshot(uuid,uuid,text,timestamptz,uuid,boolean)',
     [("and not exists (select 1 from projects.recovery_plans rp where rp.project_id = p_project_id and rp.status in ('open', 'in_progress')) then", "then")]),
    ('resolve_recovery_plan: health re-evaluation refusal removed', 'fn', P + 'resolve_recovery_plan(uuid,text)',
     [("if v_s.health_status in ('at_risk', 'critical') then return query select 'health_not_recovered'::text, v_s.health_status; return; end if;", '')]),
    ('check-in completion CHECK dropped', 'sql', 'alter table projects.cs_check_ins drop constraint cs_check_ins_complete_is_evidenced;', None),
    ('eligibility: consent withdrawal ignored', 'fn', P + 'check_in_eligibility(uuid,text,timestamptz)',
     [("v_optout := exists (", "v_optout := false and exists (")]),
    ('renewal sweep: silently extends a plan', 'fn', P + 'sweep_maintenance_renewals(uuid,timestamptz)',
     [("update projects.maintenance_plans set status = 'renewal_approaching' where id = r.id;", "update projects.maintenance_plans set status = 'renewal_approaching', ends_on = ends_on + 365 where id = r.id;")]),
    ('renewal sweep: in-function service-role check removed', 'fn', P + 'sweep_maintenance_renewals(uuid,timestamptz)',
     [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0; return; end if;", '')]),
    ('intake: final-payment gate always passes', 'fn', P + 'p8_build_intake(uuid,uuid)',
     [("v_c.id is not null and v_c.verified_minor >= v_c.invoiced_minor and v_unpaid = 0", "true")]),
    ('fill_phase_eight_intake: in-function service-role check removed', 'fn', P + 'fill_phase_eight_intake(uuid,uuid)',
     [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid, null::text; return; end if;", '')]),
    ('waive: owner check removed', 'fn', P + 'waive_phase_eight_gate(uuid,text,text)',
     [("if not coalesce((select core.is_owner()), false) then return query select 'not_authorized'::text; return; end if;", '')]),
    ('start: warranty decision not required', 'fn', P + 'start_phase_eight(uuid,date,date,text,text,text,uuid)',
     [("if not ((p_warranty_starts_on is not null and", "if false and not ((p_warranty_starts_on is not null and")]),
    ('start: intake-not-ready refusal removed', 'fn', P + 'start_phase_eight(uuid,date,date,text,text,text,uuid)',
     [("if v_i.intake_status <> 'ready' then return query select 'intake_not_ready'::text, null::uuid; return; end if;", '')]),
    ('client read: account filter removed', 'fn', P + 'client_support_tickets(uuid)',
     [("and p.client_account_id = (select core.current_client_account_id())) then return;", ") then return;")]),
    ('tickets read policy loses is_internal (a client reads tickets)', 'sql',
     "drop policy support_tickets_read on projects.support_tickets; create policy support_tickets_read on projects.support_tickets for select to authenticated using (organization_id = (select core.current_organization_id()));", None),
    ('opportunity: already-included refusal removed', 'fn', S + 'record_phase_eight_opportunity(uuid,text,text,jsonb,text,text,text,text,text,uuid)',
     [("if v_row.classification not in ('change_request', 'new_project') then return query select 'already_included'::text, null::uuid, null::text; return; end if;", '')]),
    ('opportunity: agent key check removed', 'fn', S + 'record_phase_eight_opportunity(uuid,text,text,jsonb,text,text,text,text,text,uuid)',
     [("if p_agent_key not in ('upsell', 'customer_success') then return query select 'not_an_opportunity_agent'::text, null::uuid, null::text; return; end if;", '')]),
    ('opportunity: price refusal removed (door layer)', 'fn', S + 'record_phase_eight_opportunity(uuid,text,text,jsonb,text,text,text,text,text,uuid)',
     [("then return query select 'no_price_here'::text, null::uuid, null::text; return; end if;", "then null; end if;")]),
    ('opportunity no-price trigger dropped (table layer)', 'sql', 'drop trigger p8_opportunity_no_price on sales.phase_eight_opportunities;', None),
    ('commercial hold never holds (recovery first)', 'fn', S + 'p8_commercial_hold(uuid)',
     [("return v_reasons;", "return '{}'::text[];")]),
    ('handoff: qualified requirement removed', 'fn', S + 'hand_off_phase_eight_opportunity(uuid)',
     [("if v_o.status <> 'qualified' then return query select 'not_qualified'::text, null::uuid; return; end if;", '')]),
    ('close: new project may be the completed project itself', 'fn', S + 'close_phase_eight_opportunity(uuid,text,text,uuid,uuid)',
     [("if p_new_project_id is not null and (", "if false and (")]),
]


def psql_env():
    env = dict(os.environ)
    return env


def psql(path):
    return subprocess.run(['psql', '-U', env_user(), '-d', env_db(), '-v', 'ON_ERROR_STOP=1', '-q', '-f', str(path)], env=psql_env(), capture_output=True, text=True)


def env_user():
    return os.environ.get('PGUSER', 'postgres')


def env_db():
    return os.environ.get('PGDATABASE', 'agencyos_local')


def injection(kind, target, edits):
    if kind == 'sql':
        return target + '\n'
    expr = "d"
    checks = []
    for i, (find, repl) in enumerate(edits):
        f = find.replace("$", "")
        checks.append(f"  if position($f${find}$f$ in d) = 0 then raise exception 'NO-OP MUTATION: pattern {i} not found in {target}'; end if;")
        expr = f"replace({expr}, $f${find}$f$, $r${repl}$r$)"
    return ("do $m$ declare d text; begin\n"
            f"  d := pg_get_functiondef('{target}'::regprocedure);\n" + '\n'.join(checks) + "\n"
            f"  execute {expr};\nend $m$;\n")


def main():
    if '--list' in sys.argv:
        print(f'{len(CASES)} cases')
        return 0
    text = VERIFIER.read_text()
    marker = '\\set ON_ERROR_STOP on\nbegin;\n'
    assert marker in text
    base = psql(VERIFIER)
    base_ok = base.returncode == 0 and 'verified OK' in base.stdout
    print(f'baseline verifier: {"PASS" if base_ok else "FAIL (the harness is meaningless until it passes)"}')
    if not base_ok:
        print((base.stdout + base.stderr)[-600:])
        return 2
    results = []
    for name, kind, target, edits in CASES:
        mutated = text.replace(marker, marker + injection(kind, target, edits), 1)
        f = Path('/tmp') / 'redproof-phase-eight-a.sql'
        f.write_text(mutated)
        r = psql(f)
        out = r.stdout + r.stderr
        if 'NO-OP MUTATION' in out:
            results.append((name, 'NOOP', 'the mutation changed nothing'))
        elif r.returncode != 0:
            line = next((l for l in out.splitlines() if 'FAILED:' in l), None) or next((l for l in out.splitlines() if 'ERROR:' in l), '')
            results.append((name, 'RED', line.split('ERROR:')[-1].strip()[:110]))
        else:
            results.append((name, 'GREEN', 'the verifier did not notice'))
    width = max(len(n) for n, _, _ in results)
    for n, s, d in results:
        print(f'  {s:5} {n:{width}}  {d}')
    bad = [r for r in results if r[1] != 'RED']
    print(f'\n{len(results) - len(bad)}/{len(results)} controls red-proved')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
