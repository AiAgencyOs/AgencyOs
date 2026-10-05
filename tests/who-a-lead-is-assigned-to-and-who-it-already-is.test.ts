import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, SUBSCRIPTIONS, subscribersFor } from '../src/lib/events/catalog.ts';
import { region } from './_region.ts';

/**
 * Lead routing and identity resolution — Audit 1.2/1.3
 * (docs/AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json), Implementation Plan Phase 1
 * items 1 and 3.
 *
 * These assertions read the migration and the wiring the same way this
 * repository's other event-handler tests do (`phase-two-begins-where-phase-
 * one-ends.test.ts` is the model) — they cannot themselves execute SQL. That
 * proof was done separately, live, against a scratch Postgres booted by
 * `scripts/apply-migrations-locally.sh`:
 *
 *   - all 310 migrations (including the three this task adds) applied clean
 *   - crm.route_lead: a matching rule assigns the named rep; an unmatched
 *     lead falls back to round-robin among active staff; a lead with
 *     assigned_to already set is refused (`already_assigned`) rather than
 *     overwritten
 *   - crm.classify_lead_identity: all five outcomes were produced from real
 *     rows — EXISTING_CLIENT (contact tied to a client account),
 *     EXISTING_LEAD (a second open lead on the same contact), REACTIVATED_LEAD
 *     (a disqualified lead on the same contact), POSSIBLE_DUPLICATE_REVIEW
 *     (same normalized name, different contact) and NEW_IDENTITY — and a
 *     replay of either RPC on the same lead answered `already_assigned` /
 *     `already_classified` rather than acting twice
 *   - RED-PROOF A: removing the `assigned_to is not null` guard from
 *     crm.route_lead let a manually-assigned lead be silently reassigned;
 *     restoring the guard (the migration's own definition) refused it again
 *   - RED-PROOF B: dropping `org_match_leads_assignment_rule` let a lead in
 *     one organization take an assignment_rule_id belonging to another;
 *     recreating the trigger (the migration's own definition) refused it
 *     again
 *   - crm.review_identity_resolution: a signed-in member could mark a
 *     POSSIBLE_DUPLICATE_REVIEW row `confirmed_duplicate` — and nothing in
 *     that path calls crm.merge_leads or deletes anything
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const EVENT_MIGRATION = read('supabase/migrations/20261030300000_the_event_a_lead_creates.sql');
const ROUTING_MIGRATION = read('supabase/migrations/20261030310000_who_a_lead_is_assigned_to.sql');
const IDENTITY_MIGRATION = read('supabase/migrations/20261030320000_which_lead_this_already_is.sql');
const HANDLERS = read('src/modules/crm/handlers.ts');
const ROUTE = read('app/api/jobs/run/route.ts');

describe('A. lead.created is emitted for every insert path, by trigger', () => {
  test('the event type is declared before it can be emitted', () => {
    assert.match(EVENT_MIGRATION, /insert into core\.event_types \(type, description, canonical\) values\s*\n\s*\('lead\.created'/);
  });

  test('it is an AFTER INSERT trigger on crm.leads, not a rewrite of the ingest function', () => {
    assert.match(EVENT_MIGRATION, /create trigger lead_created\s*\n\s*after insert on crm\.leads/);
    assert.doesNotMatch(EVENT_MIGRATION, /create or replace function crm\.ingest_whatsapp_message/, 'the emitter is a trigger, not a rewrite of an existing door');
  });

  test('a merge (an UPDATE) does not re-fire it', () => {
    // AFTER INSERT only — merged_into_lead_id/merged_at are set by UPDATE.
    assert.doesNotMatch(EVENT_MIGRATION, /after insert or update/);
  });
});

describe('B. two independent subscribers, each its own job kind', () => {
  test('the catalog wires both handlers to lead.created', () => {
    assert.deepEqual(
      [...(SUBSCRIPTIONS['lead.created'] ?? [])].sort(),
      ['crm:classifyLeadIdentity', 'crm:routeLead'].sort(),
    );
    assert.equal(subscribersFor('lead.created').length, 2);
  });

  test('each handler has its own job kind', () => {
    assert.equal(HANDLER_JOB_KIND['crm:routeLead'], 'lead.route');
    assert.equal(HANDLER_JOB_KIND['crm:classifyLeadIdentity'], 'lead.identity_classify');
  });

  test('both are drained in the pure-database tier, ahead of the agent batch', () => {
    const routingAt = ROUTE.indexOf('const leadRouting = await runEventJobs');
    const identityAt = ROUTE.indexOf('const leadIdentity = await runEventJobs');
    const agentsAt = ROUTE.indexOf('AGENT_BATCH');
    assert.ok(routingAt > 0 && identityAt > routingAt && agentsAt > identityAt);
    assert.match(ROUTE, /LEAD_ROUTE_JOB_KIND,\s*\n\s*handleRouteLead,/);
    assert.match(ROUTE, /LEAD_IDENTITY_JOB_KIND,\s*\n\s*handleClassifyLeadIdentity,/);
  });
});

describe('C. the router is admin-configurable, not hardcoded business logic', () => {
  test('rules are their own table, owner/ops_admin only', () => {
    assert.match(ROUTING_MIGRATION, /create table if not exists crm\.lead_assignment_rules/);
    assert.match(ROUTING_MIGRATION, /current_user_role\(\)\) in \('owner', 'ops_admin'\)/);
  });

  test('every match_* column is a whitelist — null/empty matches anything', () => {
    for (const col of ['match_source', 'match_service_type', 'match_language', 'match_region']) {
      assert.match(ROUTING_MIGRATION, new RegExp(`r\\.${col} is null or cardinality\\(r\\.${col}\\) = 0`));
    }
  });

  test('it reads the seven signals the audit names', () => {
    // source (a real column), service type / language / region (requirements
    // jsonb), score as the priority proxy, repeat-client via the contact's
    // client_account_id, and availability via an active membership.
    assert.match(ROUTING_MIGRATION, /v_lead\.requirements->>'serviceType'/);
    assert.match(ROUTING_MIGRATION, /v_lead\.requirements->>'language'/);
    assert.match(ROUTING_MIGRATION, /v_lead\.requirements->>'region'/);
    assert.match(ROUTING_MIGRATION, /match_min_score is null or v_lead\.score >= r\.match_min_score/);
    assert.match(ROUTING_MIGRATION, /client_account_id is not null\) into v_is_repeat/);
    assert.match(ROUTING_MIGRATION, /m\.status = 'active'/);
  });

  test('never overrides a human assignment — checked before anything else', () => {
    const fn = region(ROUTING_MIGRATION, 'create or replace function crm.route_lead');
    assert.match(fn, /if v_lead\.assigned_to is not null then\s*\n\s*return query select 'already_assigned'/);
  });

  test('falls back to round-robin, least-loaded first, contractors excluded', () => {
    const fn = region(ROUTING_MIGRATION, 'create or replace function crm.route_lead');
    assert.match(fn, /role in \('owner', 'ops_admin', 'delivery_lead', 'member'\)/);
    assert.doesNotMatch(fn.match(/order by \([\s\S]{0,400}/)?.[0] ?? '', /contractor/);
  });

  test('the write is audited (lead.assigned) and carries the reason on the row', () => {
    assert.match(ROUTING_MIGRATION, /'lead\.assigned', 'lead'/);
    assert.match(ROUTING_MIGRATION, /add column if not exists assignment_reason text/);
    assert.match(ROUTING_MIGRATION, /add column if not exists assignment_rule_id uuid references crm\.lead_assignment_rules/);
  });

  test('the rules table carries this repo\'s tenancy guards', () => {
    assert.match(ROUTING_MIGRATION, /core\.freeze_organization_id\(\)/);
    assert.match(ROUTING_MIGRATION, /enforce_parent_org\('assignment_rule_id', 'crm\.lead_assignment_rules'\)/);
    assert.match(ROUTING_MIGRATION, /alter table crm\.lead_assignment_rules force row level security/);
  });
});

describe('D. identity resolution never auto-merges', () => {
  test('the five outcomes are the exact closed vocabulary the audit named', () => {
    const table = region(IDENTITY_MIGRATION, 'create table if not exists crm.identity_resolutions');
    for (const outcome of ['NEW_IDENTITY', 'EXISTING_LEAD', 'EXISTING_CLIENT', 'REACTIVATED_LEAD', 'POSSIBLE_DUPLICATE_REVIEW']) {
      assert.match(table, new RegExp(`'${outcome}'`));
    }
  });

  test('nothing in this migration calls merge_leads, deletes a row, or reassigns a contact', () => {
    assert.doesNotMatch(IDENTITY_MIGRATION, /crm\.merge_leads\(/);
    assert.doesNotMatch(IDENTITY_MIGRATION, /delete from crm\./);
    assert.doesNotMatch(IDENTITY_MIGRATION, /update crm\.leads\s+set\s+contact_id/);
  });

  test('POSSIBLE_DUPLICATE_REVIEW is the only outcome a person may ever write to', () => {
    assert.match(IDENTITY_MIGRATION, /identity_resolutions_review_only_for_flagged/);
    assert.match(IDENTITY_MIGRATION, /check \(reviewed_at is null or outcome = 'POSSIBLE_DUPLICATE_REVIEW'\)/);
  });

  test('reviewing records a judgment only — acting on it is still a separate door', () => {
    const fn = region(IDENTITY_MIGRATION, 'create or replace function crm.review_identity_resolution');
    assert.doesNotMatch(fn, /merge_leads/);
    assert.match(fn, /'confirmed_duplicate', 'not_a_duplicate'/);
  });

  test('classification is idempotent — one row per lead, unique constraint owns it', () => {
    assert.match(IDENTITY_MIGRATION, /lead_id\s+uuid not null unique references crm\.leads/);
    assert.match(IDENTITY_MIGRATION, /on conflict \(lead_id\) do nothing/);
  });

  test('an exact phone/email match cannot reach POSSIBLE_DUPLICATE_REVIEW — only a different contact can', () => {
    const fn = region(IDENTITY_MIGRATION, 'create or replace function crm.classify_lead_identity');
    assert.match(fn, /c2\.id <> v_contact\.id/);
    assert.match(fn, /lower\(btrim\(c2\.full_name\)\) = lower\(btrim\(v_contact\.full_name\)\)/);
  });

  test('the resolutions table carries this repo\'s tenancy guards', () => {
    assert.match(IDENTITY_MIGRATION, /enforce_parent_org\('lead_id', 'crm\.leads'\)/);
    assert.match(IDENTITY_MIGRATION, /core\.freeze_organization_id\(\)/);
    assert.match(IDENTITY_MIGRATION, /alter table crm\.identity_resolutions force row level security/);
  });
});

describe('E. the handlers are thin and re-read the row, never trust the payload', () => {
  test('handleRouteLead and handleClassifyLeadIdentity read the lead id from the job, not the payload', () => {
    const routeFn = region(HANDLERS, 'export async function handleRouteLead');
    const identityFn = region(HANDLERS, 'export async function handleClassifyLeadIdentity');
    for (const fn of [routeFn, identityFn]) {
      assert.match(fn, /leadIdFrom\(job\)/);
      assert.doesNotMatch(fn, /payload\.assignedTo|payload\.outcome/);
    }
  });

  test('a database error is retried; an unknown lead is not', () => {
    const routeFn = region(HANDLERS, 'export async function handleRouteLead');
    assert.match(routeFn, /if \(error\) \{[\s\S]{0,200}permanent: false/);
    assert.match(routeFn, /case 'unknown_lead':[\s\S]{0,120}permanent: true/);
  });

  test('neither handler sends anything', () => {
    const routeFn = region(HANDLERS, 'export async function handleRouteLead');
    const identityFn = region(HANDLERS, 'export async function handleClassifyLeadIdentity');
    for (const fn of [routeFn, identityFn]) {
      assert.doesNotMatch(fn, /send_outbound_message|sendMessage|sendWhatsAppText/i);
    }
  });
});
