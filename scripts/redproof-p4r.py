#!/usr/bin/env python3
"""Mutate the LIVE definition of one object at a time on the scratch Postgres, require verify-p4r-ui-prototype.sql to go red, restore."""
import subprocess, sys

import os
PSQL = [os.environ.get('P4R_PSQL', 'psql')]  # a wrapper script or 'psql' with PG* env vars pointing at the scratch database
VERIFIER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'verify-p4r-ui-prototype.sql')


def q(sql):
    r = subprocess.run(PSQL + ['-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-c', sql], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('SQL failed: ' + r.stderr[-400:])
    return r.stdout


def run_file(path):
    r = subprocess.run(PSQL + ['-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-f', path], capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr)


def fdef(sig):
    return q(f"select pg_get_functiondef('{sig}'::regprocedure)").rstrip('\n')


def apply_sql(sql):
    open('' + os.environ.get('TMPDIR', '/tmp') + '/p4r_mutation.sql', 'w').write(sql)
    code, out = run_file('' + os.environ.get('TMPDIR', '/tmp') + '/p4r_mutation.sql')
    if code != 0:
        raise SystemExit('apply failed: ' + out[-400:])


results = []


def fn_mutation(name, sig, old, new, expect):
    d = fdef(sig)
    if d.count(old) != 1:
        raise SystemExit(f'{name}: target text found {d.count(old)} times, not once')
    apply_sql(d.replace(old, new) + ';')
    try:
        code, out = run_file(VERIFIER)
    finally:
        apply_sql(d + ';')
    red = code != 0 and expect in out
    results.append((name, red))
    print(('RED   ' if red else 'NOT RED ') + name + ('' if red else '   <<<<<<'), flush=True)
    if not red:
        print(out[-600:])


def sql_mutation(name, mutate, restore, expect):
    apply_sql(mutate)
    try:
        code, out = run_file(VERIFIER)
    finally:
        apply_sql(restore)
    red = code != 0 and expect in out
    results.append((name, red))
    print(('RED   ' if red else 'NOT RED ') + name + ('' if red else '   <<<<<<'), flush=True)
    if not red:
        print(out[-600:])


fn_mutation('plan door leaves the revision build unvalidated (not building)', 'projects.p4r_plan_revision_build(uuid)',
            "update projects.p4ui_prototype_builds set status = 'building' where id = v_new;", '', 'it inherits the plan')
fn_mutation('plan door does not supersede the sent-back build', 'projects.p4r_plan_revision_build(uuid)',
            "update projects.p4ui_prototype_builds set status = 'superseded' where id = v_prev.id;", 'null;', 'history is kept')
fn_mutation('plan door plans a build for a prior build that is not sent back', 'projects.p4r_plan_revision_build(uuid)',
            "if v_prev.status not in ('qa_changes_required', 'changes_requested', 'superseded', 'failed') then", "if false then", 'a replay plans nothing more')
fn_mutation('plan door does not copy test data', 'projects.p4r_plan_revision_build(uuid)',
            "select t.organization_id, t.project_id, v_new, t.name, t.purpose, t.payload, t.edge_case from projects.p4ui_test_data t where t.build_id = v_prev.id;",
            "select t.organization_id, t.project_id, v_new, t.name, t.purpose, t.payload, t.edge_case from projects.p4ui_test_data t where false;", 'the test data came with it')
fn_mutation('plan door ignores that the artifact is already attached', 'projects.p4r_plan_revision_build(uuid)',
            "if v_have is not null then return query select 'already_attached'::text, v_have, null::text; return; end if;", '', 'the artifact a build already holds')
fn_mutation('a no-content revision is accepted again', 'projects.revise_ui_version(uuid,jsonb)',
            "if p_screens = v_latest.screens then", "if false then", 'the Designer returns the same screens')
fn_mutation('design inputs: an agent may record them', 'projects.p4r_record_design_inputs(uuid,jsonb,text[],text[],text)',
            "if v_scope = 'service' then return query select 'person_required'::text, null::uuid, null::text; return; end if;", '', 'an agent does not invent')
fn_mutation('design inputs: a missing asset opens no blocker', 'projects.p4r_record_design_inputs(uuid,jsonb,text[],text[],text)',
            "if not coalesce((v_a.body ->> 'placeholderApproved')::boolean, false)", "if false and not coalesce((v_a.body ->> 'placeholderApproved')::boolean, false)", 'a person records brand assets')
fn_mutation('token check: a raw value is accepted as a token', 'projects.p4r_check_token_consistency(uuid)',
            "if v_norm ~ '^#[0-9a-f]{3,8}$' or v_norm ~ '^-?[0-9.]+(px|rem|em|pt)$' then", "if false then", 'four inconsistent tokens')
fn_mutation('token check: an undefined colour is accepted', 'projects.p4r_check_token_consistency(uuid)',
            "elsif coalesce(v_colors ->> v_key, '') = '' then v_why := 'names a colour the locked direction does not define';", "elsif false then v_why := 'x';", 'four inconsistent tokens')
fn_mutation('state report: missing states are not counted', 'projects.p4r_prototype_state_report(uuid)',
            "v_tstates := v_tstates + cardinality(v_mst);", "v_tstates := v_tstates + 0;", 'DETECTION')
fn_mutation('sync reads superseded before a QA send-back', 'projects.p4ui_sync_build_status(uuid)',
            "when v_a.status = 'qa_changes_required' and v_b.status in ('build_ready', 'qa_review') then 'qa_changes_required'", "when false then 'qa_changes_required'", 'a revision of a revision')

sql_mutation('phase_four.state no longer follows the build',
             'drop trigger p4r_prototype_builds_follow_state on projects.p4ui_prototype_builds;',
             'create trigger p4r_prototype_builds_follow_state after update of status on projects.p4ui_prototype_builds for each row execute function projects.p4r_follow_build_state();',
             'prototype_review')
sql_mutation('the approved artifact can be rewritten',
             'drop trigger p4r_prototype_artifact_content_frozen on projects.prototype_artifacts;',
             "create trigger p4r_prototype_artifact_content_frozen before update of screens, ui_version_id, deliverable_id on projects.prototype_artifacts for each row when (old.screens is distinct from new.screens or old.ui_version_id is distinct from new.ui_version_id or old.deliverable_id is distinct from new.deliverable_id) execute function projects.p4r_prototype_artifact_content_frozen();",
             'even the service role')
fn_mutation('the prototype QA-fix limit is not enforced', 'projects.revise_prototype_build(uuid,jsonb)',
            "if v_count >= v_limit then", "if false then", 'at the prototype QA-fix limit')
sql_mutation('a p4r table loses forced RLS (the export-leak sweep notices)',
             'alter table projects.p4r_design_inputs no force row level security;',
             'alter table projects.p4r_design_inputs force row level security;',
             'row level security enabled and forced')

bad = [n for n, r in results if not r]
print(f'\n{len(results) - len(bad)} of {len(results)} mutations red')
if bad:
    print('NOT RED:', bad)
    sys.exit(1)
