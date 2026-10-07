#!/usr/bin/env python3
"""
Red-proof harness for scripts/verify-phase-seven-c.sql.

A verifier that has never failed proves nothing. Each case below removes ONE control from the LIVE definition (a function body is fetched with
pg_get_functiondef and mutated; a constraint, trigger, policy or grant is dropped) INSIDE the verifier's own transaction, so nothing persists and nothing
needs restoring: the verifier rolls back at its end, and a failing run rolls back at the error.

  KEEP=1 scripts/apply-migrations-locally.sh               # leaves a scratch Postgres running; it prints its socket directory
  PGHOST=<that directory> PGPORT=<port> python3 scripts/redproof/phase-seven-c.py
  python3 scripts/redproof/phase-seven-c.py --list         # counts only; needs no database

A case that stays green is reported GREEN: the verifier cannot see that control (or another layer covers for it) and the case must be fixed.
A mutation whose pattern is not found raises NO-OP and is reported NOOP: a mutation that changes nothing proves nothing.
Where one rule is held by two layers (a door check and a table CHECK, or a role check and a row filter) the cases remove the layers together, or each one
that the verifier can reach separately, and say so in the name.
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / 'scripts' / 'verify-phase-seven-c.sql'

T = 'timestamp with time zone'
HEALTH = 'projects.sweep_phase_eight_health(uuid,' + T + ',integer)'
CHECKINS = 'projects.sweep_checkins_due(uuid,' + T + ',integer)'
MSGDOOR = 'projects.open_support_ticket_from_message(uuid,uuid)'
MSGSWEEP = 'projects.sweep_message_support_tickets(uuid,integer)'
CREATE = 'projects.create_client_action_request(uuid,text,text,text,' + T + ')'
RESOLVE = 'projects.resolve_client_action_request(uuid,text,text)'
SETTLE = 'projects.settle_client_action_request(uuid,text,text)'
CLIENTREAD = 'projects.client_action_requests_for_client(uuid)'
QUEUE = 'projects.p7_failure_queue(uuid,integer,' + T + ')'
DRAFT = 'projects.create_draft_handover_package_for_validated(uuid,uuid)'
DRAFTSWEEP = 'projects.sweep_draft_handover_packages(uuid,integer)'
ACCT = 'projects.p7c_statement_account()'
STMT = 'projects.client_financial_statement(uuid)'
STMTPAY = 'projects.client_financial_statement_payments(uuid)'
STMTTOT = 'projects.client_financial_statement_totals(uuid)'

SVC0 = "if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0; return; end if;"
SVC3 = "if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0, 0; return; end if;"
DELIVERY = "if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;"
SETTLE_DELIVERY = "if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;"


def policy_open(table):
    return ("drop policy %s_read on projects.%s; create policy %s_read on projects.%s for select to authenticated using (organization_id = (select core.current_organization_id()));"
            % (table, table, table, table))


# (name, kind, target, edits)  kind 'sql' -> target is the SQL text; kind 'fn' -> target is the regprocedure, edits is [(find, replace), ...]
CASES = [
    # ── the health sweep ──
    ('health sweep: role check removed', 'fn', HEALTH, [(SVC3, '')]),
    ('health sweep: reads paused workspaces too (the door below also refuses them)', 'fn', HEALTH, [("where w.state = 'active' and (p_organization_id", "where (p_organization_id")]),
    ('health sweep: records the snapshot as manual, not scheduled', 'fn', HEALTH, [("record_health_snapshot(r.project_id, 'scheduled', r.organization_id, p_now)", "record_health_snapshot(r.project_id, 'manual', r.organization_id, p_now)")]),
    ('health sweep: the sweep is granted to signed-in people', 'sql', "grant execute on function projects.sweep_phase_eight_health(uuid, timestamp with time zone, integer) to authenticated;", None),
    # ── the check-in due sweep ──
    ('check-in sweep: role check removed', 'fn', CHECKINS, [(SVC0, '')]),
    ('check-in sweep: notices a check-in that is not yet due', 'fn', CHECKINS, [("c.due_on <= v_today", "c.due_on <= v_today + 365")]),
    ('check-in sweep: notices a paused workspace', 'fn', CHECKINS, [("and w.state = 'active' and (p_organization_id is null or c.organization_id", "and (p_organization_id is null or c.organization_id")]),
    ('check-in sweep: forgets it already noticed a check-in (sweep layer; the key still holds)', 'fn', CHECKINS, [("and not exists (select 1 from projects.cs_check_in_due_notices n where n.check_in_id = c.id)", "")]),
    ('check-in notice: one-per-check-in key dropped (database layer; the sweep still filters)', 'sql', "alter table projects.cs_check_in_due_notices drop constraint cs_check_in_due_notices_check_in_id_key;", None),
    ('check-in sweep: the eligibility answer comes from the wrong category', 'fn', CHECKINS, [("where e.category = 'relationship'", "where e.category = 'operational'")]),
    ('check-in sweep: no event for a notice', 'fn', CHECKINS, [("perform core.emit_event(r.organization_id, 'customer.check_in_due', 'cs_check_in', r.id, jsonb_build_object('projectId', r.project_id, 'checkInId', r.id, 'kind', r.kind, 'dueOn', r.due_on));", "")]),
    ('check-in notice: append-only guard dropped', 'sql', "drop trigger cs_check_in_due_notices_append_only on projects.cs_check_in_due_notices;", None),
    ('check-in notice: read policy open to a client of the organization', 'sql', policy_open('cs_check_in_due_notices'), None),
    ('check-in notice: a signed-in person may insert', 'sql', "grant insert on projects.cs_check_in_due_notices to authenticated;", None),
    # ── a client's support message opens a ticket ──
    ('message door: role check removed', 'fn', MSGDOOR, [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;", '')]),
    ('message door: a staff message opens a ticket', 'fn', MSGDOOR, [("if v_m.author_type <> 'client' then return query select 'not_a_client_message'::text, null::uuid; return; end if;", '')]),
    ('message door: any conversation kind opens a ticket', 'fn', MSGDOOR, [("if v_c.id is null or v_c.kind <> 'project_group' or v_c.project_id is null then", "if v_c.id is null then")]),
    ('message door: a paused workspace opens a ticket', 'fn', MSGDOOR, [("if v_w.state <> 'active' then return query select 'workspace_not_active'::text, null::uuid; return; end if;", '')]),
    ('message door: a project with no workspace is not refused here (the ticket door still refuses)', 'fn', MSGDOOR, [("if v_w.id is null then return query select 'no_phase_eight'::text, null::uuid; return; end if;", '')]),
    ('message door: an unlabelled message opens a ticket', 'fn', MSGDOOR, [("if v_m.intent is null then", "if false then")]),
    ('message door: any intent label opens a ticket', 'fn', MSGDOOR, [("if v_m.intent <> 'support_request' then return query select 'not_a_support_request'::text, null::uuid; return; end if;", '')]),
    ('message door: the message is found without the organization filter', 'fn', MSGDOOR, [("where m.id = p_message_id and m.organization_id = p_organization_id;", "where m.id = p_message_id;")]),
    ('message door: the ticket has no source reference, so a repeat is not recognised', 'fn', MSGDOOR, [("v_src, v_m.id::text) t;", "v_src, null) t;")]),
    ('message sweep: role check removed', 'fn', MSGSWEEP, [(SVC0, '')]),
    ('message sweep: looks at messages of any age', 'fn', MSGSWEEP, [("and m.created_at > clock_timestamp() - interval '3 days'", "")]),
    ('message sweep: looks at paused workspaces too', 'fn', MSGSWEEP, [("and w.state = 'active'", "")]),
    ('message sweep: looks at every label', 'fn', MSGSWEEP, [("m.intent = 'support_request'", "true")]),
    ('message sweep: forgets which messages already have a ticket', 'fn', MSGSWEEP, [("and not exists (select 1 from projects.support_tickets t where t.organization_id = m.organization_id and t.source_ref = m.id::text)", "")]),
    # ── client action requests ──
    ('raise: delivery-rights check removed', 'fn', CREATE, [(DELIVERY, '')]),
    ('raise: deadline check removed (the column is NOT NULL, so a null deadline still fails)', 'fn', CREATE, [("if p_due_at is null or p_due_at <= clock_timestamp() then return query select 'due_in_the_past'::text, null::uuid; return; end if;", '')]),
    ('raise: secret refusal removed from the door (the table CHECK still holds)', 'fn', CREATE, [("if projects.p7_has_secret(v_title) or projects.p7_has_secret(v_ins) then return query select 'contains_secret'::text, null::uuid; return; end if;", '')]),
    ('raise: Phase 7 pipeline check removed', 'fn', CREATE, [("if not exists (select 1 from projects.phase_seven s where s.project_id = p_project_id) then return query select 'not_in_phase_seven'::text, null::uuid; return; end if;", '')]),
    ('raise: project found without the organization filter (the tenancy trigger still holds)', 'fn', CREATE, [("where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null;", "where p.id = p_project_id and p.deleted_at is null;")]),
    ('raise: duplicate not recognised at the door (the unique index still holds)', 'fn', CREATE, [("if v_id is not null then return query select 'already_open'::text, v_id; return; end if;", '')]),
    ('raise: kind list widened (door layer; the CHECK still holds)', 'fn', CREATE, [("if p_kind not in ('dns_change', 'store_account', 'account_access', 'content_supply', 'approval_input', 'other') then return query select 'bad_kind'::text, null::uuid; return; end if;", '')]),
    ('answer: client check removed (the account check still refuses a person with no account)', 'fn', RESOLVE, [("if not coalesce((select core.is_client()), false) then return query select 'not_a_client'::text; return; end if;", '')]),
    ('answer: account and project checks removed together (defence in depth)', 'fn', RESOLVE, [("if v_p.id is null or v_r.client_account_id is distinct from (select core.current_client_account_id()) then return query select 'not_found'::text; return; end if;", '')]),
    ('answer: read-only portal check removed', 'fn', RESOLVE, [("if projects.p7b_portal_access(v_r.project_id) <> 'open' then return query select 'portal_read_only'::text; return; end if;", '')]),
    ('answer: note check removed', 'fn', RESOLVE, [("if v_note is null or length(v_note) < 10 or length(v_note) > 4000 then return query select 'note_required'::text; return; end if;", '')]),
    ('answer: secret refusal removed from the door (the table CHECK still holds)', 'fn', RESOLVE, [("if projects.p7_has_secret(v_note) or projects.p7_has_secret(v_ref) then return query select 'contains_secret'::text; return; end if;", '')]),
    ('answer: already-submitted not recognised', 'fn', RESOLVE, [("if v_r.status = 'submitted' then return query select 'already_submitted'::text; return; end if;", '')]),
    ('answer: a settled request can be answered again (the identity trigger still holds)', 'fn', RESOLVE, [("if v_r.status <> 'open' then return query select 'not_open'::text; return; end if;", '')]),
    ('settle: delivery-rights check removed', 'fn', SETTLE, [(SETTLE_DELIVERY, '')]),
    ('settle: request found without the organization filter', 'fn', SETTLE, [("where r.id = p_request_id and r.organization_id = v_org for update;", "where r.id = p_request_id for update;")]),
    ('settle: confirmation without a verification', 'fn', SETTLE, [("if v_note is null or length(v_note) < 10 then return query select 'verification_required'::text; return; end if;", '')]),
    ('settle: sending it back without a note (door layer)', 'fn', SETTLE, [("if v_note is null then return query select 'note_required'::text; return; end if;", '')]),
    ('settle: confirming a claim nobody made', 'fn', SETTLE, [("if v_r.status <> 'submitted' then return query select 'nothing_to_confirm'::text; return; end if;", '')]),
    ('settle: cancelling without a reason (door layer)', 'fn', SETTLE, [("if v_note is null or length(v_note) < 5 then return query select 'reason_required'::text; return; end if;", '')]),
    ('settle: a settled request can be settled again (the identity trigger still holds)', 'fn', SETTLE, [("if v_r.status in ('confirmed', 'cancelled') then return query select 'already_settled'::text; return; end if;", '')]),
    ('client read: every account''s requests (account filters and the project guard removed together)', 'fn', CLIENTREAD, [("v_p := projects.p7b_portal_project(p_project_id);\n  if v_p.id is null or projects.p7b_portal_access(p_project_id) = 'expired' then return; end if;", "if projects.p7b_portal_access(p_project_id) = 'expired' then return; end if;"),
                                                                                                                  ("r.client_account_id = (select core.current_client_account_id()) and r.client_account_id = v_p.client_account_id and", "")]),
    ('client read: staff can read it (client check and the first account filter removed)', 'fn', CLIENTREAD, [("if not coalesce((select core.is_client()), false) then return; end if;", ''), ("r.client_account_id = (select core.current_client_account_id()) and", "")]),
    ('client read: cancelled requests are shown', 'fn', CLIENTREAD, [("and r.status <> 'cancelled'", "")]),
    ('client read: the internal confirmation note is shown as the returned note', 'fn', CLIENTREAD, [("r.submitted_at, r.returned_note, r.confirmed_at", "r.submitted_at, r.confirmation_note, r.confirmed_at")]),
    ('client read: an expired portal is still readable', 'fn', CLIENTREAD, [("if v_p.id is null or projects.p7b_portal_access(p_project_id) = 'expired' then return; end if;", "if v_p.id is null then return; end if;")]),
    ('client action: identity trigger dropped', 'sql', "drop trigger p7c_client_action_requests_identity on projects.p7c_client_action_requests;", None),
    ('client action: door-only trigger dropped', 'sql', "drop trigger p7c_client_action_requests_door_only on projects.p7c_client_action_requests;", None),
    ('client action: event append-only trigger dropped', 'sql', "drop trigger p7c_client_action_events_append_only on projects.p7c_client_action_events;", None),
    ('client action: request read policy open to a client', 'sql', policy_open('p7c_client_action_requests'), None),
    ('client action: event read policy open to a client', 'sql', policy_open('p7c_client_action_events'), None),
    ('client action: a signed-in person may update the request table', 'sql', "grant update on projects.p7c_client_action_requests to authenticated;", None),
    ('client action: the confirmed-needs-a-verifier CHECK dropped (table layer)', 'sql', "alter table projects.p7c_client_action_requests drop constraint p7c_car_confirmed_is_verified;", None),
    ('client action: the tenancy guard on client_account_id dropped', 'sql', "drop trigger p7c_client_action_requests_parent_org_client_account_id on projects.p7c_client_action_requests;", None),
    ('client action: organization freeze dropped', 'sql', "drop trigger freeze_org_p7c_client_action_requests on projects.p7c_client_action_requests;", None),
    # ── the failure queue ──
    ('queue: a client reads it (internal check removed)', 'fn', QUEUE, [("if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) then return; end if;", '')]),
    ('queue: another organization''s failures are read (organization filter removed)', 'fn', QUEUE, [("where (v_org is null or q.o = v_org)", "where true")]),
    ('queue: a failed validation stays after a later pass', 'fn', QUEUE, [("and not exists (select 1 from projects.p7_validation_runs r2 where r2.deployment_id = r.deployment_id and r2.started_at > r.started_at and r2.status = 'passed')", "")]),
    ('queue: a failed deployment stays after a later attempt', 'fn', QUEUE, [("and not exists (select 1 from projects.p7_deployments d2 where d2.project_id = d.project_id and d2.created_at > d.created_at)", "")]),
    ('queue: a closed incident stays', 'fn', QUEUE, [("from projects.p7_incidents i where i.state <> 'closed'", "from projects.p7_incidents i")]),
    ('queue: a fresh deployment approval is stale', 'fn', QUEUE, [("and p.updated_at < v_now - make_interval(hours => v_stale)", "")]),
    ('queue: a fresh handover review is stale', 'fn', QUEUE, [("< v_now - make_interval(hours => v_stale)\n    union all\n    select 'client_action_overdue'", "< v_now + interval '999 days'\n    union all\n    select 'client_action_overdue'")]),
    ('queue: a client action that is not yet due is overdue', 'fn', QUEUE, [("where c.status = 'open' and c.due_at < v_now", "where c.status = 'open'")]),
    ('queue: a settled client action is overdue', 'fn', QUEUE, [("where c.status = 'open' and c.due_at < v_now", "where c.due_at < v_now")]),
    ('queue: the age is not the caller''s', 'fn', QUEUE, [("v_stale int := greatest(coalesce(p_stale_hours, 24), 1);", "v_stale int := 24;")]),
    ('queue: granted to anon', 'sql', "grant execute on function projects.p7_failure_queue(uuid, integer, timestamp with time zone) to anon;", None),
    # ── the automatic draft handover package ──
    ('draft door: role check removed', 'fn', DRAFT, [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;", '')]),
    ('draft door: the workspace is found without the organization filter', 'fn', DRAFT, [("where s.id = p_phase_seven_id and s.organization_id = p_organization_id for update;", "where s.id = p_phase_seven_id for update;")]),
    ('draft door: an existing package is not recognised at the door (the one-live-package index still holds)', 'fn', DRAFT, [("if v_existing is not null then return query select 'already_exists'::text, v_existing; return; end if;", '')]),
    ('draft door: production validation is not required (the NOT NULL column still fails)', 'fn', DRAFT, [("if v_v.deployment_id is null then return query select 'production_not_validated'::text, null::uuid; return; end if;", '')]),
    ('draft door: the money gate is not re-read', 'fn', DRAFT, [("if not projects.m4_verified_paid(v_s.project_id) then return query select 'm4_not_verified'::text, null::uuid; return; end if;", '')]),
    ('draft door: no contract checklist is needed', 'fn', DRAFT, [("if not exists (select 1 from projects.p7_contract_deliverables d where d.project_id = v_s.project_id) then return query select 'contract_deliverables_missing'::text, null::uuid; return; end if;", '')]),
    ('draft door: the workspace does not move to handover preparation', 'fn', DRAFT, [("perform projects.p7_set_state(v_s.project_id, 'handover_preparing');", "")]),
    ('draft door: only one of the six standing items is created', 'fn', DRAFT, [("('scope', 'Final approved scope'), ('release', 'Release / build / version'), ('production_url', 'Production URL and environment'),\n         ('known_limitations', 'Known limitations'), ('support_warranty', 'Support and warranty terms'), ('emergency_contacts', 'Emergency and support contacts')", "('scope', 'Final approved scope')")]),
    ('draft door: a contract exclusion is dropped', 'fn', DRAFT, [("case when c.required then 'pending' else 'not_required' end", "'pending'")]),
    ('draft door: the draft is announced twice', 'fn', DRAFT, [("perform core.emit_event(v_s.organization_id, 'project.handover_draft_created', 'handover_package', v_new, jsonb_build_object('projectId', v_s.project_id, 'version', v_next));", "perform core.emit_event(v_s.organization_id, 'project.handover_draft_created', 'handover_package', v_new, jsonb_build_object('projectId', v_s.project_id, 'version', v_next)); perform core.emit_event(v_s.organization_id, 'project.handover_draft_created', 'handover_package', v_new, jsonb_build_object('projectId', v_s.project_id, 'version', v_next));")]),
    ('draft sweep: role check removed', 'fn', DRAFTSWEEP, [(SVC0, '')]),
    ('draft sweep: looks at projects that are not validated', 'fn', DRAFTSWEEP, [("where s.state = 'production_validated' and (p_organization_id", "where (p_organization_id")]),
    ('draft sweep: looks at projects with no checklist', 'fn', DRAFTSWEEP, [("and exists (select 1 from projects.p7_contract_deliverables d where d.project_id = s.project_id)", "")]),
    ('draft sweep: forgets which projects already have a package', 'fn', DRAFTSWEEP, [("and not exists (select 1 from projects.p7_handover_packages p where p.project_id = s.project_id and p.status in ('draft', 'admin_review', 'changes_requested', 'approved', 'delivered'))", "")]),
    # ── the client statement ──
    ('statement: a staff token with an account claim is a client', 'fn', ACCT, [("case when coalesce((select core.is_client()), false) then (select core.current_client_account_id()) end", "(select core.current_client_account_id())")]),
    ('statement: drafts and invoices awaiting approval are shown', 'fn', STMT, [("and i.status not in ('draft', 'pending_approval')\n       and (p_project_id is null or i.project_id = p_project_id)", "and (p_project_id is null or i.project_id = p_project_id)")]),
    ('statement: every account''s invoices are shown', 'fn', STMT, [("i.organization_id = v_org and i.client_account_id = v_acct and", "i.organization_id = v_org and")]),
    ('statement: the organization of the claim is not checked', 'fn', STMT, [("where i.organization_id = v_org and i.client_account_id = v_acct and", "where i.client_account_id = v_acct and")]),
    ('statement: outstanding counts money nobody verified as received', 'fn', STMT, [("greatest(i.total_minor - i.verified_minor, 0)", "greatest(i.total_minor - i.paid_minor, 0)")]),
    ('statement: money awaiting verification is hidden', 'fn', STMT, [("greatest(i.paid_minor - i.verified_minor, 0),", "0::bigint,")]),
    ('statement: a void invoice still owes', 'fn', STMT, [("case when i.status = 'void' then 0 else greatest(i.total_minor - i.verified_minor, 0) end", "greatest(i.total_minor - i.verified_minor, 0)")]),
    ('statement: overdue is never said', 'fn', STMT, [("(i.status in ('issued', 'partially_paid', 'overdue') and i.due_at is not null and i.due_at < clock_timestamp())", "false")]),
    ('statement: a project filter and its guard removed together', 'fn', STMT, [("if p_project_id is not null and projects.p7b_portal_project(p_project_id) is null then return; end if;", ''), ("and (p_project_id is null or i.project_id = p_project_id)", "")]),
    ('statement: a project of an expired portal is still shown', 'fn', STMT, [("and (i.project_id is null or projects.p7b_portal_access(i.project_id) <> 'expired')", "")]),
    ('payments: an unverified payment is listed as received', 'fn', STMTPAY, [("and y.status = 'captured' and y.verified_at is not null", "and y.status = 'captured'")]),
    ('payments: a refunded payment is listed as received', 'fn', STMTPAY, [("and y.status = 'captured' and y.verified_at is not null", "and y.verified_at is not null")]),
    ('payments: every account''s payments are listed', 'fn', STMTPAY, [("and i.client_account_id = v_acct and", "and")]),
    ('payments: the project of an expired portal is still listed', 'fn', STMTPAY, [("and (i.project_id is null or projects.p7b_portal_access(i.project_id) <> 'expired')", "")]),
    ('totals: a void invoice is counted as invoiced', 'fn', STMTTOT, [("coalesce(sum(s.total_minor) filter (where s.status <> 'void'), 0)::bigint", "coalesce(sum(s.total_minor), 0)::bigint")]),
    ('statement: the statement function is granted to the service role', 'sql', "grant execute on function projects.client_financial_statement(uuid) to service_role;", None),
]


def env_user():
    return os.environ.get('PGUSER', 'postgres')


def env_db():
    return os.environ.get('PGDATABASE', 'agencyos_local')


def psql(path):
    return subprocess.run(['psql', '-U', env_user(), '-d', env_db(), '-v', 'ON_ERROR_STOP=1', '-q', '-o', '/dev/null', '-f', str(path)], env=dict(os.environ), capture_output=True, text=True)


def injection(kind, target, edits):
    if kind == 'sql':
        return target + '\n'
    expr = "d"
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
    base_ok = base.returncode == 0
    print(f'baseline verifier: {"PASS" if base_ok else "FAIL (the harness is meaningless until it passes)"}')
    if not base_ok:
        print((base.stdout + base.stderr)[-600:])
        return 2
    results = []
    only = [a for a in sys.argv[1:] if not a.startswith('--')]
    for name, kind, target, edits in CASES:
        if only and not any(o in name for o in only):
            continue
        mutated = text.replace(marker, marker + injection(kind, target, edits), 1)
        f = Path('/tmp') / 'redproof-phase-seven-c.sql'
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
