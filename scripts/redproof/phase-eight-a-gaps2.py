#!/usr/bin/env python3
"""
Red-proof harness for scripts/verify-phase-eight-a-gaps2.sql (Phase 8A second half).

A verifier that has never failed proves nothing. Each case removes ONE control from the LIVE definition (a function body is fetched with pg_get_functiondef
and mutated; a constraint, index, trigger, policy or grant is dropped) INSIDE the verifier's own transaction, so nothing persists and nothing needs restoring.

  KEEP=1 scripts/apply-migrations-locally.sh               # leaves a scratch Postgres running; it prints its socket directory
  PGHOST=<that directory> PGPORT=<port> python3 scripts/redproof/phase-eight-a-gaps2.py
  python3 scripts/redproof/phase-eight-a-gaps2.py --list   # counts only; needs no database

A case that stays green is reported GREEN: the verifier cannot see that control. A pattern that is not found raises NO-OP and is reported NOOP.
A rule held by two layers has a case for each layer. Where only ONE layer can be removed without the other covering for it (for example the internal-only
guard inside a read that row security also protects) no case is claimed: the log says so.
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / 'scripts' / 'verify-phase-eight-a-gaps2.sql'

P = 'projects.'
T = 'timestamp with time zone'
CORR = P + 'p8_correlation_id()'
PROBE = P + 'probe_tenant_access(text,uuid)'
PREF = P + 'set_client_contact_preference(uuid,text,text[],text,text)'
SETCAD = P + 'set_communication_category_cadence(text,integer)'
CLRCAD = P + 'clear_communication_category_cadence(text)'
GOV = P + 'can_contact_governed(uuid,text,text,uuid,' + T + ')'
FEED = P + 'p8f_record_client_feedback(uuid,text,text,text,uuid,' + T + ')'
GOAL = P + 'record_client_goal(uuid,text)'
CLOSEG = P + 'close_client_goal(uuid,text,text)'
FOLLOW = P + 'request_support_followup(uuid,text,text)'
NEXT = P + 'customer_success_next_actions(' + T + ')'
PROV = P + 'record_provider_delivery_callback(uuid,text,text,text,text,' + T + ')'
HIST = P + 'client_communication_history(uuid,integer)'
RECON = P + 'reconcile_phase_eight_metrics(' + T + ')'

WRITE_GUARD = "if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;"
WRITE_GUARD2 = "if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;"
ADMIN_GUARD = "if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;"
PH_ORG = "select * into v_ph from projects.phase_eight w where w.project_id = p_project_id and w.organization_id = v_org;"
PH_ANY = "select * into v_ph from projects.phase_eight w where w.project_id = p_project_id;"


def open_policy(table):
    return ("drop policy %s_read on projects.%s; create policy %s_read on projects.%s for select to authenticated using (organization_id = (select core.current_organization_id()));"
            % (table, table, table, table))


# (name, kind, target, edits)  kind 'sql' -> target is the SQL text; kind 'fn' -> target is the regprocedure, edits is [(find, replace), ...]
CASES = [
    # ── 1. correlation id ──
    ('ticket event kinds lose the two follow-up kinds', 'sql', "alter table projects.support_ticket_events drop constraint support_ticket_events_kind_check; alter table projects.support_ticket_events add constraint support_ticket_events_kind_check check (kind in ('opened', 'classified', 'assigned', 'linked', 'state_changed', 'escalated', 'escalation_acknowledged', 'proposal_recorded', 'reply_drafted', 'reply_sent', 'reply_discarded', 'client_confirmed', 'client_rejected', 'sla_breach', 'cancelled'));", None),
    # ── 2. the audited tenant denial ──
    ('probe: the denial is not audited', 'fn', PROBE, [("perform core.record_audit(v_org, 'access.cross_tenant_denied', p_subject_type, p_subject_id, null, jsonb_build_object('actor', v_actor, 'subjectType', p_subject_type));", '')]),
    ('probe: a foreign record is granted', 'fn', PROBE, [("if v_home then return query select 'granted'::text; return; end if;", "if v_home or v_elsewhere then return query select 'granted'::text; return; end if;")]),
    ('probe: a MISSING record is audited as a denial too', 'fn', PROBE, [("if v_elsewhere then", "if true then")]),
    ('probe: a foreign project is treated as the caller\'s own', 'fn', PROBE, [("coalesce(bool_or(x.organization_id = v_org), false), coalesce(bool_or(x.organization_id <> v_org), false) into v_home, v_elsewhere from projects.projects x", "true, false into v_home, v_elsewhere from projects.projects x")]),
    ('probe: a foreign client account is treated as the caller\'s own', 'fn', PROBE, [("coalesce(bool_or(x.organization_id = v_org), false), coalesce(bool_or(x.organization_id <> v_org), false) into v_home, v_elsewhere from core.client_accounts x", "true, false into v_home, v_elsewhere from core.client_accounts x")]),
    ('probe: an unknown subject type falls through to granted', 'fn', PROBE, [("else\n    return query select 'not_available'::text; return;\n  end if;", "else\n    v_home := true;\n  end if;")]),
    ('probe: the service role is granted the person door', 'sql', 'grant execute on function projects.probe_tenant_access(text, uuid) to service_role;', None),
    # ── 3. preferences ──
    ('preference: the write check is removed', 'fn', PREF, [(WRITE_GUARD, '')]),
    ('preference: the preferred-channel refusal is removed (door layer)', 'fn', PREF, [("if p_preferred_channel is not null and p_preferred_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select 'bad_channel'::text; return; end if;", '')]),
    ('preference: the avoid-list refusal is removed (door layer)', 'fn', PREF, [("if not (v_avoid <@ array['whatsapp', 'email', 'portal', 'call', 'meeting']) then return query select 'bad_channel'::text; return; end if;", '')]),
    ('preference: preferred-and-avoided is not refused (door layer)', 'fn', PREF, [("if p_preferred_channel is not null and p_preferred_channel = any (v_avoid) then return query select 'preferred_is_avoided'::text; return; end if;", '')]),
    ('preference: the language refusal is removed (door layer)', 'fn', PREF, [("if v_lang is not null and v_lang !~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' then return query select 'bad_language'::text; return; end if;", '')]),
    ('preference: the client tenancy filter is removed', 'fn', PREF, [("a.id = p_client_account_id and a.organization_id = v_org", "a.id = p_client_account_id")]),
    ('preference: the audit row is not written', 'fn', PREF, [("perform core.record_audit(v_org, 'client_communication.preference_set'", "perform 1 where false and core.record_audit(v_org, 'client_communication.preference_set'")]),
    ('preference: the not-both constraint is dropped (table layer)', 'sql', 'alter table projects.p8f_contact_preferences drop constraint p8f_contact_preferences_not_both;', None),
    ('preference: the guard trigger is dropped (a direct write)', 'sql', 'drop trigger p8f_contact_preferences_p8_guard on projects.p8f_contact_preferences;', None),
    ('preference: the parent-org guard is dropped (tenancy)', 'sql', 'drop trigger org_match_client_contact_preferences_client_account_id on projects.p8f_contact_preferences;', None),
    # ── 4. cadence and the governed read ──
    ('cadence: the Admin check is removed (set)', 'fn', SETCAD, [(ADMIN_GUARD, '')]),
    ('cadence: the Admin check is removed (clear)', 'fn', CLRCAD, [(ADMIN_GUARD, '')]),
    ('cadence: the purpose refusal is removed (door layer)', 'fn', SETCAD, [("if p_purpose is null or p_purpose not in ('operational', 'relationship', 'commercial') then return query select 'bad_purpose'::text; return; end if;", '')]),
    ('cadence: the range refusal is removed (door layer)', 'fn', SETCAD, [("if p_min_gap_days is null or p_min_gap_days < 0 or p_min_gap_days > 365 then return query select 'out_of_range'::text; return; end if;", '')]),
    ('cadence: only an ACTIVE cadence can be cleared', 'fn', CLRCAD, [("and c.active for update", "for update")]),
    ('cadence: the guard trigger is dropped (a direct write)', 'sql', 'drop trigger communication_category_cadence_p8_guard on projects.communication_category_cadence;', None),
    ('cadence: one row per category is not enforced', 'sql', 'alter table projects.communication_category_cadence drop constraint communication_category_cadence_organization_id_purpose_key;', None),
    ('governed: the category gap is never applied', 'fn', GOV, [("if v_last is not null and v_last > p_now - make_interval(days => c.min_gap_days) then", "if false then")]),
    ('governed: the gap counts every category', 'fn', GOV, [("and l.purpose = p_purpose and l.occurred_at <= p_now", "and l.occurred_at <= p_now")]),
    ('governed: an agent draft counts as a contact', 'fn', GOV, [("l.entry_kind = 'sent_by_person' and l.purpose = p_purpose", "l.purpose = p_purpose")]),
    ('governed: a cleared cadence still applies', 'fn', GOV, [("cc.purpose = p_purpose and cc.active", "cc.purpose = p_purpose")]),
    ('governed: the gap ignores the injected clock', 'fn', GOV, [("v_last > p_now - make_interval(days => c.min_gap_days)", "v_last > clock_timestamp() - make_interval(days => c.min_gap_days)")]),
    ('governed: an avoided channel is not refused', 'fn', GOV, [("if v_avoid is not null and p_channel = any (v_avoid) then", "if false then")]),
    ('governed: the base eligibility is dropped', 'fn', GOV, [("return query select cardinality(v_r) = 0, v_r;", "return query select true, '{}'::text[];")]),
    # ── 5. feedback and goals ──
    ('feedback: the write check is removed', 'fn', FEED, [(WRITE_GUARD2, '')]),
    ('feedback: the source refusal is removed (door layer)', 'fn', FEED, [("if p_source is null or p_source not in ('call', 'whatsapp', 'email', 'portal', 'meeting', 'survey') then return query select 'bad_source'::text, null::uuid; return; end if;", '')]),
    ('feedback: the sentiment refusal is removed (door layer)', 'fn', FEED, [("if p_sentiment is null or p_sentiment not in ('positive', 'neutral', 'negative', 'mixed') then return query select 'bad_sentiment'::text, null::uuid; return; end if;", '')]),
    ('feedback: the summary requirement is removed (door layer)', 'fn', FEED, [("if v_sum is null or length(v_sum) < 5 then return query select 'summary_required'::text, null::uuid; return; end if;", '')]),
    ('feedback: a future date is accepted', 'fn', FEED, [("if v_when > clock_timestamp() + interval '5 minutes' then return query select 'in_the_future'::text, null::uuid; return; end if;", '')]),
    ('feedback: the project tenancy filter is removed', 'fn', FEED, [(PH_ORG, PH_ANY)]),
    ('feedback: a check-in of another project is accepted', 'fn', FEED, [("c.id = p_check_in_id and c.project_id = p_project_id and c.organization_id = v_org", "c.id = p_check_in_id and c.organization_id = v_org")]),
    ('feedback: the append-only trigger is dropped', 'sql', 'drop trigger p8f_client_feedback_append_only on projects.p8f_client_feedback;', None),
    ('feedback: the parent-org guard is dropped (tenancy)', 'sql', 'drop trigger org_match_client_feedback_project_id on projects.p8f_client_feedback;', None),
    ('goal: the write check is removed (record)', 'fn', GOAL, [(WRITE_GUARD2, '')]),
    ('goal: the project tenancy filter is removed', 'fn', GOAL, [(PH_ORG, PH_ANY)]),
    ('goal: a duplicate is recorded again', 'fn', GOAL, [("if exists (select 1 from projects.client_goals g where g.project_id = p_project_id and g.status = 'active' and lower(btrim(g.goal)) = lower(v_g)) then", "if false then")]),
    ('goal: the goal requirement is removed (door layer)', 'fn', GOAL, [("if v_g is null or length(v_g) < 5 then return query select 'goal_required'::text, null::uuid; return; end if;", '')]),
    ('goal close: the write check is removed', 'fn', CLOSEG, [(WRITE_GUARD, '')]),
    ('goal close: the status refusal is removed (door layer)', 'fn', CLOSEG, [("if p_status is null or p_status not in ('achieved', 'dropped') then return query select 'bad_status'::text; return; end if;", '')]),
    ('goal close: the note requirement is removed (door layer)', 'fn', CLOSEG, [("if v_note is null then return query select 'note_required'::text; return; end if;", '')]),
    ('goal close: a closed goal can be closed again', 'fn', CLOSEG, [("if v_g.status <> 'active' then return query select 'already_closed'::text; return; end if;", '')]),
    ('goal: the closed-says-who constraint is dropped (table layer)', 'sql', 'alter table projects.client_goals drop constraint client_goals_closed_says_who;', None),
    ('goal: the guard trigger is dropped (a direct write)', 'sql', 'drop trigger client_goals_p8_guard on projects.client_goals;', None),
    # ── 6. support follow-ups ──
    ('follow-up: the write check is removed', 'fn', FOLLOW, [(WRITE_GUARD, '')]),
    ('follow-up: the kind refusal is removed (door layer)', 'fn', FOLLOW, [("if p_kind is null or p_kind not in ('developer', 'qa') then return query select 'bad_kind'::text; return; end if;", '')]),
    ('follow-up: the ticket tenancy filter is removed', 'fn', FOLLOW, [("t.id = p_ticket_id and t.organization_id = v_org for update", "t.id = p_ticket_id for update")]),
    ('follow-up: an unclassified ticket goes to a Developer', 'fn', FOLLOW, [("if v_t.classification is null or v_t.coverage_decision is null then return query select 'not_classified'::text; return; end if;", '')]),
    ('follow-up: a how-to becomes a Developer task', 'fn', FOLLOW, [("if v_t.classification not in ('warranty_bug', 'maintenance', 'minor_change') or v_t.coverage_decision not in ('covered_warranty', 'covered_maintenance', 'included_support') then", "if false then")]),
    ('follow-up: the Developer state refusal is removed', 'fn', FOLLOW, [("if v_t.status not in ('classified', 'assigned', 'in_progress') then return query select 'wrong_state'::text; return; end if;", '')]),
    ('follow-up: QA is asked before work has started', 'fn', FOLLOW, [("if v_t.status not in ('in_progress', 'in_qa') then return query select 'wrong_state'::text; return; end if;", '')]),
    ('follow-up: a repeat request is accepted', 'fn', FOLLOW, [("if exists (select 1 from projects.support_ticket_events e where e.ticket_id = v_t.id and e.kind = v_ev) then return query select 'already_requested'::text; return; end if;", '')]),
    ('follow-up: no ticket event is written', 'fn', FOLLOW, [("perform projects.p8_ticket_event(v_org, v_t.id, v_ev, v_t.status, v_t.status, v_actor, 'person', coalesce(v_note, p_kind || ' follow-up requested'), null, null);", '')]),
    ('follow-up: the event payload loses the priority', 'fn', FOLLOW, [("'priority', v_t.priority, ", '')]),
    ('follow-up: the event payload loses who asked', 'fn', FOLLOW, [("'requestedBy', v_actor, ", '')]),
    ('follow-up: the developer event is emitted under the wrong type', 'fn', FOLLOW, [("when 'developer' then 'support.developer_task_requested'", "when 'developer' then 'support.qa_verification_requested'")]),
    ('follow-up: the service role is granted the person door', 'sql', 'grant execute on function projects.request_support_followup(uuid,text,text) to service_role;', None),
    # ── 7. next actions ──
    ('next actions: an unacknowledged escalation is not queued', 'fn', NEXT, [("and t.escalated_at is not null and t.escalation_ack_at is null", "and false")]),
    ('next actions: an acknowledged escalation stays queued', 'fn', NEXT, [("and t.escalated_at is not null and t.escalation_ack_at is null", "and t.escalated_at is not null")]),
    ('next actions: an overdue resolution is not queued', 'fn', NEXT, [("t.resolution_due_at is not null and t.resolution_due_at < p_now", "false")]),
    ('next actions: an overdue response is not queued', 'fn', NEXT, [("t.first_response_at is null and t.response_due_at is not null and t.response_due_at < p_now", "false")]),
    ('next actions: a ticket not yet due is queued as overdue', 'fn', NEXT, [("t.resolution_due_at is not null and t.resolution_due_at < p_now", "t.resolution_due_at is not null")]),
    ('next actions: negative feedback is not queued', 'fn', NEXT, [("f.sentiment in ('negative', 'mixed')", "false")]),
    ('next actions: addressed feedback stays queued', 'fn', NEXT, [("and not exists (select 1 from projects.cs_check_ins c where c.project_id = f.project_id and c.status = 'completed' and c.completed_at > f.occurred_at)", '')]),
    ('next actions: a due check-in is not queued', 'fn', NEXT, [("c.status = 'due' and c.due_on <= (p_now at time zone 'UTC')::date", "false")]),
    ('next actions: a completed check-in stays queued', 'fn', NEXT, [("c.status = 'due' and c.due_on <= (p_now at time zone 'UTC')::date", "c.due_on <= (p_now at time zone 'UTC')::date")]),
    ('next actions: the queue is not ordered by priority', 'fn', NEXT, [("order by a.pr, a.due nulls last, l.name", "order by l.name desc")]),
    ('next actions: a closed workspace is queued', 'fn', NEXT, [("w.organization_id = v_org and w.state <> 'closed'", "w.organization_id = v_org")]),
    # ── 8. provider callbacks and the history ──
    ('callback: the in-function service check is removed', 'fn', PROV, [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;", '')]),
    ('callback: the event refusal is removed (door layer)', 'fn', PROV, [("if p_event is null or p_event not in ('delivered', 'read', 'failed', 'bounced') then return query select 'bad_event'::text; return; end if;", '')]),
    ('callback: the provider/reference requirement is removed', 'fn', PROV, [("if v_provider is null or v_ref is null then return query select 'provider_and_ref_required'::text; return; end if;", '')]),
    ('callback: an unmatched reference is not refused', 'fn', PROV, [("if v_l.id is null then return query select 'unmatched'::text; return; end if;", '')]),
    ('callback: an ambiguous reference is attached to one of them', 'fn', PROV, [("if v_n > 1 then return query select 'ambiguous'::text; return; end if;", '')]),
    ('callback: another organization\'s reference matches', 'fn', PROV, [("l.organization_id = p_organization_id and l.channel", "l.channel")]),
    ('callback: a delivery before the send is accepted', 'fn', PROV, [("if v_when < v_l.occurred_at then return query select 'before_the_send'::text; return; end if;", '')]),
    ('callback: a future delivery is accepted', 'fn', PROV, [("if v_when > clock_timestamp() + interval '5 minutes' then return query select 'in_the_future'::text; return; end if;", '')]),
    ('callback: a redelivered callback is not idempotent', 'fn', PROV, [("on conflict (ledger_id, provider, event) do nothing", '')]),
    ('callback: the one-fact-per-event index is dropped (table layer)', 'sql', 'drop index projects.client_communication_provider_events_once;', None),
    ('callback: the append-only trigger is dropped', 'sql', 'drop trigger client_communication_provider_events_append_only on projects.client_communication_provider_events;', None),
    ('callback: the parent-org guard is dropped (tenancy)', 'sql', 'drop trigger org_match_client_communication_provider_events_ledger_id on projects.client_communication_provider_events;', None),
    ('callback: the door is granted to signed-in people', 'sql', 'grant execute on function projects.record_provider_delivery_callback(uuid,text,text,text,text,timestamp with time zone) to authenticated;', None),
    ('history: the provider fact is not read', 'fn', HIST, [("coalesce(ev.event, pv.event, nullif", "coalesce(ev.event, nullif")]),
    ('history: the provider outranks a person', 'fn', HIST, [("coalesce(ev.event, pv.event, nullif", "coalesce(pv.event, ev.event, nullif")]),
    ('history: no signal reads as delivered', 'fn', HIST, [("nullif(m.metadata ->> 'delivery', ''), 'unknown')", "nullif(m.metadata ->> 'delivery', ''), 'delivered')")]),
    # ── 9. reconciliation ──
    ('reconcile: every check is reported as reconciled', 'fn', RECON, [("x.a = x.b, x.note", "true, x.note")]),
    ('reconcile: closed tickets are counted as open', 'fn', RECON, [("bucket not in ('closed', 'cancelled')", "bucket not in ('cancelled')")]),
    ('reconcile: the health-status comparison reads nothing from the overview', 'fn', RECON, [("(select count(*)::int from v where v.health_status = s.status)", "0")]),
    ('reconcile: the live-account count reads nothing from the overview', 'fn', RECON, [("(select count(*)::int from v),", "0,")]),
    ('reconcile: the recovery plans are not compared', 'fn', RECON, [("(select coalesce(sum(v.open_recovery_plans), 0)::int from v)", "(select coalesce(sum(n), 0)::int from o where metric = 'recovery_plans')")]),
    # ── 10. structure ──
    ('feedback read policy loses is_internal', 'sql', open_policy('p8f_client_feedback'), None),
    ('goal read policy loses is_internal', 'sql', open_policy('client_goals'), None),
    ('provider-event read policy loses is_internal', 'sql', open_policy('client_communication_provider_events'), None),
    ('a signed-in person is granted insert on the goals', 'sql', 'grant insert on projects.client_goals to authenticated;', None),
    ('a signed-in person is granted update on the preferences', 'sql', 'grant update on projects.p8f_contact_preferences to authenticated;', None),
    ('the organization freeze trigger is dropped from the feedback table', 'sql', 'drop trigger freeze_org_client_feedback on projects.p8f_client_feedback;', None),
    ('the service role loses read on the provider events', 'sql', 'revoke select on projects.client_communication_provider_events from service_role;', None),
]


def env_user():
    return os.environ.get('PGUSER', 'postgres')


def env_db():
    return os.environ.get('PGDATABASE', 'agencyos_local')


def psql(path):
    return subprocess.run(['psql', '-U', env_user(), '-d', env_db(), '-v', 'ON_ERROR_STOP=1', '-q', '-f', str(path)], env=dict(os.environ), capture_output=True, text=True)


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
    base_ok = base.returncode == 0 and 'verified OK' in base.stdout
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
        f = Path(os.environ.get('TMPDIR', '/tmp')) / 'redproof-phase-eight-a-gaps2.sql'
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
