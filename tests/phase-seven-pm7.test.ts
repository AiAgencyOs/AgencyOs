import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import {
  deploymentApprovedAnnouncementFor, handoverReadyAnnouncementFor, PM_TEMPLATES, phaseSevenReadyAnnouncementFor, pmTemplateFor, productionValidatedAnnouncementFor,
  productionValidationFailedAnnouncementFor, projectCompletedAnnouncementFor,
} from '../src/modules/crm/schema.ts';

/** Phase 7 PM spec (P702): the PM communicates authoritative state and never creates it. Every message is versioned, client-safe, wired end to end and never claims more than its fact. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const ROUTE = read('app/api/jobs/run/route.ts');
const HANDLERS_TS = read('src/modules/crm/handlers.ts');

const WIRING = [
  ['project.phase_seven_ready', 'crm:announcePhaseSevenReady', 'phase_seven_ready.announce', 'announcePhaseSevenReady'],
  ['project.deployment_approved', 'crm:announceDeploymentApproved', 'deployment_approved.announce', 'announceDeploymentApproved'],
  ['project.production_validated', 'crm:announceProductionValidated', 'production_validated.announce', 'announceProductionValidated'],
  ['project.production_validation_failed', 'crm:announceProductionValidationFailed', 'production_validation_failed.announce', 'announceProductionValidationFailed'],
  ['project.handover_delivered', 'crm:announceHandoverReady', 'handover_ready.announce', 'announceHandoverReady'],
  ['project.completed', 'crm:announceProjectCompleted', 'project_completed.announce', 'announceProjectCompleted'],
] as const;

describe('each PM7 announcer is wired end to end', () => {
  for (const [event, handler, kind, fn] of WIRING) {
    test(`${event} -> ${handler}`, () => {
      assert.ok(SUBSCRIPTIONS[event]?.includes(handler), 'subscribed');
      assert.equal(HANDLER_JOB_KIND[handler], kind, 'job kind');
      assert.ok((HANDLERS as readonly string[]).includes(handler), 'in HANDLERS');
      assert.match(ROUTE, new RegExp(`runEventJobs\\(admin, [A-Z_]+, ${fn},`), 'a runner block drains it');
      assert.match(HANDLERS_TS, new RegExp(`export async function ${fn}\\(`), 'the handler exists');
    });
  }
  test('the Phase 7 workspace opens on Phase6Completed and on M4PaymentVerified, and a closed rollback incident redeploys', () => {
    assert.ok(SUBSCRIPTIONS['project.phase_six_completed']?.includes('projects:openPhaseSeven'));
    assert.ok(SUBSCRIPTIONS['project.m4_payment_verified']?.includes('projects:openPhaseSeven'));
    assert.deepEqual(SUBSCRIPTIONS['project.deployment_approved']?.filter((h) => h.startsWith('projects:')), ['projects:runDeployment', 'projects:routePhaseSevenTask']);
    assert.ok(SUBSCRIPTIONS['project.deployment_incident_closed']?.includes('projects:runDeployment'));
    assert.match(ROUTE, /runEventJobs\(admin, PHASE_SEVEN_OPEN_JOB_KIND, handleOpenPhaseSeven,/);
    assert.match(ROUTE, /runEventJobs\(admin, PHASE_SEVEN_DEPLOY_JOB_KIND, handleRunDeployment,/);
  });
});

describe('every PM7 externalRef prefix is a versioned template', () => {
  test('the announcers key their message on the fact, and the prefix has a template version', () => {
    for (const prefix of ['phase-seven-ready', 'deployment-approved', 'production-validated', 'production-validation-failed', 'handover-ready', 'project-completed']) {
      assert.match(HANDLERS_TS, new RegExp(`externalRef: \`${prefix}:`), `${prefix} is written by an announcer`);
      assert.ok(PM_TEMPLATES[prefix], `no template version for ${prefix}`);
      assert.equal(PM_TEMPLATES[prefix]?.version, 1);
    }
    assert.deepEqual(pmTemplateFor('handover-ready:abc'), { milestone: 'PM7-HANDOVER-READY', version: 1 });
    assert.equal(PM_TEMPLATES['phase-seven-ready']?.milestone, 'PM7-M01');
  });
  test('a duplicate ProjectCompleted is ONE announcement: the key is the project, not the event', () => {
    assert.match(HANDLERS_TS, /externalRef: `project-completed:\$\{parsed\.data\.projectId\}`/);
    assert.match(HANDLERS_TS, /externalRef: `phase-seven-ready:\$\{parsed\.data\.projectId\}`/);
  });
});

describe('the messages are client-safe and never claim more than the fact', () => {
  const texts = {
    ready: phaseSevenReadyAnnouncementFor({ projectName: 'Shop' }),
    approved: deploymentApprovedAnnouncementFor({ projectName: 'Shop' }),
    validated: productionValidatedAnnouncementFor({ projectName: 'Shop' }),
    failed: productionValidationFailedAnnouncementFor({ projectName: 'Shop' }),
    handover: handoverReadyAnnouncementFor({ projectName: 'Shop', version: 3 }),
    completed: projectCompletedAnnouncementFor({ projectName: 'Shop' }),
  };
  test('none names a model, a provider, a branch, a commit, an agent key, a stack trace or a secret', () => {
    for (const [name, t] of Object.entries(texts)) {
      assert.doesNotMatch(t, /claude|gpt|openai|anthropic|openrouter|branch|deployment_agent|release_qa|incident_recovery|stack trace|sk-|token|password|secret key|[0-9a-f]{40}/i, name);
    }
  });
  test('P702-T002: a started or approved deployment is never called live, deployed or complete', () => {
    assert.doesNotMatch(texts.ready, /\b(is|are|was) (live|deployed|released)\b/i);
    assert.match(texts.ready, /Nothing has been deployed yet/);
    assert.match(texts.approved, /Approval is not deployment/);
    assert.doesNotMatch(texts.approved, /\b(is|was) (live|deployed)\b/i);
  });
  test('P702-T003: a failed check never says production validated, and names no cause', () => {
    assert.doesNotMatch(texts.failed, /production (was )?validated/i);
    assert.match(texts.failed, /do not call the release verified/i);
    assert.doesNotMatch(texts.failed, /exception|error:|500|timeout/i);
  });
  test('P702-T006: a casual "looks good" is not acceptance; credentials never travel in chat', () => {
    assert.match(texts.handover, /looks good/);
    assert.match(texts.handover, /not acceptance/);
    assert.match(texts.handover, /Credentials are never sent in chat/);
    assert.match(texts.handover, /v3/);
  });
  test('completion is stated only from the completion record, and says the project is not complete earlier', () => {
    assert.match(texts.completed, /completion record/);
    assert.match(texts.validated, /not complete yet/);
  });
  test('the project name is the only thing the template inserts about the project', () => {
    assert.match(phaseSevenReadyAnnouncementFor({ projectName: null }), /an unnamed project/);
  });
});
