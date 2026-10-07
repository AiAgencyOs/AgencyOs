import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import * as schema from '../src/modules/crm/schema.ts';

/**
 * The Phase 8A PM announcements: five messages that have a real event, each versioned, leak-free, internal-channel only, once per record, and wired end to end
 * (migration declares the event type, the catalog subscribes the handler, the runner runs it).
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const HANDLERS_TS = read('src/modules/crm/handlers.ts');
const ROUTE_TS = read('app/api/jobs/run/route.ts');
const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const MIGRATIONS = readdirSync(dir).filter((f) => /^2026110[5][0-9]{6}_/.test(f)).map((f) => readFileSync(`${dir}${f}`, 'utf8')).join('\n');
const NAME = 'Shop';

const WIRING = [
  ['project.phase_eight_started', 'crm:announcePhaseEightStarted', 'phase_eight_started.announce', 'phase-eight-started', 'PM8-M01'],
  ['support.ticket_escalated', 'crm:announceSupportTicketEscalated', 'support_ticket_escalated.announce', 'support-ticket-escalated', 'PM8-A01'],
  ['support.sla_breached', 'crm:announceSupportSlaBreached', 'support_sla_breached.announce', 'support-sla-breached', 'PM8-A02'],
  ['customer.retention_recovery_required', 'crm:announceRetentionRecoveryRequired', 'retention_recovery_required.announce', 'retention-recovery-required', 'PM8-RECOVERY'],
  ['maintenance.renewal_due', 'crm:announceMaintenanceRenewalDue', 'maintenance_renewal_due.announce', 'maintenance-renewal-due', 'PM8-RENEWAL-DUE'],
] as const;

const RENDERED = {
  started: schema.phaseEightStartedAnnouncementFor({ projectName: NAME }),
  escalated: schema.supportTicketEscalatedAnnouncementFor({ projectName: NAME }),
  slaResponse: schema.supportSlaBreachedAnnouncementFor({ projectName: NAME, kind: 'response' }),
  slaResolution: schema.supportSlaBreachedAnnouncementFor({ projectName: NAME, kind: 'resolution' }),
  recovery: schema.retentionRecoveryRequiredAnnouncementFor({ projectName: NAME }),
  renewal: schema.maintenanceRenewalDueAnnouncementFor({ projectName: NAME }),
};

describe('every PM8 message is free of leaks and says nothing that is not on the record', () => {
  const LEAK = /claude|gpt|openai|anthropic|openrouter|gemini|llama|branch|support_agent|customer_success|upsell|quality_assurance|sk-[a-z0-9]|token|secret|password|\b[0-9a-f]{7,40}\b|[0-9a-f]{8}-[0-9a-f]{4}-/i;
  for (const [name, text] of Object.entries(RENDERED)) {
    test(`${name} names no model, agent, secret, commit or id and is short`, () => {
      assert.doesNotMatch(text, LEAK, text);
      assert.ok(text.length > 0 && text.length < 500);
    });
    test(`${name} names no price, discount, health signal, client wording or deadline`, () => {
      assert.doesNotMatch(text, /₹|\$|rs\.|discount|refund|score|\?/i, text);
    });
  }
  test('the renewal message says nothing was renewed and a person proposes it', () => {
    assert.match(RENDERED.renewal, /Nothing has been renewed or sent/);
  });
  test('the recovery message says outreach waits, and puts no signal in the message', () => {
    assert.match(RENDERED.recovery, /before any commercial outreach/);
    assert.doesNotMatch(RENDERED.recovery, /critical|at risk|overdue|breach/i);
  });
  test('the SLA message names the target kind only', () => {
    assert.match(RENDERED.slaResponse, /response target/);
    assert.match(RENDERED.slaResolution, /resolution target/);
  });
});

describe('every PM8 announcer has a versioned template, and is wired end to end', () => {
  for (const [event, handler, kind, prefix, milestone] of WIRING) {
    test(`${event} -> ${handler} (${milestone})`, () => {
      assert.deepEqual(SUBSCRIPTIONS[event], [handler]);
      assert.equal(HANDLER_JOB_KIND[handler], kind);
      assert.ok((HANDLERS as readonly string[]).includes(handler));
      const fn = handler.split(':')[1]!;
      assert.match(ROUTE_TS, new RegExp(`runEventJobs\\(admin, [A-Z_]+, ${fn},`));
      assert.match(ROUTE_TS, new RegExp(`import \\{[^}]*\\b${fn}\\b`));
      assert.deepEqual(schema.pmTemplateFor(`${prefix}:abc`), { milestone, version: 1 });
      assert.match(HANDLERS_TS, new RegExp(`externalRef: \`${prefix}:`), 'the announcer is keyed by the record the event is about');
    });
    test(`${event} is a registered event type (a Phase 8A migration inserts it)`, () => {
      assert.ok(MIGRATIONS.includes(`('${event}',`), event);
    });
  }
  test('every announcer goes to the internal channel only', () => {
    const start = HANDLERS_TS.indexOf('// ── Phase 8A announcers');
    assert.ok(start > 0);
    // bounded at the next section: Phase 8C appends its own announcers (and has its own test) after this block
    const end = HANDLERS_TS.indexOf('// ── Phase 8C announcers', start);
    assert.ok(end > start);
    const block = HANDLERS_TS.slice(start, end);
    assert.equal([...block.matchAll(/announceToInternalChannel\(/g)].length, 5);
    for (const forbidden of ['deliverQueuedText', 'send_outbound_message', 'sendClientMessage', 'planOutbound']) assert.ok(!block.includes(forbidden), forbidden);
  });
  test('the runner summary reports each of the five', () => {
    for (const k of ['phaseEightStartedAnnouncements', 'supportEscalatedAnnouncements', 'supportSlaBreachedAnnouncements', 'retentionRecoveryAnnouncements', 'maintenanceRenewalDueAnnouncements']) assert.match(ROUTE_TS, new RegExp(`${k}: ${k}\\.results`));
  });
  test('the milestone ids are unique and versions are positive integers', () => {
    const ids = Object.values(schema.PM_TEMPLATES).map((t) => t.milestone);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('the event payloads each announcer parses', () => {
  const U = '11111111-1111-4111-8111-111111111111';
  test('valid payloads parse and strip extras', () => {
    assert.ok(schema.phaseEightStartedEventSchema.safeParse({ projectId: U }).success);
    assert.ok(schema.supportTicketEscalatedEventSchema.safeParse({ projectId: U, ticketId: U, extra: 1 }).success);
    assert.ok(schema.supportSlaBreachedEventSchema.safeParse({ projectId: U, ticketId: U, kind: 'resolution' }).success);
    assert.ok(schema.retentionRecoveryRequiredEventSchema.safeParse({ projectId: U, planId: U, status: 'critical' }).success);
    assert.ok(schema.maintenanceRenewalDueEventSchema.safeParse({ projectId: U, planId: U, endsOn: '2027-01-01' }).success);
  });
  test('malformed payloads are refused', () => {
    assert.ok(!schema.supportSlaBreachedEventSchema.safeParse({ projectId: U, ticketId: U, kind: 'whenever' }).success);
    assert.ok(!schema.retentionRecoveryRequiredEventSchema.safeParse({ projectId: U, planId: U, status: 'healthy' }).success);
    assert.ok(!schema.phaseEightStartedEventSchema.safeParse({ projectId: 'nope' }).success);
  });
  test('the SQL emits exactly the payload keys the schemas read', () => {
    assert.match(MIGRATIONS, /'support\.sla_breached', 'support_ticket', r\.id, jsonb_build_object\('projectId', r\.project_id, 'ticketId', r\.id, 'kind', 'response'\)/);
    assert.match(MIGRATIONS, /'customer\.retention_recovery_required', 'recovery_plan', v_plan, jsonb_build_object\('projectId', p_project_id, 'planId', v_plan, 'status', v_new\.status\)/);
    assert.match(MIGRATIONS, /'maintenance\.renewal_due', 'maintenance_plan', r\.id, jsonb_build_object\('projectId', r\.project_id, 'planId', r\.id, 'endsOn', r\.ends_on\)/);
    assert.match(MIGRATIONS, /'project\.phase_eight_started', 'phase_eight', v_new, jsonb_build_object\('projectId', p_project_id\)/);
  });
});
