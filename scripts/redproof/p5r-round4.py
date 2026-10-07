#!/usr/bin/env python3
"""
Red-proof harness for scripts/verify-p5r-round4.sql (round 4: how-to citation, handoff preferences, finance completion report).

Each case removes ONE control from the LIVE definition (pg_get_functiondef + replace, then execute) INSIDE the verifier's own transaction, so nothing
persists: the verifier rolls back at its end, and a failing run rolls back at the error. A case that stays green is reported GREEN (the verifier cannot
see that control). A mutation whose pattern is not found raises NO-OP MUTATION and is reported NOOP.

  KEEP=1 scripts/apply-migrations-locally.sh
  PGHOST=<socket dir> PGPORT=<port> python3 scripts/redproof/p5r-round4.py
  python3 scripts/redproof/p5r-round4.py --list
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / 'scripts' / 'verify-p5r-round4.sql'
ADV = 'projects.advance_support_ticket(uuid,text,text,text,boolean)'
FN_REPORT = 'finance.p5r_finance_agent_completion_report(uuid)'

CASES = [
    ('advance: the citation requirement removed', 'fn', ADV,
     [("if not exists (select 1 from projects.ticket_knowledge_citations kc where kc.ticket_id = v_t.id and kc.organization_id = v_org) then", "if false then")]),
    ('advance: the still-approved requirement removed', 'fn', ADV,
     [("and ka.status = 'approved') then", "and true) then")]),
    ('advance: citation scoped to any ticket, not this one', 'fn', ADV,
     [("where kc.ticket_id = v_t.id and kc.organization_id = v_org) then\n        return query select 'approved_knowledge_citation_required'", "where kc.organization_id = v_org) then\n        return query select 'approved_knowledge_citation_required'")]),
    ('advance: free-text evidence accepted in place of the citation', 'fn', ADV,
     [("if not exists (select 1 from projects.ticket_knowledge_citations kc where kc.ticket_id = v_t.id and kc.organization_id = v_org) then", "if v_ev is null and not exists (select 1 from projects.ticket_knowledge_citations kc where kc.ticket_id = v_t.id and kc.organization_id = v_org) then")]),
    ('advance: the recorded answer no longer required', 'fn', ADV,
     [("if v_note is null then return query select 'answer_and_source_required'::text; return; end if;\n      if not exists", "if false then return query select 'answer_and_source_required'::text; return; end if;\n      if not exists")]),
    ('intake: preferences back to the fixed sentence', 'fn', 'projects.p8_build_intake(uuid,uuid)',
     [("'preferences', projects.p5r_intake_preferences(v_project.client_account_id, p_organization_id)", "'preferences', 'none recorded'")]),
    ('preferences reader: not scoped to the client', 'fn', 'projects.p5r_intake_preferences(uuid,uuid)',
     [("where cp.client_account_id = p_client_account_id and", "where")]),
    ('preferences reader: avoided channels dropped', 'fn', 'projects.p5r_intake_preferences(uuid,uuid)',
     [("'avoidChannels', to_jsonb(v_p.avoid_channels), ", "")]),
    ('report: Admin/Finance check removed', 'fn', FN_REPORT,
     [("if v_kind not in ('admin', 'finance') or v_org is null then return null; end if;", "")]),
    ('report: organization scope removed', 'fn', FN_REPORT,
     [("where r.id = p_request_id and r.organization_id = v_org;", "where r.id = p_request_id;")]),
    ('report: undecided proposals not a blocker', 'fn', FN_REPORT,
     [("if v_undecided > 0 then v_blockers", "if false then v_blockers")]),
    ('report: a run with no output not a blocker', 'fn', FN_REPORT,
     [("if v_n = 0 then v_blockers", "if false then v_blockers")]),
    ('report: decision hidden', 'fn', FN_REPORT,
     [("'decision', coalesce(d.decision, 'awaiting')", "'decision', 'awaiting'")]),
]


def env_user():
    return os.environ.get('PGUSER', 'postgres')


def env_db():
    return os.environ.get('PGDATABASE', 'agencyos_local')


def psql(path):
    return subprocess.run(['psql', '-U', env_user(), '-d', env_db(), '-v', 'ON_ERROR_STOP=1', '-q', '-f', str(path)], env=dict(os.environ), capture_output=True, text=True)


def injection(target, edits):
    expr = 'd'
    checks = []
    for i, (find, repl) in enumerate(edits):
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
    for name, _kind, target, edits in CASES:
        mutated = text.replace(marker, marker + injection(target, edits), 1)
        f = Path(os.environ.get('TMPDIR', '/tmp')) / 'redproof-p5r-round4.sql'
        f.write_text(mutated)
        r = psql(f)
        out = r.stdout + r.stderr
        if 'NO-OP MUTATION' in out:
            results.append((name, 'NOOP', 'the mutation changed nothing'))
        elif r.returncode != 0:
            line = next((ln for ln in out.splitlines() if 'FAILED:' in ln), None) or next((ln for ln in out.splitlines() if 'ERROR:' in ln), '')
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
