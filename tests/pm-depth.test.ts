import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import * as schema from '../src/modules/crm/schema.ts';

/**
 * Phase 5 / Phase 6 PM depth: every PM5/PM6 message is versioned, leak-free and wired; the three PM6 messages that have a real event are
 * announced; the revision-limit escalation reuses the event the earlier phases are told by.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const HANDLERS_TS = read('src/modules/crm/handlers.ts');
const ROUTE_TS = read('app/api/jobs/run/route.ts');
const { PM_TEMPLATES, pmTemplateFor } = schema;

const NAME = 'Shop';
/** One rendering of every PM5/PM6 message, with the inputs its announcer passes. */
const RENDERED: Record<string, string> = {
  phaseFiveStarted: schema.phaseFiveStartedAnnouncementFor({ projectName: NAME }),
  devClarification: schema.devClarificationAnnouncementFor({ projectName: NAME }),
  moduleCompleted: schema.moduleCompletedAnnouncementFor({ projectName: NAME, moduleName: 'Checkout' }),
  buildRevised: schema.buildRevisedAnnouncementFor({ projectName: NAME, version: 2 }),
  buildReadyForAdmin: schema.buildReadyForAdminAnnouncementFor({ projectName: NAME, version: 3 }),
  developmentEscalated: schema.developmentEscalatedAnnouncementFor({ projectName: NAME, taskTitle: 'Checkout API', cause: 'no_route' }),
  buildShared: schema.buildSharedAnnouncementFor({ projectName: NAME, version: 1 }),
  buildFeedbackReceived: schema.buildFeedbackReceivedAnnouncementFor({ projectName: NAME, version: 1 }),
  buildApproved: schema.buildApprovedAnnouncementFor({ projectName: NAME, version: 4 }),
  buildFeedbackRouted: schema.buildFeedbackRoutedAnnouncementFor({ projectName: NAME, classification: 'bug' }),
  m3PaymentVerified: schema.m3PaymentVerifiedAnnouncementFor({ projectName: NAME }),
  task3Complete: schema.task3CompleteAnnouncementFor({ projectName: NAME }),
  phaseSixReady: schema.phaseSixReadyAnnouncementFor({ projectName: NAME }),
  testingStarted: schema.testingStartedAnnouncementFor({ projectName: NAME }),
  qaClarification: schema.qaClarificationAnnouncementFor({ projectName: NAME }),
  qaDefectProgressSerious: schema.qaDefectProgressAnnouncementFor({ projectName: NAME, sLevel: 1 }),
  qaDefectProgressMinor: schema.qaDefectProgressAnnouncementFor({ projectName: NAME, sLevel: 3 }),
  releaseCandidateApproved: schema.releaseCandidateApprovedAnnouncementFor({ projectName: NAME, version: 2 }),
  releaseCandidateReady: schema.releaseCandidateReadyAnnouncementFor({ projectName: NAME, version: 2 }),
  releaseExceptionRequested: schema.releaseExceptionRequestedAnnouncementFor({ projectName: NAME }),
  qaReverification: schema.qaReverificationAnnouncementFor({ projectName: NAME }),
  m4PaymentVerified: schema.m4PaymentVerifiedAnnouncementFor({ projectName: NAME }),
  task4Complete: schema.task4CompleteAnnouncementFor({ projectName: NAME }),
  phaseSevenReady: schema.phaseSevenReadyAnnouncementFor({ projectName: NAME }),
  deploymentApproved: schema.deploymentApprovedAnnouncementFor({ projectName: NAME }),
  productionValidated: schema.productionValidatedAnnouncementFor({ projectName: NAME }),
  productionValidationFailed: schema.productionValidationFailedAnnouncementFor({ projectName: NAME }),
  handoverReady: schema.handoverReadyAnnouncementFor({ projectName: NAME, version: 3 }),
  projectCompleted: schema.projectCompletedAnnouncementFor({ projectName: NAME }),
  phaseEightStarted: schema.phaseEightStartedAnnouncementFor({ projectName: NAME }),
  supportTicketEscalated: schema.supportTicketEscalatedAnnouncementFor({ projectName: NAME }),
  supportSlaBreached: schema.supportSlaBreachedAnnouncementFor({ projectName: NAME, kind: 'response' }),
  retentionRecoveryRequired: schema.retentionRecoveryRequiredAnnouncementFor({ projectName: NAME }),
  maintenanceRenewalDue: schema.maintenanceRenewalDueAnnouncementFor({ projectName: NAME }),
};

describe('every PM5/PM6 message is free of leaks', () => {
  // a model or provider, a branch, an agent key, a secret, a commit or an internal id, a finding or a question
  const LEAK = /claude|gpt|openai|anthropic|openrouter|gemini|llama|branch|backend_developer|frontend_developer|bug_fix|database_agent|quality_assurance|sk-[a-z0-9]|token|secret|password|\b[0-9a-f]{7,40}\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;
  for (const [name, text] of Object.entries(RENDERED)) {
    test(`${name} names no model, branch, agent, secret, commit or id`, () => {
      assert.doesNotMatch(text, LEAK, text);
      assert.ok(text.length > 0 && text.length < 600, `${name} is a short message`);
    });
  }
  test('the messages a client could be told carry no question or finding text', () => {
    for (const k of ['devClarification', 'qaClarification', 'qaReverification', 'releaseExceptionRequested']) {
      assert.doesNotMatch(RENDERED[k]!, /\?/, `${k} must not carry a question`);
    }
  });
  test('the exception message names neither the rule nor the reason: both stay on the record', () => {
    const text = RENDERED.releaseExceptionRequested!;
    assert.doesNotMatch(text, /gate|security|critical|waive|because/i, text);
  });
  test('the re-verification message tells the client nothing is needed from them and carries no commit', () => {
    assert.match(RENDERED.qaReverification!, /No action is needed from the client/);
  });
  test('a candidate-ready message names the version only', () => {
    assert.match(RENDERED.releaseCandidateReady!, /Release candidate v2 is ready/);
  });
  test('the sweep covers every PM5/PM6 template in the table', () => {
    // each versioned milestone has a rendering above (the two PM6 payment/phase entries share a message each)
    assert.ok(Object.keys(RENDERED).length >= Object.keys(PM_TEMPLATES).length, 'a template was added without a rendering in this sweep');
  });
});

describe('every announcer has a versioned template', () => {
  const dynamic = [...HANDLERS_TS.matchAll(/refPrefix: '([a-z0-9-]+)'/g)].map((m) => m[1]!);
  const staticRefs = [...HANDLERS_TS.matchAll(/externalRef: `([a-z0-9-]+):/g)];
  const phaseFiveStart = HANDLERS_TS.indexOf('export async function announcePhaseFiveStarted');
  test('the PM5/PM6 announcers are found', () => {
    assert.ok(phaseFiveStart > 0);
    assert.ok(dynamic.includes('task3-complete') && dynamic.includes('task4-complete'));
  });
  test('each externalRef prefix written from PM5 on, and each Task 3/4 completion prefix, is a PM_TEMPLATES key', () => {
    const prefixes = [...staticRefs.filter((m) => (m.index ?? 0) >= phaseFiveStart).map((m) => m[1]!), ...dynamic.filter((p) => /^task[34]-/.test(p))];
    assert.ok(prefixes.length >= 22, `only ${prefixes.length} prefixes found`);
    for (const p of prefixes) assert.ok(PM_TEMPLATES[p], `no template version for ${p}`);
  });
  test('and every PM_TEMPLATES key is written by some announcer (no template for a message that is never sent)', () => {
    const written = new Set([...staticRefs.map((m) => m[1]!), ...dynamic]);
    for (const key of Object.keys(PM_TEMPLATES)) assert.ok(written.has(key), `${key} has a version but no announcer writes it`);
  });
  test('the milestone ids are unique and versions are positive integers', () => {
    const ids = Object.values(PM_TEMPLATES).map((t) => t.milestone);
    assert.equal(new Set(ids).size, ids.length);
    for (const t of Object.values(PM_TEMPLATES)) assert.ok(Number.isInteger(t.version) && t.version >= 1);
  });
  test('the spec ids for the PM6 messages that have a real event are present', () => {
    for (const id of ['PM6-M01', 'PM6-M07', 'PM6-A01', 'PM6-A02']) assert.ok(Object.values(PM_TEMPLATES).some((t) => t.milestone === id), id);
    assert.deepEqual(pmTemplateFor('release-candidate-ready:abc'), { milestone: 'PM6-A01', version: 1 });
    assert.deepEqual(pmTemplateFor('release-exception-requested:abc'), { milestone: 'PM6-A02', version: 1 });
  });
});

describe('each new PM6 announcer is wired end to end', () => {
  for (const [event, handler, kind] of [
    ['project.release_candidate_created', 'crm:announceReleaseCandidateReady', 'release_candidate_ready.announce'],
    ['project.release_exception_requested', 'crm:announceReleaseExceptionRequested', 'release_exception_requested.announce'],
    ['project.phase_six_evidence_stale', 'crm:announceQaReverification', 'qa_reverification.announce'],
  ] as const) {
    test(`${event} -> ${handler}`, () => {
      assert.deepEqual(SUBSCRIPTIONS[event], [handler]);
      assert.equal(HANDLER_JOB_KIND[handler], kind);
      assert.ok((HANDLERS as readonly string[]).includes(handler));
      const fn = handler.split(':')[1]!;
      assert.match(ROUTE_TS, new RegExp(`runEventJobs\\(admin, [A-Z_]+, ${fn},`));
      assert.match(ROUTE_TS, new RegExp(`import \\{[^}]*\\b${fn}\\b`));
    });
    test(`${event} is a registered event type (a migration inserts it)`, () => {
      const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
      const all = ['20261101130000_a_release_candidate_is_one_exact_commit_and_gates_decide.sql', '20261101160000_qa_is_scheduled_duplicates_are_canonical_and_a_source_change_reopens_phase_six.sql']
        .map((f) => readFileSync(`${dir}${f}`, 'utf8')).join('\n');
      assert.ok(all.includes(`'${event}'`), event);
    });
  }
  test('each handler is idempotent by subject: the externalRef is keyed by the record the event is about', () => {
    for (const prefix of ['release-candidate-ready', 'release-exception-requested', 'qa-reverification']) {
      assert.match(HANDLERS_TS, new RegExp(`externalRef: \`${prefix}:\\$\\{typeof envelope.subjectId === 'string'`), prefix);
    }
  });
});

describe('the build-revision limit is announced by the event the earlier phases already use', () => {
  const migration = read('supabase/migrations/20261102310000_a_revision_round_is_counted_and_past_the_limit_a_person_decides.sql');
  test('the door emits project.revision_limit_escalated with the count and the limit the existing announcer parses', () => {
    assert.match(migration, /'project\.revision_limit_escalated'/);
    assert.match(migration, /jsonb_build_object\('projectId', p_project_id, 'revisionCount', v_used, 'revisionLimit', v_limit\)/);
    assert.ok(SUBSCRIPTIONS['project.revision_limit_escalated']?.length === 1);
    const parsed = schema.revisionLimitEscalatedEventSchema.safeParse({ projectId: '11111111-1111-4111-8111-111111111111', revisionCount: 3, revisionLimit: 3 });
    assert.ok(parsed.success);
  });
  test('the verifier and both migrations exist', () => {
    assert.ok(existsSync(fileURLToPath(new URL('../scripts/verify-phase5-pm-depth.sql', import.meta.url))));
    assert.ok(existsSync(fileURLToPath(new URL('../supabase/migrations/20261102300000_a_client_review_share_is_the_exact_approved_build_and_is_recorded.sql', import.meta.url))));
  });
});

describe('the new readers never turn a failed read into an empty section', () => {
  for (const file of ['src/modules/projects/pm-depth-queries.ts', 'src/modules/portal/review-build-queries.ts']) {
    test(`${file}: every database read is followed by an unreadable() refusal`, () => {
      const source = read(file);
      const reads = (source.match(/\berror(?:: \w+)? \} = await supabase/g) ?? []).length;
      const refusals = (source.match(/if \(\w*[eE]rror\) unreadable\(/g) ?? []).length;
      assert.ok(reads >= 1);
      assert.equal(refusals, reads, `${file} has ${reads} reads and ${refusals} refusals`);
    });
  }
  test('the portal reader calls only the client-safe function, never the share table', () => {
    const source = read('src/modules/portal/review-build-queries.ts');
    assert.match(source, /rpc\('client_build_shares_for_client'/);
    assert.doesNotMatch(source, /from\('client_build_shares/);
  });
});
