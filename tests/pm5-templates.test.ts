import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import {
  buildReadyForAdminAnnouncementFor, buildRevisedAnnouncementFor, devClarificationAnnouncementFor, developmentEscalatedAnnouncementFor,
  moduleCompletedAnnouncementFor, PM_TEMPLATES, pmTemplateFor,
} from '../src/modules/crm/schema.ts';

/** Phase 5 PM spec: every milestone message is versioned, client-safe, wired to an event and a runner block. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const HANDLERS_TS = read('src/modules/crm/handlers.ts');

describe('every PM5/PM6 announcer has a versioned template', () => {
  test('each externalRef prefix written after announcePhaseFiveStarted is a PM_TEMPLATES key', () => {
    const start = HANDLERS_TS.indexOf('export async function announcePhaseFiveStarted');
    assert.ok(start > 0);
    const tail = HANDLERS_TS.slice(start, HANDLERS_TS.length);
    const prefixes = [...tail.matchAll(/externalRef: `([a-z0-9-]+):/g)].map((m) => m[1]!);
    assert.ok(prefixes.length >= 16, `only ${prefixes.length} prefixes found`);
    for (const p of prefixes) assert.ok(PM_TEMPLATES[p], `no template version for ${p}`);
  });
  test('the spec milestone ids are the ones that ship', () => {
    const ids = new Set(Object.values(PM_TEMPLATES).map((t) => t.milestone));
    for (const id of ['PM5-M01', 'PM5-M02', 'PM5-M03', 'PM5-M04', 'PM5-M05', 'PM5-M06', 'PM5-M07', 'PM5-A01', 'PM5-A02']) assert.ok(ids.has(id), id);
  });
  test('pmTemplateFor reads the prefix and ignores the rest', () => {
    assert.deepEqual(pmTemplateFor('build-ready-for-admin:abc:v2'), { milestone: 'PM5-A01', version: 1 });
    assert.equal(pmTemplateFor('something-else:1'), null);
  });
});

describe('the new messages are client-safe', () => {
  const texts = [
    buildReadyForAdminAnnouncementFor({ projectName: 'Shop', version: 3 }),
    buildRevisedAnnouncementFor({ projectName: 'Shop', version: 2 }),
    devClarificationAnnouncementFor({ projectName: 'Shop' }),
    developmentEscalatedAnnouncementFor({ projectName: 'Shop', taskTitle: 'Checkout API', cause: 'no_route' }),
    moduleCompletedAnnouncementFor({ projectName: 'Shop', moduleName: 'Checkout' }),
  ];
  test('none names a model, a provider, a branch, an agent key or a secret', () => {
    for (const t of texts) assert.doesNotMatch(t, /claude|gpt|openai|anthropic|openrouter|branch|backend_developer|bug_fix|sk-|token/i, t);
  });
  test('the clarification message carries no question text: that is read from the row', () => {
    assert.doesNotMatch(devClarificationAnnouncementFor({ projectName: 'Shop' }), /\?/);
  });
  test('a revised build says so and names the version', () => {
    assert.match(buildRevisedAnnouncementFor({ projectName: 'Shop', version: 2 }), /Revised development build v2/);
  });
});

describe('each new announcer is wired end to end', () => {
  for (const [event, handler, kind] of [
    ['project.build_ready_for_admin', 'crm:announceBuildReadyForAdmin', 'build_ready_for_admin.announce'],
    ['project.development_escalated', 'crm:announceDevelopmentEscalated', 'development_escalated.announce'],
    ['project.module_completed', 'crm:announceModuleCompleted', 'module_completed.announce'],
    ['project.dev_clarification_requested', 'crm:announceDevClarification', 'dev_clarification.announce'],
  ] as const) {
    test(`${event} -> ${handler}`, () => {
      assert.ok(SUBSCRIPTIONS[event]?.includes(handler));
      assert.equal(HANDLER_JOB_KIND[handler], kind);
      assert.ok((HANDLERS as readonly string[]).includes(handler));
      const fn = handler.split(':')[1]!;
      assert.match(read('app/api/jobs/run/route.ts'), new RegExp(`runEventJobs\\(admin, [A-Z_]+, ${fn},`));
    });
  }
  test('the escalation handler re-reads its row for the job\'s organization and skips a resolved one', () => {
    const i = HANDLERS_TS.indexOf('export async function announceDevelopmentEscalated');
    const body = HANDLERS_TS.slice(i, i + 1600);
    assert.match(body, /\.eq\('organization_id', job\.organization_id\)/);
    assert.match(body, /row\.status !== 'open'/);
  });
});
