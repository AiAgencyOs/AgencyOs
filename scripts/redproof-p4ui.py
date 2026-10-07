#!/usr/bin/env python3
"""Red-proof for the p4ui controls: mutate the LIVE definition of one function (or drop one constraint), run the verifier, and require it to go red on the
expected check; then restore the original definition. A mutation whose target text is not found exactly once RAISES (a no-op mutation proves nothing).

    PSQL="psql -h <dir> -p <port> -U postgres -d agencyos_local -X" python3 scripts/redproof-p4ui.py

Needs a scratch Postgres with every migration applied (see scripts/apply-migrations-locally.sh, KEEP=1). Never run against a shared database.
"""
import os, shlex, subprocess, sys, tempfile

PSQL = shlex.split(os.environ.get("PSQL", "psql"))
UI = "scripts/verify-p4ui-ui-designer.sql"
PR = "scripts/verify-p4ui-prototype.sql"


def run(args, input_text=None):
    return subprocess.run(PSQL + args, input=input_text, capture_output=True, text=True)


def fn_def(name):
    r = run(["-At", "-c", f"select pg_get_functiondef('projects.{name}'::regproc)"])
    if r.returncode != 0 or not r.stdout.strip():
        raise SystemExit(f"cannot read {name}: {r.stderr}")
    return r.stdout.strip() + ";\n"


def apply(sql):
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
        f.write(sql)
    r = run(["-v", "ON_ERROR_STOP=1", "-q", "-f", f.name])
    os.unlink(f.name)
    if r.returncode != 0:
        raise SystemExit(f"apply failed: {r.stderr}")


def verifier(path):
    r = run(["-v", "ON_ERROR_STOP=1", "-q", "-f", path])
    return r.returncode, r.stderr


# (function, old text, new text, verifier, text the failing check must contain)
FN = [
    ("p4ui_request_design_job", "if v_latest.id is not null and v_latest.status = 'locked' and p_trigger not in", "if false and v_latest.id is not null and v_latest.status = 'locked' and p_trigger not in", UI, "post-lock colour change"),
    ("p4ui_request_design_job", "if v_p4.state in ('scope_escalation', 'blocked_requirement') and p_trigger <> 'approved_scope_change' then", "if false and v_p4.state in ('scope_escalation', 'blocked_requirement') and p_trigger <> 'approved_scope_change' then", UI, "no design job while the workspace is blocked"),
    ("p4ui_request_design_job", "    if not exists (select 1 from projects.p4ui_feedback_routes r where r.ui_version_id = v_src.id) then", "    if false then", UI, "before the PM has classified"),
    ("p4ui_request_design_job", "if not (p_trigger = any (v_reasons)) then", "if false then", UI, "FAILED"),
    ("p4ui_request_design_job", "    if not exists (select 1 from projects.p4ui_prototype_design_issues i", "    if false and not exists (select 1 from projects.p4ui_prototype_design_issues i", UI, "dismissed code bug cannot re-activate"),
    ("p4ui_resolve_design_blocker", "if v_scope not in ('person', 'admin') then return query select case when v_scope = 'service' then 'person_required' else v_scope end, null::uuid; return; end if;", "if false then return query select 'x'::text, null::uuid; return; end if;", UI, "cannot clear its own blocker"),
    ("p4ui_decide_post_lock_revision", "if v_scope <> 'admin' then", "if false then", UI, "p4ui_decide_post_lock_revision"),
    ("p4ui_record_defect_retest", "v_fix.produced_by is not distinct from (select auth.uid())", "false", UI, "produced the fix cannot verify"),
    ("p4ui_record_defect_retest", "if v_fix.status in ('draft', 'qa_review') then", "if false then", UI, "fix is not verified until QA"),
    ("p4ui_confirm_prototype_design_issue", "  if v_scope not in ('person', 'admin') then return query select case when v_scope = 'service' then 'person_required' else v_scope end, null::uuid; return; end if;\n  if v_i.status", "  if false then return query select 'x'::text, null::uuid; return; end if;\n  if v_i.status", UI, "cannot classify the issue"),
    ("p4ui_record_figma_refs", "  if v_scope not in ('person', 'admin') then return query select case when v_scope = 'service' then 'person_required' else v_scope end, null::uuid; return; end if;\n  select m.*", "  if false then return query select 'x'::text, null::uuid; return; end if;\n  select m.*", UI, "cannot assert a Figma link"),
    ("p4ui_record_figma_refs", "and coalesce(length(btrim(p_replace_reason)), 0) = 0 then", "and false then", UI, "not silently swapped"),
    ("p4ui_derive_version_meta", "where ui_version_id = v_parent.id and status in ('open', 'reopened');", "where false;", UI, "fix_ready against v2"),
    ("p4ui_complete_design_job", "if v_v.version <= v_src.version then", "if false then", UI, "not delivered by the version it started from"),
    ("p4ui_route_ui_feedback", "  elsif v_route in ('change_request', 'escalation') then", "  elsif false then", UI, "stops at scope_escalation"),
    ("p4ui_start_governed_revision", "if v_src.status <> 'locked' or v_latest.id <> v_src.id then", "if false then", UI, "p4ui_start_governed_revision"),
    ("p4ui_record_screen_spec", "if not exists (select 1 from jsonb_array_elements(v_v.screens) e(value) where e.value ->> 'screenKey' = p_screen_key) then", "if false then", UI, "invented"),
    ("p4ui_plan_prototype_build", "if v_v.status <> 'locked' then return query select 'ui_not_locked'", "if false then return query select 'ui_not_locked'", PR, "draft UI is refused"),
    ("p4ui_enforce_build_transition", "if new.status = 'qa_pass' and v_art.status is distinct from 'qa_pass' then", "if false then", PR, "cannot be moved to qa_pass"),
    ("p4ui_enforce_build_transition", "elsif new.status = 'locked' and v_del.status is distinct from 'approved' then", "elsif false then", PR, "cannot be locked until the client"),
    ("p4ui_enforce_build_transition", "elsif new.status = 'admin_approved' and v_admin is distinct from 'approved' then", "elsif false then", PR, "admin_approved before an Admin"),
    ("p4ui_record_build_artifact", "(v_scope = 'service' or (v_status = 'uploaded'", "(false or (v_status = 'uploaded'", PR, "claiming an APK is uploaded"),
    ("p4ui_attach_build_artifact", "  if v_gaps > 0 then", "  if false then", PR, "fails its OWN coverage self-check"),
    ("p4ui_resolve_prototype_blocker", "if v_k.external and v_scope <> 'admin' then", "if false then", PR, "member cannot clear an external"),
    ("p4ui_assemble_qa_handoff", "if exists (select 1 from projects.p4ui_artifact_records a where a.build_id = v_b.id and a.upload_status = 'failed'", "if false and exists (select 1 from projects.p4ui_artifact_records a where a.build_id = v_b.id and a.upload_status = 'failed'", PR, "failed artifact upload blocks the handoff"),
    ("p4ui_route_prototype_feedback", "if v_route in ('change_request', 'escalation') and v_p4.id is not null", "if false and v_route in ('change_request', 'escalation') and v_p4.id is not null", PR, "stops at scope_escalation"),
    ("p4ui_record_build_revision", "if v_route.route <> 'prototype_revision' then", "if false then", PR, "new feature is not built"),
    ("p4ui_resolve_prototype_blocker", "if v_scope not in ('person', 'admin') then return query select case when v_scope = 'service' then 'person_required' else v_scope end, null::uuid; return; end if;\n  -- a credential", "if false then return query select 'x'::text, null::uuid; return; end if;\n  -- a credential", PR, "cannot clear a prototype blocker"),
]

failures = []
for name, old, new, ver, expect in FN:
    original = fn_def(name)
    if original.count(old) != 1:
        raise SystemExit(f"NO-OP MUTATION on {name}: target text found {original.count(old)} times: {old[:70]!r}")
    apply(original.replace(old, new))
    try:
        code, err = verifier(ver)
    finally:
        apply(original)
    ok = code != 0 and expect in err
    print(("RED  " if ok else "GREEN") + f"  {name}: {old[:60]!r} -> {expect!r}" + ("" if ok else f"\n      exit={code} stderr tail: {err[-300:]}"))
    if not ok:
        failures.append(name)

# constraint mutation: the secret-shaped test-data check
r = run(["-At", "-c", "select pg_get_constraintdef(oid) from pg_constraint where conname = 'p4ui_test_data_no_secret'"])
cdef = r.stdout.strip()
if not cdef:
    raise SystemExit("constraint p4ui_test_data_no_secret not found")
apply("alter table projects.p4ui_test_data drop constraint p4ui_test_data_no_secret;")
try:
    code, err = verifier(PR)
finally:
    apply(f"alter table projects.p4ui_test_data add constraint p4ui_test_data_no_secret {cdef};")
ok = code != 0 and "secret-shaped value is refused" in err
print(("RED  " if ok else "GREEN") + "  constraint p4ui_test_data_no_secret dropped")
if not ok:
    failures.append("p4ui_test_data_no_secret")

# the clean run, after restoring everything
for ver in (UI, PR):
    code, err = verifier(ver)
    print(("PASS " if code == 0 else "FAIL ") + f"  restored: {ver}")
    if code != 0:
        failures.append("restore " + ver)

print(f"{len(FN) + 1} mutations, {len(failures)} not red")
sys.exit(1 if failures else 0)
