#!/usr/bin/env python3
"""
Red-proof harness for scripts/verify-phase-eight-d.sql.

A verifier that has never failed proves nothing. Each case below removes ONE control from the LIVE definition (a function body is fetched with
pg_get_functiondef and mutated; a constraint, index, trigger, policy, grant or seeded row is dropped) INSIDE the verifier's own transaction, so nothing
persists and nothing needs restoring: the verifier rolls back at its end, and a failing run rolls back at the error.

  KEEP=1 scripts/apply-migrations-locally.sh               # leaves a scratch Postgres running; it prints its socket directory
  PGHOST=<that directory> PGPORT=<port> python3 scripts/redproof/phase-eight-d.py
  python3 scripts/redproof/phase-eight-d.py --list         # counts only; needs no database

A case that stays green is reported GREEN: the verifier cannot see that control (or another layer covers for it) and the case must be fixed.
A mutation whose pattern is not found raises NO-OP and is reported NOOP: a mutation that changes nothing proves nothing.
Where a rule is held by two layers (a door and a CHECK) there is a case for each layer, and the verifier has a check that reaches each one.
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / 'scripts' / 'verify-phase-eight-d.sql'

P = 'projects.'
T = 'timestamp with time zone'

CCN = P + 'can_contact_now(uuid,text,text,uuid,' + T + ')'
REC = P + 'record_client_communication(uuid,text,text,text,uuid,uuid,' + T + ',uuid,text)'
DRAFT = P + 'record_agent_communication_draft(uuid,uuid,text,text,text,text,uuid,uuid)'
EVT = P + 'record_client_communication_event(uuid,text,text,' + T + ')'
SETCAP = P + 'set_client_communication_cap(uuid,text,integer,integer)'
CLRCAP = P + 'clear_client_communication_cap(uuid,text)'
ADDQ = P + 'add_client_quiet_period(uuid,' + T + ',' + T + ',text)'
CANQ = P + 'cancel_client_quiet_period(uuid,text)'
HIST = P + 'client_communication_history(uuid,integer)'
FACTS = P + 'value_report_facts(uuid,date,date)'
STORE = P + 'p8d_store_value_report(uuid,uuid,text,uuid,date,date,integer,text,text)'
STORE_P = P + 'store_value_report_draft(uuid,date,date,integer,text,text)'
STORE_A = P + 'store_value_report_draft_as_agent(uuid,uuid,date,date,integer,text,text,text)'
EDIT = P + 'edit_value_report_draft(uuid,text)'
APPROVE = P + 'approve_value_report_draft(uuid)'
DISCARD = P + 'discard_value_report_draft(uuid,text)'
OBS = P + 'phase_eight_observability(' + T + ')'

ADMIN_GUARD = "if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;"
ADMIN_GUARD2 = "if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;"
WRITE_GUARD = "if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;"
WRITE_GUARD2 = "if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;"
SERVICE_GUARD2 = "if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;"
CLIENT_NOT_FOUND = "if not exists (select 1 from core.client_accounts a where a.id = p_client_account_id and a.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;"

# the read policies, re-created WITHOUT the internal-only half
def open_policy(table):
    return ("drop policy %s_read on projects.%s; create policy %s_read on projects.%s for select to authenticated using (organization_id = (select core.current_organization_id()));"
            % (table, table, table, table))

# (name, kind, target, edits)  kind 'sql' -> target is the SQL text; kind 'fn' -> target is the regprocedure, edits is [(find, replace), ...]
CASES = [
    # ── roster ──
    ('roster: support to customer_success edge missing', 'sql', "delete from ai.agent_handoff_targets where from_agent = 'support' and to_agent = 'customer_success';", None),
    ('roster: support to sales edge missing', 'sql', "delete from ai.agent_handoff_targets where from_agent = 'support' and to_agent = 'sales';", None),
    ('roster: customer_success to support edge missing', 'sql', "delete from ai.agent_handoff_targets where from_agent = 'customer_success' and to_agent = 'support';", None),
    ('roster: customer_success to finance edge missing', 'sql', "delete from ai.agent_handoff_targets where from_agent = 'customer_success' and to_agent = 'finance';", None),
    ('roster: sales return edge to customer_success missing', 'sql', "delete from ai.agent_handoff_targets where from_agent = 'sales' and to_agent = 'customer_success';", None),
    ('roster: upsell gains a wider edge', 'sql', "insert into ai.agent_handoff_targets (from_agent, to_agent) values ('upsell', 'support');", None),
    # ── caps and quiet periods ──
    ('set cap: Admin check removed', 'fn', SETCAP, [(ADMIN_GUARD, '')]),
    ('set cap: range refusal removed (door layer)', 'fn', SETCAP, [("if p_max_contacts is null or p_max_contacts < 1 or p_max_contacts > 1000 or p_window_days is null or p_window_days < 1 or p_window_days > 365 then return query select 'out_of_range'::text; return; end if;", '')]),
    ('set cap: channel refusal removed (door layer)', 'fn', SETCAP, [("if p_channel is not null and p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select 'bad_channel'::text; return; end if;", '')]),
    ('set cap: client tenancy filter removed', 'fn', SETCAP, [("a.id = p_client_account_id and a.organization_id = v_org", "a.id = p_client_account_id")]),
    ('clear cap: Admin check removed', 'fn', CLRCAP, [(ADMIN_GUARD, '')]),
    ('clear cap: only an ACTIVE cap can be cleared', 'fn', CLRCAP, [("and cp.active for update", "for update")]),
    ('add quiet period: Admin check removed', 'fn', ADDQ, [(ADMIN_GUARD2, '')]),
    ('add quiet period: reason requirement removed (door layer)', 'fn', ADDQ, [("if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text, null::uuid; return; end if;", '')]),
    ('add quiet period: forward-interval refusal removed (door layer)', 'fn', ADDQ, [("if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then return query select 'bad_interval'::text, null::uuid; return; end if;", '')]),
    ('cancel quiet period: Admin check removed', 'fn', CANQ, [(ADMIN_GUARD, '')]),
    ('cancel quiet period: reason requirement removed (door layer)', 'fn', CANQ, [("if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text; return; end if;", '')]),
    ('cancel quiet period: already-cancelled refusal removed', 'fn', CANQ, [("if v_q.cancelled_at is not null then return query select 'already_cancelled'::text; return; end if;", '')]),
    ('cap guard trigger dropped (a direct write to a cap)', 'sql', 'drop trigger client_communication_caps_p8_guard on projects.client_communication_caps;', None),
    ('quiet-period guard trigger dropped', 'sql', 'drop trigger client_quiet_periods_p8_guard on projects.client_quiet_periods;', None),
    # ── the ledger ──
    ('ledger append-only trigger dropped', 'sql', 'drop trigger client_communication_ledger_append_only on projects.client_communication_ledger;', None),
    ('events append-only trigger dropped', 'sql', 'drop trigger client_communication_events_append_only on projects.client_communication_events;', None),
    ('ledger CHECK dropped: a sent entry needs its person (table layer)', 'sql', 'alter table projects.client_communication_ledger drop constraint ledger_sent_is_a_persons;', None),
    ('ledger CHECK dropped: a draft is never a person\'s (table layer)', 'sql', 'alter table projects.client_communication_ledger drop constraint ledger_draft_is_an_agents;', None),
    ('ledger CHECK dropped: a draft names no price (table layer)', 'sql', 'alter table projects.client_communication_ledger drop constraint ledger_draft_names_no_price;', None),
    ('ledger unique index dropped: one provider reference, one entry (table layer)', 'sql', 'drop index projects.client_communication_ledger_one_external;', None),
    ('record: duplicate lookup removed (door layer)', 'fn', REC, [("if v_id is not null then return query select 'duplicate'::text, v_id; return; end if;", '')]),
    ('record: person check removed', 'fn', REC, [(WRITE_GUARD2, '')]),
    ('record: future-dated send refusal removed', 'fn', REC, [("if v_when > clock_timestamp() + interval '5 minutes' then return query select 'in_the_future'::text, null::uuid; return; end if;", '')]),
    ('record: the eligibility the read gave is not stored', 'fn', REC, [("coalesce(v_ok, false), coalesce(v_why, '{}')", "true, '{}'")]),
    ('record: client tenancy filter removed', 'fn', REC, [(CLIENT_NOT_FOUND, '')]),
    ('record: summary requirement removed (door layer)', 'fn', REC, [("if v_sum is null or length(v_sum) < 5 then return query select 'summary_required'::text, null::uuid; return; end if;", '')]),
    ('record: channel refusal removed (door layer)', 'fn', REC, [("if p_channel is null or p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select 'bad_channel'::text, null::uuid; return; end if;", '')]),
    ('agent draft: in-function service-role check removed', 'fn', DRAFT, [(SERVICE_GUARD2, '')]),
    ('agent draft: price refusal removed (door layer)', 'fn', DRAFT, [("then return query select 'names_a_price'::text, null::uuid; return; end if;", "then null; end if;")]),
    ('agent draft: client tenancy filter removed', 'fn', DRAFT, [("a.id = p_client_account_id and a.organization_id = p_organization_id", "a.id = p_client_account_id")]),
    ('agent draft: the agent is not required', 'fn', DRAFT, [("if v_sum is null or length(v_sum) < 5 or v_agent is null then return query select 'summary_and_agent_required'::text, null::uuid; return; end if;", '')]),
    # ── delivery and reply events ──
    ('event: person check removed', 'fn', EVT, [(WRITE_GUARD, '')]),
    ('event: a draft can be marked delivered', 'fn', EVT, [("if v_l.entry_kind <> 'sent_by_person' then return query select 'not_a_sent_entry'::text; return; end if;", '')]),
    ('event: may precede the send it describes', 'fn', EVT, [("if v_when < v_l.occurred_at then return query select 'before_the_send'::text; return; end if;", '')]),
    ('event: already-recorded refusal removed', 'fn', EVT, [("if v_n = 0 then return query select 'already_recorded'::text; return; end if;", '')]),
    ('event: ledger tenancy filter removed', 'fn', EVT, [("where l.id = p_ledger_id and l.organization_id = v_org;", "where l.id = p_ledger_id;")]),
    ('event unique index dropped', 'sql', 'drop index projects.client_communication_events_once;', None),
    ('history: the message log is not joined', 'fn', HIST, [("coalesce(ev.event, nullif(m.metadata ->> 'delivery', ''), 'unknown')", "coalesce(ev.event, 'unknown')")]),
    ('history: a person\'s event does not take precedence', 'fn', HIST, [("coalesce(ev.event, nullif(m.metadata ->> 'delivery', ''), 'unknown')", "coalesce(nullif(m.metadata ->> 'delivery', ''), ev.event, 'unknown')")]),
    ('history: a draft does not read as not sent', 'fn', HIST, [("case when l.entry_kind = 'drafted_by_agent' then 'not_sent'", "case when false then 'not_sent'")]),
    ('history: no delivery fact reads as delivered', 'fn', HIST, [("'unknown') end,", "'delivered') end,")]),
    # ── eligibility ──
    ('eligibility: in-function internal/service guard removed', 'fn', CCN, [("if coalesce((select auth.role()), '') <> 'service_role' and not coalesce((select core.is_internal()), false) then return; end if;", '')]),
    ('eligibility: unknown client refusal removed', 'fn', CCN, [("if v_org is null then return query select false, array['the client is not known']; return; end if;", '')]),
    ('eligibility: unknown channel refusal removed', 'fn', CCN, [("if p_channel is null or p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select false, array['the channel is not one AgencyOS knows']; return; end if;", '')]),
    ('eligibility: unknown purpose refusal removed', 'fn', CCN, [("if p_purpose is null or p_purpose not in ('operational', 'relationship', 'commercial') then return query select false, array['the purpose is not operational, relationship or commercial']; return; end if;", '')]),
    ('eligibility: an archived client may be contacted', 'fn', CCN, [("if v_status <> 'active' then", "if false then")]),
    ('eligibility: no recorded consent is not noticed (client level)', 'fn', CCN, [("if v_granted = 0 then", "if false then")]),
    ('eligibility: a withdrawal is not noticed (client level)', 'fn', CCN, [("if v_withdrawn > 0 then", "if false then")]),
    ('eligibility: no recorded consent is not noticed (contact level)', 'fn', CCN, [("if v_cs is null then v_r := array_append(v_r, 'no WhatsApp consent is recorded for that contact');", "if false then null;")]),
    ('eligibility: a withdrawal is not noticed (contact level)', 'fn', CCN, [("elsif v_cs = 'withdrawn' then", "elsif false then")]),
    ('eligibility: another client\'s contact accepted', 'fn', CCN, [("if not exists (select 1 from crm.contacts ct where ct.id = p_contact_id and ct.client_account_id = p_client_account_id and ct.organization_id = v_org) then", "if false then")]),
    ('eligibility: email and portal need no consent', 'fn', CCN, [("elsif p_channel in ('email', 'portal') then", "elsif false then")]),
    ('eligibility: quiet periods ignored', 'fn', CCN, [("qp.cancelled_at is null and qp.starts_at <= p_now and p_now < qp.ends_at", "false")]),
    ('eligibility: a cancelled quiet period still blocks', 'fn', CCN, [("qp.cancelled_at is null and", "")]),
    ('eligibility: a quiet period never ends', 'fn', CCN, [("p_now < qp.ends_at", "true")]),
    ('eligibility: a quiet period applies before it starts', 'fn', CCN, [("qp.starts_at <= p_now", "true")]),
    ('eligibility: the cap is never reached', 'fn', CCN, [("if v_n >= c.max_contacts then", "if false then")]),
    ('eligibility: an agent draft counts as a contact', 'fn', CCN, [("l.entry_kind = 'sent_by_person'", "true")]),
    ('eligibility: a channel cap counts every channel', 'fn', CCN, [("(c.channel is null or l.channel = c.channel)", "true")]),
    ('eligibility: the cap window is ignored', 'fn', CCN, [("l.occurred_at > p_now - make_interval(days => c.window_days) and l.occurred_at <= p_now", "l.occurred_at <= p_now")]),
    ('eligibility: a cleared cap still applies', 'fn', CCN, [("cp.active and", "")]),
    ('eligibility: the 8A category rules are not applied', 'fn', CCN, [("x.category = p_purpose and not x.allowed", "false")]),
    # ── value reports ──
    ('facts: in-function internal/service guard removed', 'fn', FACTS, [("if coalesce((select auth.role()), '') <> 'service_role' and not coalesce((select core.is_internal()), false) then return; end if;", '')]),
    ('facts: period bound removed', 'fn', FACTS, [("if p_start is null or p_end is null or p_end < p_start or p_end - p_start > 400 then return; end if;", '')]),
    ('facts: ticket client filter removed', 'fn', FACTS, [("t.client_account_id = p_client_account_id and t.status = 'closed'", "t.status = 'closed'")]),
    ('facts: ticket period removed', 'fn', FACTS, [("and t.closed_at >= v_from and t.closed_at < v_to", "")]),
    ('facts: a ticket that is not closed counts', 'fn', FACTS, [("t.status = 'closed' and t.closed_at", "t.closed_at")]),
    ('facts: release client filter removed', 'fn', FACTS, [("w.client_account_id = p_client_account_id and w.status = 'released'", "w.status = 'released'")]),
    ('facts: release period removed', 'fn', FACTS, [("and w.released_at >= v_from and w.released_at < v_to", "")]),
    ('facts: hours client filter removed', 'fn', FACTS, [("p.client_account_id = p_client_account_id and l.logged_on between p_start and p_end", "l.logged_on between p_start and p_end")]),
    ('facts: hours period removed', 'fn', FACTS, [("p.client_account_id = p_client_account_id and l.logged_on between p_start and p_end", "p.client_account_id = p_client_account_id")]),
    ('facts: hours do not cite their log rows', 'fn', FACTS, [("'sources', jsonb_agg(jsonb_build_object('table', 'projects.time_logs', 'id', l.id) order by l.logged_on, l.id))", "'sources', jsonb_build_array(jsonb_build_object('table', 'projects.time_logs', 'id', (array_agg(l.id))[1])))")]),
    ('facts: verification client filter removed', 'fn', FACTS, [("p.client_account_id = p_client_account_id and v.environment = 'production'", "v.environment = 'production'")]),
    ('facts: a staging check counts as production', 'fn', FACTS, [("and v.environment = 'production'", "")]),
    ('facts: verification period removed', 'fn', FACTS, [("and v.verified_at >= v_from and v.verified_at < v_to", "")]),
    ('store (inner): stale-digest refusal removed', 'fn', STORE, [("if p_facts_digest is null or p_facts_digest <> v_digest then return query select 'facts_changed'::text, null::uuid; return; end if;", '')]),
    ('store (inner): template version refusal removed (door layer)', 'fn', STORE, [("if p_template_version is null or p_template_version < 1 then return query select 'bad_template_version'::text, null::uuid; return; end if;", '')]),
    ('store (inner): price refusal removed (door layer)', 'fn', STORE, [("then return query select 'names_a_price'::text, null::uuid; return; end if;", "then null; end if;")]),
    ('store (inner): body requirement removed (door layer)', 'fn', STORE, [("if v_body is null or length(v_body) < 20 then return query select 'body_required'::text, null::uuid; return; end if;", '')]),
    ('store (inner): client tenancy filter removed', 'fn', STORE, [("a.id = p_client_account_id and a.organization_id = p_org", "a.id = p_client_account_id")]),
    ('store (inner): empty period reported on (door layer)', 'fn', STORE, [("if v_facts is null or jsonb_array_length(v_facts) = 0 then return query select 'nothing_to_report'::text, null::uuid; return; end if;", '')]),
    ('store: person check removed', 'fn', STORE_P, [(WRITE_GUARD2, '')]),
    ('store as agent: in-function service-role check removed', 'fn', STORE_A, [(SERVICE_GUARD2, '')]),
    ('store as agent: the agent is not required', 'fn', STORE_A, [("if nullif(btrim(coalesce(p_agent, '')), '') is null then return query select 'agent_required'::text, null::uuid; return; end if;", '')]),
    ('edit: person check removed', 'fn', EDIT, [(WRITE_GUARD, '')]),
    ('edit: organization filter removed', 'fn', EDIT, [("d.id = p_report_id and d.organization_id = v_org for update", "d.id = p_report_id for update")]),
    ('edit: draft-only refusal removed (door layer)', 'fn', EDIT, [("if v_r.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;", '')]),
    ('edit: price refusal removed (door layer)', 'fn', EDIT, [("then return query select 'names_a_price'::text; return; end if;", "then null; end if;")]),
    ('approve: person check removed', 'fn', APPROVE, [(WRITE_GUARD, '')]),
    ('approve: organization filter removed', 'fn', APPROVE, [("d.id = p_report_id and d.organization_id = v_org for update", "d.id = p_report_id for update")]),
    ('approve: draft-only refusal removed (door layer)', 'fn', APPROVE, [("if v_r.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;", '')]),
    ('discard: reason requirement removed', 'fn', DISCARD, [("if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text; return; end if;", '')]),
    ('discard: draft-only refusal removed (door layer)', 'fn', DISCARD, [("if v_r.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;", '')]),
    ('report frozen trigger dropped (facts, template and final state)', 'sql', 'drop trigger value_report_drafts_frozen on projects.value_report_drafts;', None),
    ('report guard trigger dropped (a direct write)', 'sql', 'drop trigger value_report_drafts_p8_guard on projects.value_report_drafts;', None),
    ('report CHECK dropped: every fact cites a source (table layer)', 'sql', 'alter table projects.value_report_drafts drop constraint value_report_facts_are_cited;', None),
    ('report CHECK dropped: one author (table layer)', 'sql', 'alter table projects.value_report_drafts drop constraint value_report_has_one_author;', None),
    ('report CHECK dropped: no price in the body (table layer)', 'sql', 'alter table projects.value_report_drafts drop constraint value_report_body_names_no_price;', None),
    # ── observability ──
    ('observability: closed tickets counted as open in the SLA buckets', 'fn', OBS, [("where t.organization_id = v_org and t.status not in ('closed', 'cancelled') group by s.resolution_state;", "where t.organization_id = v_org group by s.resolution_state;")]),
    ('observability: health distribution not derived (every account healthy)', 'fn', OBS, [("select 'health_distribution'::text, h.status,", "select 'health_distribution'::text, 'healthy'::text,")]),
    ('observability: tickets by state lose their grouping', 'fn', OBS, [("select 'tickets_by_state'::text, t.status, count(*)::int, min(t.raised_at)", "select 'tickets_by_state'::text, 'all'::text, count(*)::int, min(t.raised_at)")]),
    # ── tenancy, access, grants ──
    ('ledger tenancy trigger dropped (client)', 'sql', 'drop trigger org_match_client_communication_ledger_client_account_id on projects.client_communication_ledger;', None),
    ('ledger tenancy trigger dropped (project)', 'sql', 'drop trigger org_match_client_communication_ledger_project_id on projects.client_communication_ledger;', None),
    ('ledger tenancy trigger dropped (contact)', 'sql', 'drop trigger org_match_client_communication_ledger_contact_id on projects.client_communication_ledger;', None),
    ('ledger tenancy trigger dropped (message)', 'sql', 'drop trigger org_match_client_communication_ledger_message_id on projects.client_communication_ledger;', None),
    ('events tenancy trigger dropped (ledger entry)', 'sql', 'drop trigger org_match_client_communication_events_ledger_id on projects.client_communication_events;', None),
    ('report tenancy trigger dropped (client)', 'sql', 'drop trigger org_match_value_report_drafts_client_account_id on projects.value_report_drafts;', None),
    ('quiet-period organization freeze dropped', 'sql', 'drop trigger freeze_org_client_quiet_periods on projects.client_quiet_periods;', None),
    ('ledger read policy loses is_internal (a client reads the ledger)', 'sql', open_policy('client_communication_ledger'), None),
    ('events read policy loses is_internal', 'sql', open_policy('client_communication_events'), None),
    ('caps read policy loses is_internal', 'sql', open_policy('client_communication_caps'), None),
    ('quiet-period read policy loses is_internal', 'sql', open_policy('client_quiet_periods'), None),
    ('report read policy loses is_internal', 'sql', open_policy('value_report_drafts'), None),
    ('a signed-in person is granted insert on the ledger', 'sql', 'grant insert on projects.client_communication_ledger to authenticated;', None),
    ('a signed-in person is granted update on the report drafts', 'sql', 'grant update on projects.value_report_drafts to authenticated;', None),
    ('the agent draft door is granted to signed-in people', 'sql', 'grant execute on function projects.record_agent_communication_draft(uuid,uuid,text,text,text,text,uuid,uuid) to authenticated;', None),
    ('the service role is granted a person-only door', 'sql', 'grant execute on function projects.approve_value_report_draft(uuid) to service_role;', None),
    ('the inner store function is granted to signed-in people', 'sql', 'grant execute on function projects.p8d_store_value_report(uuid,uuid,text,uuid,date,date,integer,text,text) to authenticated;', None),
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
        f = Path('/tmp') / 'redproof-phase-eight-d.sql'
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
