#!/usr/bin/env python3
"""
Red-proof harness for scripts/verify-phase-eight-a-gaps-1.sql.

A verifier that has never failed proves nothing. Each case removes ONE control from the LIVE definition (a function body is fetched with pg_get_functiondef and
mutated; a constraint, index, trigger, policy or grant is dropped) INSIDE the verifier's own transaction, so nothing persists: the verifier rolls back at its end and
a failing run rolls back at the error.

  KEEP=1 scripts/apply-migrations-locally.sh               # leaves a scratch Postgres running
  PGHOST=<socket dir> PGPORT=<port> python3 scripts/redproof/phase-eight-a-gaps-1.py
  python3 scripts/redproof/phase-eight-a-gaps-1.py --list  # counts only; needs no database

GREEN = the verifier did not notice the control's removal (the case must be fixed). NOOP = the pattern was not found (a mutation that changes nothing proves nothing).
Where a rule is held by two layers (a door and a CHECK or index) there is a case for each layer, and the verifier has a check that reaches each one.
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / 'scripts' / 'verify-phase-eight-a-gaps-1.sql'

P = 'projects.'
T = 'timestamp with time zone'

S = {
    'guard': P + 'guard_phase_eight_project(uuid,text)',
    'corr': P + 'p8g_correlation()',
    'retention': P + 'phase_eight_retention_status()',
    'rec_fb': P + 'record_client_feedback(uuid,text,text,text,integer,text,uuid,date)',
    'sub_fb': P + 'submit_client_feedback(text,text,integer,text,uuid)',
    'ack_fb': P + 'acknowledge_client_feedback(uuid,text)',
    'fb_client': P + 'client_feedback_for_client()',
    'set_des': P + 'set_client_designation(uuid,text,text,text)',
    'end_des': P + 'end_client_designation(uuid,text,text)',
    'upsert_pref': P + 'p8g_upsert_preferences(uuid,uuid,uuid,text,text,text[],uuid,text,text)',
    'set_pref': P + 'set_client_contact_preferences(uuid,text,text,text[],uuid,text)',
    'set_my_pref': P + 'set_my_contact_preferences(text,text,text[],text)',
    'my_pref': P + 'my_contact_preferences()',
    'set_cad': P + 'set_communication_cadence_rule(text,text,integer)',
    'clr_cad': P + 'clear_communication_cadence_rule(text,text)',
    'ccn': P + 'can_contact_now_with_preferences(uuid,text,text,uuid,' + T + ')',
    'prop_art': P + 'p8g_propose_article(uuid,uuid,text,text,text,text,boolean)',
    'prop_art_p': P + 'propose_knowledge_article(text,text,text,boolean)',
    'prop_art_a': P + 'propose_knowledge_article_as_agent(uuid,text,text,text,text,boolean)',
    'appr_art': P + 'approve_knowledge_article(uuid)',
    'ret_art': P + 'retire_knowledge_article(uuid,text)',
    'cite': P + 'p8g_cite(uuid,uuid,text,uuid,uuid)',
    'cite_p': P + 'cite_knowledge_for_ticket(uuid,uuid)',
    'cite_a': P + 'cite_knowledge_for_ticket_as_agent(uuid,text,uuid,uuid)',
    'kb_client': P + 'client_knowledge_articles()',
    'scope': P + 'p8g_scope_reference(uuid,uuid,text,uuid,text,uuid,text)',
    'scope_p': P + 'record_ticket_scope_reference(uuid,text,uuid,text)',
    'scope_a': P + 'propose_ticket_scope_reference_as_agent(uuid,text,uuid,text,uuid,text)',
    'scope_c': P + 'confirm_ticket_scope_reference(uuid)',
    'ho': P + 'p8g_handoff_request(uuid,uuid,text,uuid,text,text)',
    'ho_p': P + 'request_ticket_handoff(uuid,text,text)',
    'ho_a': P + 'request_ticket_handoff_as_agent(uuid,text,uuid,text,text)',
    'ho_s': P + 'settle_ticket_handoff(uuid,text,text)',
    'next': P + 'cs_next_actions(' + T + ')',
    'brief': P + 'record_discovery_brief_draft(uuid,uuid,text,text,jsonb,jsonb)',
    'brief_r': P + 'review_discovery_brief(uuid,text)',
}

ADMIN = "if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;"
WRITE1 = "if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;"
WRITE2 = "if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;"
WRITE3 = "if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid, null::int; return; end if;"
ADMIN_DROP = lambda tbl: ''


def open_policy(table):
    return ("drop policy %s_read on projects.%s; create policy %s_read on projects.%s for select to authenticated using (organization_id = (select core.current_organization_id()));"
            % (table, table, table, table))


def drop_trigger(name, table):
    return 'drop trigger %s on projects.%s;' % (name, table)


def drop_check(table, name):
    return 'alter table projects.%s drop constraint %s;' % (table, name)


# (name, kind, target, edits)  kind 'sql' -> target is SQL; kind 'fn' -> target is a regprocedure and edits is [(find, replace), ...]
CASES = [
    # ── correlation id ──
    ('correlation: the id is not shared inside one request', 'fn', S['corr'], [("if v is null then", "if true then")]),
    ('correlation: stamping trigger dropped', 'sql', drop_trigger('support_ticket_events_correlation', 'support_ticket_events'), None),
    # ── denials ──
    ('guard: the organization filter removed (a foreign project is allowed)', 'fn', S['guard'], [("where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null", "where p.id = p_project_id and p.deleted_at is null")]),
    ('guard: the denial is never written', 'fn', S['guard'], [("  if not exists (select 1 from projects.phase_eight_access_denials d", "  if false and not exists (select 1 from projects.phase_eight_access_denials d")]),
    ('guard: the one-minute duplicate suppression removed', 'fn', S['guard'], [("and d.created_at > clock_timestamp() - interval '1 minute')", "and false)")]),
    ('guard: a client may read any project of the organization', 'fn', S['guard'], [("(select pp.id from projects.p7b_portal_project(p_project_id) pp) is not null", "true")]),
    ('guard: an unknown surface is stored as given (CHECK refuses)', 'fn', S['guard'], [("then v_surface := 'other'; end if;", "then null; end if;")]),
    ('guard: the service role is granted the door', 'sql', 'grant execute on function projects.guard_phase_eight_project(uuid,text) to service_role;', None),
    ('denials append-only trigger dropped', 'sql', drop_trigger('phase_eight_access_denials_append_only', 'phase_eight_access_denials'), None),
    ('denials read policy loses the Admin requirement', 'sql', open_policy('phase_eight_access_denials').replace('current_organization_id())', 'current_organization_id()) and (select core.is_internal())'), None),
    ('denials: a signed-in person is granted insert', 'sql', 'grant insert on projects.phase_eight_access_denials to authenticated;', None),
    # ── retention status ──
    ('retention: tickets are mapped to no class', 'fn', S['retention'], [("select 'support_tickets'::text, 'support_warranty_records'::text,", "select 'support_tickets'::text, null::text,")]),
    ('retention: the ledger is claimed by a class', 'fn', S['retention'], [("select 'client_communication_ledger', null::text,", "select 'client_communication_ledger', 'support_warranty_records',")]),
    ('retention: rows held is not the real count', 'fn', S['retention'], [("(select count(*) from projects.support_tickets x where x.organization_id = v_org)", "(select 0::bigint)")]),
    # ── feedback ──
    ('feedback record: person check removed', 'fn', S['rec_fb'], [(WRITE2, '')]),
    ('feedback record: a goal with a score (door layer)', 'fn', S['rec_fb'], [("if p_kind = 'goal' and (p_sentiment is not null or p_rating is not null) then return query select 'a_goal_has_no_score'::text, null::uuid; return; end if;", '')]),
    ('feedback record: the portal as a source (door layer)', 'fn', S['rec_fb'], [("if p_source is null or p_source not in ('call', 'meeting', 'email', 'whatsapp', 'survey', 'other') then return query select 'bad_source'::text, null::uuid; return; end if;", '')]),
    ('feedback record: sentiment requirement (door layer)', 'fn', S['rec_fb'], [("if p_kind = 'feedback' and (p_sentiment is null or p_sentiment not in ('positive', 'neutral', 'negative', 'mixed')) then return query select 'sentiment_required'::text, null::uuid; return; end if;", '')]),
    ('feedback record: rating range (door layer)', 'fn', S['rec_fb'], [("if p_rating is not null and (p_rating < 1 or p_rating > 5) then return query select 'rating_out_of_range'::text, null::uuid; return; end if;", '')]),
    ('feedback record: project of another client allowed', 'fn', S['rec_fb'], [("and p.organization_id = v_org and p.client_account_id = p_client_account_id) then return query select 'project_not_the_clients'::text", "and p.organization_id = v_org) then return query select 'project_not_the_clients'::text")]),
    ('feedback record: future date allowed', 'fn', S['rec_fb'], [("if coalesce(p_occurred_on, current_date) > current_date then return query select 'in_the_future'::text, null::uuid; return; end if;", '')]),
    ('feedback submit: client check removed', 'fn', S['sub_fb'], [("if not coalesce((select core.is_client()), false) or v_account is null then return query select 'not_a_client'::text, null::uuid; return; end if;", '')]),
    ('feedback submit: another client''s project allowed', 'fn', S['sub_fb'], [("if v_p.id is null or v_p.client_account_id is distinct from v_account then return query select 'not_found'::text, null::uuid; return; end if;", '')]),
    ('feedback submit: a goal with a score (door layer)', 'fn', S['sub_fb'], [("if p_kind = 'goal' and (p_sentiment is not null or p_rating is not null) then return query select 'a_goal_has_no_score'::text, null::uuid; return; end if;", '')]),
    ('feedback read: staff-entered rows shown to the client', 'fn', S['fb_client'], [("and f.entered_by = 'client'", "")]),
    ('feedback read: another client''s rows shown', 'fn', S['fb_client'], [("where f.client_account_id = v_account and", "where")]),
    ('feedback acknowledge: note requirement removed', 'fn', S['ack_fb'], [("if v_note is null or length(v_note) < 5 or length(v_note) > 1000 then return query select 'note_required'::text; return; end if;", '')]),
    ('feedback acknowledge: person check removed', 'fn', S['ack_fb'], [(WRITE1, '')]),
    ('feedback acknowledge: organization filter removed', 'fn', S['ack_fb'], [("f.id = p_feedback_id and f.organization_id = v_org", "f.id = p_feedback_id")]),
    ('feedback append-only trigger dropped', 'sql', drop_trigger('client_feedback_append_only', 'client_feedback'), None),
    ('acknowledgement append-only trigger dropped', 'sql', drop_trigger('client_feedback_acknowledgements_append_only', 'client_feedback_acknowledgements'), None),
    ('feedback CHECK dropped: a goal has no score (table layer)', 'sql', drop_check('client_feedback', 'client_feedback_goal_has_no_score'), None),
    ('feedback CHECK dropped: the portal is the client''s (table layer)', 'sql', drop_check('client_feedback', 'client_feedback_portal_is_the_clients'), None),
    ('feedback CHECK dropped: feedback has a sentiment (table layer)', 'sql', drop_check('client_feedback', 'client_feedback_feedback_has_a_sentiment'), None),
    ('feedback read policy loses is_internal (a client reads it)', 'sql', open_policy('client_feedback'), None),
    ('feedback: a signed-in person is granted insert', 'sql', 'grant insert on projects.client_feedback to authenticated;', None),
    ('feedback: the service role is granted the staff door', 'sql', 'grant execute on function projects.record_client_feedback(uuid,text,text,text,integer,text,uuid,date) to service_role;', None),
    # ── designation ──
    ('designation set: Admin check removed', 'fn', S['set_des'], [(ADMIN, '')]),
    ('designation set: rule requirement removed', 'fn', S['set_des'], [("if v_crit is null or length(v_crit) < 10 or length(v_crit) > 1000 then return query select 'criteria_required'::text; return; end if;", '')]),
    ('designation set: reason requirement removed', 'fn', S['set_des'], [("if v_reason is null or length(v_reason) < 10 or length(v_reason) > 1000 then return query select 'reason_required'::text; return; end if;", '')]),
    ('designation set: client tenancy filter removed', 'fn', S['set_des'], [("a.id = p_client_account_id and a.organization_id = v_org", "a.id = p_client_account_id")]),
    ('designation set: already-designated refusal removed (door layer)', 'fn', S['set_des'], [("then return query select 'already_designated'::text; return; end if;", "then null; end if;")]),
    ('designation end: Admin check removed', 'fn', S['end_des'], [(ADMIN, '')]),
    ('designation end: reason requirement removed', 'fn', S['end_des'], [("if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text; return; end if;", '')]),
    ('designation guard trigger dropped', 'sql', drop_trigger('client_strategic_designations_p8_guard', 'client_strategic_designations'), None),
    ('designation CHECK dropped: an ended one says why (table layer)', 'sql', drop_check('client_strategic_designations', 'client_designation_ended_says_why'), None),
    ('designation unique index dropped (one live per kind)', 'sql', 'drop index projects.client_strategic_designations_one_live;', None),
    ('designation read policy loses is_internal', 'sql', open_policy('client_strategic_designations'), None),
    ('designation: an agent (the service role) is granted the door', 'sql', 'grant execute on function projects.set_client_designation(uuid,text,text,text) to service_role;', None),
    # ── preferences ──
    ('preferences: prefer and avoid the same channel (door layer)', 'fn', S['upsert_pref'], [("if p_channel is not null and p_channel = any (v_avoid) then return 'prefers_and_avoids_the_same_channel'; end if;", '')]),
    ('preferences: language code (door layer)', 'fn', S['upsert_pref'], [("if v_lang is not null and v_lang !~ '^[a-z]{2,8}(-[A-Za-z0-9]{2,8})?$' then return 'bad_language'; end if;", '')]),
    ('preferences: avoided channel list (door layer)', 'fn', S['upsert_pref'], [("if not (v_avoid <@ array['whatsapp', 'email', 'portal', 'call', 'meeting']::text[]) then return 'bad_avoid_channel'; end if;", '')]),
    ('preferences: contact of another client allowed', 'fn', S['upsert_pref'], [("and c.client_account_id = p_account and c.organization_id = p_org) then return 'contact_not_the_clients'; end if;", "and c.organization_id = p_org) then return 'contact_not_the_clients'; end if;")]),
    ('preferences set: person check removed', 'fn', S['set_pref'], [(WRITE1, '')]),
    ('preferences set: client tenancy filter removed', 'fn', S['set_pref'], [("a.id = p_client_account_id and a.organization_id = v_org", "a.id = p_client_account_id")]),
    ('preferences (client): client check removed', 'fn', S['set_my_pref'], [("if not coalesce((select core.is_client()), false) or v_account is null then return query select 'not_a_client'::text; return; end if;", '')]),
    ('preferences (client): reads another client''s row', 'fn', S['my_pref'], [("from projects.client_contact_preferences p where p.client_account_id = v_account", "from projects.client_contact_preferences p")]),
    ('preferences guard trigger dropped', 'sql', drop_trigger('client_contact_preferences_p8_guard', 'client_contact_preferences'), None),
    ('preferences CHECK dropped: prefer and avoid (table layer)', 'sql', drop_check('client_contact_preferences', 'client_contact_preferences_consistent'), None),
    # ── cadence and the eligibility read ──
    ('cadence set: Admin check removed', 'fn', S['set_cad'], [(ADMIN, '')]),
    ('cadence set: range refusal removed (door layer)', 'fn', S['set_cad'], [("if p_min_gap_days is null or p_min_gap_days < 1 or p_min_gap_days > 365 then return query select 'out_of_range'::text; return; end if;", '')]),
    ('cadence set: purpose refusal removed (door layer)', 'fn', S['set_cad'], [("if p_purpose is null or p_purpose not in ('operational', 'relationship', 'commercial') then return query select 'bad_purpose'::text; return; end if;", '')]),
    ('cadence set: channel refusal removed (door layer)', 'fn', S['set_cad'], [("if p_channel is not null and p_channel not in ('whatsapp', 'email', 'portal', 'call', 'meeting') then return query select 'bad_channel'::text; return; end if;", '')]),
    ('cadence clear: Admin check removed', 'fn', S['clr_cad'], [(ADMIN, '')]),
    ('cadence clear: only an ACTIVE rule can be cleared', 'fn', S['clr_cad'], [("and r.active for update", "for update")]),
    ('cadence guard trigger dropped', 'sql', drop_trigger('communication_cadence_rules_p8_guard', 'communication_cadence_rules'), None),
    ('eligibility: the cadence gap never holds', 'fn', S['ccn'], [("if v_last is not null and v_last > p_now - make_interval(days => c.min_gap_days) then", "if false then")]),
    ('eligibility: an agent draft counts as a contact', 'fn', S['ccn'], [("l.entry_kind = 'sent_by_person' and l.purpose = p_purpose", "l.purpose = p_purpose")]),
    ('eligibility: a rule of another purpose applies', 'fn', S['ccn'], [("and cr.purpose = p_purpose and (cr.channel is null or cr.channel = p_channel)", "and (cr.channel is null or cr.channel = p_channel)")]),
    ('eligibility: an avoided channel is not a reason', 'fn', S['ccn'], [("if p_channel = any (pref.avoid_channels) then v_r := array_append(v_r, 'the client asked not to be contacted by ' || p_channel); end if;", '')]),
    ('eligibility: the language advisory removed', 'fn', S['ccn'], [("if pref.language is not null then v_a := array_append(v_a, 'write in ' || pref.language); end if;", '')]),
    ('eligibility: the channel advisory removed', 'fn', S['ccn'], [("if pref.preferred_channel is not null and pref.preferred_channel <> p_channel then v_a := array_append(v_a, 'the client prefers ' || pref.preferred_channel); end if;", '')]),
    # ── knowledge base ──
    ('knowledge propose (inner): price refusal removed (door layer)', 'fn', S['prop_art'], [("then return query select 'names_a_price'::text, null::uuid, null::int; return; end if;", "then null; end if;")]),
    ('knowledge propose (inner): key refusal removed (door layer)', 'fn', S['prop_art'], [("if v_key is null or v_key !~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$' then return query select 'bad_key'::text, null::uuid, null::int; return; end if;", '')]),
    ('knowledge propose (inner): the one-draft refusal removed (door layer)', 'fn', S['prop_art'], [("if v_id is not null then return query select 'draft_exists'::text, v_id, null::int; return; end if;", '')]),
    ('knowledge propose: person check removed', 'fn', S['prop_art_p'], [(WRITE3, '')]),
    ('knowledge propose (agent): service check removed', 'fn', S['prop_art_a'], [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid, null::int; return; end if;", '')]),
    ('knowledge propose (agent): any agent may propose', 'fn', S['prop_art_a'], [("if p_agent_key is distinct from 'support' then return query select 'not_the_support_agent'::text, null::uuid, null::int; return; end if;", '')]),
    ('knowledge cite (agent): service check removed', 'fn', S['cite_a'], [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text; return; end if;", '')]),
    ('scope (agent): service check removed', 'fn', S['scope_a'], [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid; return; end if;", '')]),
    ('handoff (agent): service check removed', 'fn', S['ho_a'], [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid; return; end if;", '')]),
    ('knowledge approve: Admin check removed', 'fn', S['appr_art'], [(ADMIN, '')]),
    ('knowledge approve: the author may approve (door layer)', 'fn', S['appr_art'], [("if v_a.proposed_by is not distinct from v_actor then return query select 'author_cannot_approve'::text; return; end if;", '')]),
    ('knowledge approve: only a draft (door layer)', 'fn', S['appr_art'], [("if v_a.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;", '')]),
    ('knowledge approve: the old version is not retired', 'fn', S['appr_art'], [("where organization_id = v_org and article_key = v_a.article_key and status = 'approved';", "where false;")]),
    ('knowledge approve: organization filter removed', 'fn', S['appr_art'], [("a.id = p_article_id and a.organization_id = v_org for update", "a.id = p_article_id for update")]),
    ('knowledge retire: reason requirement removed', 'fn', S['ret_art'], [("if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text; return; end if;", '')]),
    ('knowledge retire: already-retired refusal removed', 'fn', S['ret_art'], [("if v_a.status = 'retired' then return query select 'already_retired'::text; return; end if;", '')]),
    ('knowledge frozen trigger dropped (an approved body is edited)', 'sql', drop_trigger('support_knowledge_articles_frozen', 'support_knowledge_articles'), None),
    ('knowledge guard trigger dropped', 'sql', drop_trigger('support_knowledge_articles_p8_guard', 'support_knowledge_articles'), None),
    ('knowledge CHECK dropped: approval is independent (table layer)', 'sql', drop_check('support_knowledge_articles', 'knowledge_approved_by_an_independent_person'), None),
    ('knowledge unique index dropped: one approved version (table layer)', 'sql', 'drop index projects.knowledge_one_approved_per_key;', None),
    ('knowledge: a signed-in person is granted the agent door', 'sql', 'grant execute on function projects.propose_knowledge_article_as_agent(uuid,text,text,text,text,boolean) to authenticated;', None),
    ('knowledge cite: an unapproved article may be cited', 'fn', S['cite'], [("if v_a.status <> 'approved' then return 'article_not_approved'; end if;", '')]),
    ('knowledge cite: ticket organization filter removed', 'fn', S['cite'], [("where t.id = p_ticket and t.organization_id = p_org)", "where t.id = p_ticket)")]),
    ('knowledge cite: duplicate refusal removed', 'fn', S['cite'], [("if v_n = 0 then return 'already_cited'; end if;", '')]),
    ('knowledge cite (person): person check removed', 'fn', S['cite_p'], [(WRITE1, '')]),
    ('knowledge cite (agent): any agent may cite', 'fn', S['cite_a'], [("if p_agent_key is distinct from 'support' then return query select 'not_the_support_agent'::text; return; end if;", '')]),
    ('citation append-only trigger dropped', 'sql', drop_trigger('ticket_knowledge_citations_append_only', 'ticket_knowledge_citations'), None),
    ('client knowledge: an internal article shown', 'fn', S['kb_client'], [("and k.client_safe order by", "order by")]),
    ('client knowledge: a retired version shown', 'fn', S['kb_client'], [("k.status = 'approved' and k.client_safe", "k.client_safe")]),
    # ── scope references ──
    ('scope: an included item can be called excluded', 'fn', S['scope'], [("if p_relation = 'excluded' and v_inc <> 'excluded' then return query select 'item_is_not_excluded'::text, null::uuid; return; end if;", '')]),
    ('scope: an excluded item can be called included', 'fn', S['scope'], [("if p_relation = 'inside_scope' and v_inc <> 'included' then return query select 'item_is_not_included'::text, null::uuid; return; end if;", '')]),
    ('scope: an item of another scope version accepted', 'fn', S['scope'], [("where si.id = p_item and si.scope_version_id = v_sv and si.organization_id = p_org", "where si.id = p_item and si.organization_id = p_org")]),
    ('scope: outside_scope may name an item (door layer)', 'fn', S['scope'], [("if p_relation = 'outside_scope' and p_item is not null then return query select 'outside_scope_names_no_item'::text, null::uuid; return; end if;", '')]),
    ('scope: inside_scope without an item (door layer)', 'fn', S['scope'], [("if p_relation in ('inside_scope', 'excluded') and p_item is null then return query select 'scope_item_required'::text, null::uuid; return; end if;", '')]),
    ('scope: no approved scope version refusal removed', 'fn', S['scope'], [("if v_sv is null then return query select 'no_approved_scope_version'::text, null::uuid; return; end if;", '')]),
    ('scope: ticket organization filter removed', 'fn', S['scope'], [("t.id = p_ticket and t.organization_id = p_org;", "t.id = p_ticket;")]),
    ('scope: duplicate lookup removed (door layer)', 'fn', S['scope'], [("if v_id is not null then return query select 'already_recorded'::text, v_id; return; end if;", '')]),
    ('scope (person): person check removed', 'fn', S['scope_p'], [(WRITE2, '')]),
    ('scope (agent): any agent may propose', 'fn', S['scope_a'], [("if p_agent_key is distinct from 'support' then return query select 'not_the_support_agent'::text, null::uuid; return; end if;", '')]),
    ('scope confirm: person check removed', 'fn', S['scope_c'], [(WRITE1, '')]),
    ('scope confirm: already-confirmed refusal removed', 'fn', S['scope_c'], [("if v_r.status = 'confirmed' then return query select 'already_confirmed'::text; return; end if;", '')]),
    ('scope CHECK dropped: confirmed is a person (table layer)', 'sql', drop_check('ticket_scope_references', 'scope_ref_confirmed_is_a_person'), None),
    ('scope CHECK dropped: inside scope names its item (table layer)', 'sql', drop_check('ticket_scope_references', 'scope_ref_names_its_item'), None),
    ('scope guard trigger dropped', 'sql', drop_trigger('ticket_scope_references_p8_guard', 'ticket_scope_references'), None),
    ('scope read policy loses is_internal', 'sql', open_policy('ticket_scope_references'), None),
    # ── developer / QA requests ──
    ('handoff: a how-to or unclassified ticket may need a developer', 'fn', S['ho'], [("if v_t.classification is null or v_t.classification not in ('warranty_bug', 'maintenance', 'minor_change') then return query select 'classification_does_not_need_a_developer'::text, null::uuid; return; end if;", '')]),
    ('handoff: QA is asked before there is work to verify', 'fn', S['ho'], [("if v_t.status not in ('in_progress', 'in_qa') then return query select 'nothing_to_verify_yet'::text, null::uuid; return; end if;", '')]),
    ('handoff: an agent may hand work along any edge', 'fn', S['ho'], [("if p_agent is not null and not exists (select 1 from ai.agent_handoff_targets e where e.from_agent = p_agent and e.to_agent = p_target) then return query select 'no_handoff_edge'::text, null::uuid; return; end if;", '')]),
    ('handoff: a finished ticket may be handed off', 'fn', S['ho'], [("if v_t.status in ('closed', 'cancelled') then return query select 'ticket_is_finished'::text, null::uuid; return; end if;", '')]),
    ('handoff: the live-request lookup removed (door layer)', 'fn', S['ho'], [("if v_id is not null then return query select 'already_requested'::text, v_id; return; end if;", '')]),
    ('handoff: ticket organization filter removed', 'fn', S['ho'], [("t.id = p_ticket and t.organization_id = p_org for update", "t.id = p_ticket for update")]),
    ('handoff: the payload takes the priority from nowhere', 'fn', S['ho'], [("'priority', v_t.priority,", "'priority', 'p1',")]),
    ('handoff: target refusal removed (door layer)', 'fn', S['ho'], [("if p_target is null or p_target not in ('developer', 'quality_assurance') then return query select 'bad_target'::text, null::uuid; return; end if;", '')]),
    ('handoff (person): person check removed', 'fn', S['ho_p'], [(WRITE2, '')]),
    ('handoff (agent): any agent may ask', 'fn', S['ho_a'], [("if p_agent_key is null or p_agent_key not in ('support', 'customer_success') then return query select 'not_a_support_or_customer_success_agent'::text, null::uuid; return; end if;", '')]),
    ('handoff settle: person check removed', 'fn', S['ho_s'], [(WRITE1, '')]),
    ('handoff settle: organization filter removed', 'fn', S['ho_s'], [("r.id = p_request_id and r.organization_id = v_org for update", "r.id = p_request_id for update")]),
    ('handoff settle: a settled request can be settled again', 'fn', S['ho_s'], [("if v_r.status in ('completed', 'declined') then return query select 'already_settled'::text; return; end if;", '')]),
    ('handoff settle: a note on completion removed (door layer)', 'fn', S['ho_s'], [("if p_decision in ('completed', 'declined') and (v_note is null or length(v_note) < 5) then return query select 'note_required'::text; return; end if;", '')]),
    ('handoff unique index dropped (one live request)', 'sql', 'drop index projects.support_handoff_requests_one_live;', None),
    ('handoff CHECK dropped: settled is a person''s (table layer)', 'sql', drop_check('support_handoff_requests', 'handoff_request_settled_is_a_persons'), None),
    ('handoff guard trigger dropped', 'sql', drop_trigger('support_handoff_requests_p8_guard', 'support_handoff_requests'), None),
    ('handoff: a signed-in person is granted the agent door', 'sql', 'grant execute on function projects.request_ticket_handoff_as_agent(uuid,text,uuid,text,text) to authenticated;', None),
    # ── the next-action queue ──
    ('next actions: an acknowledged escalation stays', 'fn', S['next'], [("t.escalated_at is not null and t.escalation_ack_at is null and", "t.escalated_at is not null and")]),
    ('next actions: acknowledged feedback stays', 'fn', S['next'], [("and not exists (select 1 from projects.client_feedback_acknowledgements a where a.feedback_id = f.id)", "")]),
    ('next actions: the rank of an escalation is not first', 'fn', S['next'], [("select 'escalation_unacknowledged'::text, 1,", "select 'escalation_unacknowledged'::text, 9,")]),
    ('next actions: the designation is never shown', 'fn', S['next'], [("left join lateral (select dd.designation from projects.client_strategic_designations dd where dd.client_account_id = ca.id and dd.active order by dd.designation limit 1) d on true", "left join lateral (select null::text as designation) d on true")]),
    ('next actions: a confirmed scope reference is a next action', 'fn', S['next'], [("where s.organization_id = v_org and s.status = 'proposed'", "where s.organization_id = v_org")]),
    ('next actions: a breached ticket is not listed', 'fn', S['next'], [("(t.response_breached_at is not null or t.resolution_breached_at is not null) and", "false and")]),
    ('next actions: a due check-in is not listed', 'fn', S['next'], [("c.status = 'due' and c.due_on <= (p_now at time zone 'UTC')::date", "false")]),
    ('next actions: qualified opportunities are not listed', 'fn', S['next'], [("where o.organization_id = v_org and o.status = 'qualified'", "where false")]),
    ('next actions: a client may read the queue', 'fn', S['next'], [("if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;", "if v_org is null then return; end if;")]),
    # ── discovery brief ──
    ('brief: service check removed', 'fn', S['brief'], [("if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid; return; end if;", '')]),
    ('brief: any agent may draft', 'fn', S['brief'], [("if p_agent_key is distinct from 'sales' then return query select 'not_the_sales_agent'::text, null::uuid; return; end if;", '')]),
    ('brief: an unqualified opportunity may be worked (door layer)', 'fn', S['brief'], [("if v_o.status not in ('qualified', 'handed_off') then return query select 'opportunity_not_qualified'::text, null::uuid; return; end if;", '')]),
    ('brief: a foreign record may be cited', 'fn', S['brief'], [("and t.project_id = v_o.project_id and t.organization_id = p_organization_id;", "and t.organization_id = p_organization_id;")]),
    ('brief: an unknown id is accepted', 'fn', S['brief'], [("if v_cnt <> coalesce(cardinality(v_ids), 0) then return query select 'context_not_this_clients'::text, null::uuid; return; end if;", '')]),
    ('brief: no citation required', 'fn', S['brief'], [("if v_total = 0 then return query select 'context_required'::text, null::uuid; return; end if;", '')]),
    ('brief: unknown citation keys accepted', 'fn', S['brief'], [("then return query select 'unknown_context_key'::text, null::uuid; return; end if;", "then null; end if;")]),
    ('brief: a price is not refused (door layer)', 'fn', S['brief'], [("    return query select 'names_a_price'::text, null::uuid; return;", "    null;")]),
    ('brief: question shape refusal removed (door layer)', 'fn', S['brief'], [("then return query select 'bad_questions'::text, null::uuid; return; end if;\n  end loop;", "then null; end if;\n  end loop;")]),
    ('brief: the earlier draft is not superseded', 'fn', S['brief'], [("update projects.sales_discovery_briefs set status = 'superseded' where opportunity_id = p_opportunity_id and status = 'draft';", "")]),
    ('brief: an identical brief is recorded again', 'fn', S['brief'], [("then return query select 'already_recorded'::text, v_last.id; return; end if;", "then null; end if;")]),
    ('brief: the opportunity is read for any organization', 'fn', S['brief'], [("o.id = p_opportunity_id and o.organization_id = p_organization_id for update", "o.id = p_opportunity_id for update")]),
    ('brief review: person check removed', 'fn', S['brief_r'], [(WRITE1, '')]),
    ('brief review: a superseded brief may be reviewed', 'fn', S['brief_r'], [("if v_b.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;", '')]),
    ('brief review: organization filter removed', 'fn', S['brief_r'], [("b.id = p_brief_id and b.organization_id = v_org for update", "b.id = p_brief_id for update")]),
    ('brief CHECK dropped: no price (table layer)', 'sql', drop_check('sales_discovery_briefs', 'discovery_brief_names_no_price'), None),
    ('brief CHECK dropped: reviewed is a person (table layer)', 'sql', drop_check('sales_discovery_briefs', 'discovery_brief_reviewed_is_a_person'), None),
    ('brief unique index dropped (one live draft)', 'sql', 'drop index projects.sales_discovery_briefs_one_draft;', None),
    ('brief guard trigger dropped', 'sql', drop_trigger('sales_discovery_briefs_p8_guard', 'sales_discovery_briefs'), None),
    ('brief read policy loses is_internal (a client reads it)', 'sql', open_policy('sales_discovery_briefs'), None),
    ('brief: a signed-in person is granted the agent door', 'sql', 'grant execute on function projects.record_discovery_brief_draft(uuid,uuid,text,text,jsonb,jsonb) to authenticated;', None),
    # ── tenancy and freezing ──
    ('tenancy trigger dropped: feedback project', 'sql', drop_trigger('org_match_client_feedback_project_id', 'client_feedback'), None),
    ('tenancy trigger dropped: citation article', 'sql', drop_trigger('org_match_ticket_knowledge_citations_article_id', 'ticket_knowledge_citations'), None),
    ('tenancy trigger dropped: scope item', 'sql', drop_trigger('org_match_ticket_scope_references_scope_item_id', 'ticket_scope_references'), None),
    ('tenancy trigger dropped: brief opportunity', 'sql', drop_trigger('org_match_sales_discovery_briefs_opportunity_id', 'sales_discovery_briefs'), None),
    ('organization freeze dropped: knowledge articles', 'sql', drop_trigger('freeze_org_support_knowledge_articles', 'support_knowledge_articles'), None),
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
    only = [a for a in sys.argv[1:] if not a.startswith('--')]
    scratch = os.environ.get('REDPROOF_DIR', '/tmp')
    for name, kind, target, edits in CASES:
        if only and not any(o in name for o in only):
            continue
        mutated = text.replace(marker, marker + injection(kind, target, edits), 1)
        f = Path(scratch) / 'redproof-phase-eight-a-gaps-1.sql'
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
