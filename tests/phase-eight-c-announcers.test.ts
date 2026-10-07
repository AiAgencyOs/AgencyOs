import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import * as schema from '../src/modules/crm/schema.ts';

/**
 * The Phase 8C PM announcers: the eight post-launch maintenance events that were declared and emitted but had no subscriber. Each is versioned, leak-free,
 * internal-channel only, keyed by the record it is about, and wired end to end (a migration declares the event, the catalog subscribes the handler, the
 * runner runs it).
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const HANDLERS_TS = read('src/modules/crm/handlers.ts');
const ROUTE_TS = read('app/api/jobs/run/route.ts');
const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const MIGRATIONS = readdirSync(dir).filter((f) => /^202611(05|09)[0-9]{6}_/.test(f)).map((f) => readFileSync(`${dir}${f}`, 'utf8')).join('\n');
const NAME = 'Shop';

const WIRING = [
  ['project.maintenance_work_opened', 'crm:announceMaintenanceWorkOpened', 'maintenance_work_opened.announce', 'maintenance-work-opened', 'PM8-C01'],
  ['project.maintenance_qa_failed', 'crm:announceMaintenanceQaFailed', 'maintenance_qa_failed.announce', 'maintenance-qa-failed', 'PM8-C02'],
  ['project.maintenance_release_requested', 'crm:announceMaintenanceReleaseRequested', 'maintenance_release_requested.announce', 'maintenance-release-requested', 'PM8-C03'],
  ['project.maintenance_release_approved', 'crm:announceMaintenanceReleaseApproved', 'maintenance_release_approved.announce', 'maintenance-release-approved', 'PM8-C04'],
  ['project.maintenance_released', 'crm:announceMaintenanceReleased', 'maintenance_released.announce', 'maintenance-released', 'PM8-C05'],
  ['finance.maintenance_billing_proposed', 'crm:announceMaintenanceBillingProposed', 'maintenance_billing_proposed.announce', 'maintenance-billing-proposed', 'PM8-C06'],
  ['project.maintenance_sla_breached', 'crm:announceMaintenanceSlaBreached', 'maintenance_sla_breached.announce', 'maintenance-sla-breached', 'PM8-C07'],
  ['project.maintenance_work_stalled', 'crm:announceMaintenanceWorkStalled', 'maintenance_work_stalled.announce', 'maintenance-work-stalled', 'PM8-C08'],
] as const;

const RENDERED = {
  opened: schema.maintenanceWorkOpenedAnnouncementFor({ projectName: NAME }),
  openedEmergency: schema.maintenanceWorkOpenedAnnouncementFor({ projectName: NAME, emergency: true }),
  qaFailed: schema.maintenanceQaFailedAnnouncementFor({ projectName: NAME, category: 'security' }),
  releaseRequested: schema.maintenanceReleaseRequestedAnnouncementFor({ projectName: NAME }),
  releaseApproved: schema.maintenanceReleaseApprovedAnnouncementFor({ projectName: NAME }),
  released: schema.maintenanceReleasedAnnouncementFor({ projectName: NAME }),
  billingInvoice: schema.maintenanceBillingProposedAnnouncementFor({ projectName: NAME, kind: 'maintenance_invoice' }),
  billingReminder: schema.maintenanceBillingProposedAnnouncementFor({ projectName: NAME, kind: 'payment_reminder' }),
  slaBreached: schema.maintenanceSlaBreachedAnnouncementFor({ projectName: NAME }),
  stalledQa: schema.maintenanceWorkStalledAnnouncementFor({ projectName: NAME, reason: 'no_independent_qa' }),
  stalledApprover: schema.maintenanceWorkStalledAnnouncementFor({ projectName: NAME, reason: 'no_independent_approver' }),
  stalledAuth: schema.maintenanceWorkStalledAnnouncementFor({ projectName: NAME, reason: 'authorization_invalid' }),
  stalledIdle: schema.maintenanceWorkStalledAnnouncementFor({ projectName: NAME, reason: 'inactive' }),
};

describe('every PM8-C message is free of leaks and says nothing that is not on the record', () => {
  const LEAK = /claude|gpt|openai|anthropic|openrouter|gemini|llama|branch|bug_fix|regression_test|support_agent|customer_success|upsell|quality_assurance|sk-[a-z0-9]|token|secret|password|\b[0-9a-f]{7,40}\b|[0-9a-f]{8}-[0-9a-f]{4}-/i;
  for (const [name, text] of Object.entries(RENDERED)) {
    test(`${name} names no model, agent, secret, commit or id and is short`, () => {
      assert.doesNotMatch(text, LEAK, text);
      assert.ok(text.length > 0 && text.length < 500);
    });
    test(`${name} names no price, discount, health signal or question`, () => {
      assert.doesNotMatch(text, /₹|\$|rs\.|discount|refund|score|\?/i, text);
    });
  }
  test('the billing message says nothing was created, sent or recorded', () => {
    assert.match(RENDERED.billingInvoice, /No invoice was created/);
    assert.match(RENDERED.billingReminder, /payment reminder draft/);
  });
  test('the release messages say AgencyOS deploys nothing and the client was not told', () => {
    assert.match(RENDERED.releaseRequested, /Nothing is deployed/);
    assert.match(RENDERED.released, /client has not been told/);
  });
  test('the stall message names only the reason class, never a person', () => {
    assert.match(RENDERED.stalledQa, /nobody independent of the author can test it/);
    assert.match(RENDERED.stalledAuth, /no longer valid/);
  });
});

describe('every PM8-C announcer has a versioned template and is wired end to end', () => {
  for (const [event, handler, kind, prefix, milestone] of WIRING) {
    test(`${event} -> ${handler} (${milestone})`, () => {
      assert.deepEqual(SUBSCRIPTIONS[event], [handler]);
      assert.equal(HANDLER_JOB_KIND[handler], kind);
      assert.ok((HANDLERS as readonly string[]).includes(handler));
      const fn = handler.split(':')[1]!;
      assert.match(ROUTE_TS, new RegExp(`runEventJobs\\(admin, [A-Z_]+, ${fn},`));
      assert.match(ROUTE_TS, new RegExp(`import \\{[^}]*\\b${fn}\\b`));
      assert.match(ROUTE_TS, new RegExp(`${fn.replace('announce', '').replace(/^M/, 'm')}Announcements: .*\\.results`), 'the runner summary reports it');
      assert.deepEqual(schema.pmTemplateFor(`${prefix}:abc`), { milestone, version: 1 });
      assert.match(HANDLERS_TS, new RegExp(`externalRef: \`${prefix}:`), 'keyed by the record the event is about');
    });
    test(`${event} is a declared event type (a migration inserts it)`, () => {
      assert.ok(MIGRATIONS.includes(`('${event}',`), event);
    });
  }
  test('every announcer goes to the internal channel only', () => {
    const start = HANDLERS_TS.indexOf('// ── Phase 8C announcers');
    assert.ok(start > 0);
    const block = HANDLERS_TS.slice(start);
    assert.equal([...block.matchAll(/announceToInternalChannel\(/g)].length, 8);
    for (const forbidden of ['deliverQueuedText', 'sendClientMessage', 'planOutbound', 'send_outbound_message']) assert.ok(!block.includes(forbidden), forbidden);
  });
  test('the repeatable events are keyed by the event too, so a second QA failure is announced again', () => {
    for (const p of ['maintenance-work-opened', 'maintenance-qa-failed', 'maintenance-release-requested', 'maintenance-release-approved', 'maintenance-released']) {
      assert.match(HANDLERS_TS, new RegExp(`externalRef: \`${p}:\\$\\{envelope\\.subjectId[^\`]*envelope\\.eventId`), p);
    }
  });
  test('the milestone ids are unique', () => {
    const ids = Object.values(schema.PM_TEMPLATES).map((t) => t.milestone);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('the event payloads each announcer parses', () => {
  const U = '11111111-1111-4111-8111-111111111111';
  test('valid payloads parse and strip extras', () => {
    assert.ok(schema.maintenanceWorkOpenedEventSchema.safeParse({ projectId: U, kind: 'hotfix', emergency: true, extra: 1 }).success);
    assert.ok(schema.maintenanceQaFailedEventSchema.safeParse({ projectId: U, category: 'regression' }).success);
    assert.ok(schema.maintenanceReleaseRequestedEventSchema.safeParse({ projectId: U }).success);
    assert.ok(schema.maintenanceBillingProposedEventSchema.safeParse({ projectId: U, kind: 'payment_reminder' }).success);
    assert.ok(schema.maintenanceSlaBreachedEventSchema.safeParse({ projectId: U, workItemId: U, priority: 'p2' }).success);
    assert.ok(schema.maintenanceWorkStalledEventSchema.safeParse({ projectId: U, workItemId: U, reason: 'inactive' }).success);
  });
  test('malformed payloads are refused', () => {
    assert.ok(!schema.maintenanceSlaBreachedEventSchema.safeParse({ projectId: U }).success);
    assert.ok(!schema.maintenanceWorkStalledEventSchema.safeParse({ projectId: U, workItemId: U, reason: 'whenever' }).success);
    assert.ok(!schema.maintenanceQaFailedEventSchema.safeParse({ projectId: 'nope' }).success);
  });
  test('the SQL emits exactly the payload keys the schemas read', () => {
    assert.match(MIGRATIONS, /'project\.maintenance_work_opened', 'maintenance_work_item', v_new, jsonb_build_object\('projectId', p_project_id, 'kind', p_kind, 'emergency'/);
    assert.match(MIGRATIONS, /'project\.maintenance_qa_failed', 'maintenance_work_item', v_i\.id, jsonb_build_object\('projectId', v_i\.project_id, 'category', p_category\)/);
    assert.match(MIGRATIONS, /'finance\.maintenance_billing_proposed', 'maintenance_billing_proposal', v_id, jsonb_build_object\('kind', v_req\.kind, 'projectId', v_req\.project_id\)/);
    assert.match(MIGRATIONS, /'project\.maintenance_sla_breached', 'maintenance_work_item', r\.id, jsonb_build_object\('projectId', r\.project_id, 'workItemId', r\.id, 'priority', v_pr\)/);
    assert.match(MIGRATIONS, /'project\.maintenance_work_stalled', 'maintenance_work_item', r\.id, jsonb_build_object\('projectId', r\.project_id, 'workItemId', r\.id, 'reason', s\.reason_code\)/);
  });
});
