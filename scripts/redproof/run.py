#!/usr/bin/env python3
"""
Red-proof harness for the lead-generation verifiers (slices 8 onward).

A verifier that has never failed proves nothing. For each case in cases.json this removes ONE control from a migration (a string
replacement), re-applies the migrations that come after it (so a function a later migration redefines is judged by its LIVE
definition, not the one that was shadowed), runs the verifier, and expects it to FAIL. A case that stays green is reported as
"!!GREEN": either the verifier cannot see that control, or another layer is covering for it, or the mangle hit a definition a
later migration replaced - the case must be fixed or re-pointed, never counted.

  KEEP=1 scripts/apply-migrations-locally.sh          # leaves a scratch Postgres running; it prints its socket directory
  PGHOST=<that directory> PGPORT=55432 python3 scripts/redproof/run.py            # every slice
  PGHOST=... PGPORT=55432 python3 scripts/redproof/run.py --slice hardening       # one slice
  python3 scripts/redproof/run.py --list                                          # counts only; needs no database

Cases marked "ddl" change an object that `create ... if not exists` cannot change on a re-apply: they are listed and counted but are
proved by hand (drop the object, run the verifier, restore) - the harness says so rather than reporting a false green.
"""
import json, os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((Path(__file__).parent / 'cases.json').read_text())
MIGRATIONS = sorted((ROOT / 'supabase' / 'migrations').glob('*.sql'))


def psql(args):
    env = dict(os.environ)
    return subprocess.run(['psql', '-U', 'postgres', '-d', 'agencyos_local', '-v', 'ON_ERROR_STOP=1', *args], env=env, capture_output=True, text=True)


def apply_text(text, tag):
    f = Path('/tmp') / f'redproof-{tag}.sql'
    f.write_text(text)
    r = psql(['-q', '-f', str(f)])
    return [l for l in r.stderr.splitlines() if 'ERROR' in l]


def reapply_after(migration_path):
    later = [m for m in MIGRATIONS if m.name > Path(migration_path).name and m.name >= '20261015']
    for m in later:
        errs = apply_text(m.read_text(), 'later')
        if errs:
            return errs
    return []


def run_ts(name, spec):
    results = []
    cmd = ['node', '--conditions=react-server', '--import', './tests/_alias.mjs', '--experimental-test-module-mocks', '--disable-warning=ExperimentalWarning', '--test', spec['test']]
    for c in spec['cases']:
        f = ROOT / c['file']
        orig = f.read_text()
        if orig.count(c['find']) < 1:
            results.append((c['name'], 'NOMATCH', c['find'][:60]))
            continue
        f.write_text(orig.replace(c['find'], c['replace'], 1))
        try:
            r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        finally:
            f.write_text(orig)
        results.append((c['name'], 'RED' if r.returncode != 0 else 'GREEN', 'the test failed' if r.returncode != 0 else 'no failure'))
    baseline = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    return results, baseline.returncode == 0


def run_slice(name, spec):
    if spec.get('kind') == 'ts':
        return run_ts(name, spec)
    results = []
    for c in spec['cases']:
        # A case may point at the migration that holds the LIVE definition of what it removes (a later migration redefined it).
        migration = c.get('migration', spec['migration'])
        mig = ROOT / migration
        orig = mig.read_text()
        if c.get('ddl'):
            results.append((c['name'], 'DDL', 'proved by hand (see the note in the case)'))
            continue
        edits = c.get('edits') or [{'find': c['find'], 'replace': c['replace'], 'nth': c.get('nth', 1)}]
        mangled, missing = orig, None
        for e in edits:
            a, b, nth = e['find'], e['replace'], e.get('nth', 1)
            if mangled.count(a) < nth:
                missing = f'{mangled.count(a)} occurrence(s) of {a[:50]!r}'
                break
            idx = -1
            for _ in range(nth):
                idx = mangled.index(a, idx + 1)
            mangled = mangled[:idx] + b + mangled[idx + len(a):]
        if missing:
            results.append((c['name'], 'NOMATCH', missing))
            continue
        errs = apply_text(mangled, 'mangled')
        if errs:
            results.append((c['name'], 'APPLYFAIL', errs[0][:100]))
            apply_text(orig, 'orig')
            continue
        errs = reapply_after(migration)
        out = psql(['-f', str(ROOT / spec['verifier'])])
        text = out.stdout + out.stderr
        failed = [l.strip() for l in text.splitlines() if 'ERROR:' in l]
        results.append((c['name'], 'RED' if failed and 'ALL CHECKS PASSED' not in text else 'GREEN', (failed[0][:120] if failed else 'no error')))
        apply_text(orig, 'orig')
        reapply_after(migration)
    baseline = psql(['-f', str(ROOT / spec['verifier'])])
    return results, 'ALL CHECKS PASSED' in baseline.stdout


def main():
    only = sys.argv[sys.argv.index('--slice') + 1] if '--slice' in sys.argv else None
    if '--list' in sys.argv:
        total = 0
        for name, spec in CASES.items():
            n = len(spec['cases']); total += n
            print(f'{name:12} {n:3} cases  ({sum(1 for c in spec["cases"] if c.get("ddl"))} proved by hand)')
        print(f'{"total":12} {total:3}')
        return 0
    bad = 0
    for name, spec in CASES.items():
        if only and name != only:
            continue
        results, restored = run_slice(name, spec)
        print(f'== {name}: {len(results)} cases')
        for case, status, detail in results:
            print(f'  {status:9} {case}  -> {detail}')
            bad += status in ('GREEN', 'NOMATCH', 'APPLYFAIL')
        print(f'  baseline restored and passing: {restored}')
        bad += not restored
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
