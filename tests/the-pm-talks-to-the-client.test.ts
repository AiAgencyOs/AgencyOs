import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'node:test';

import { HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import {
  pmAdvanceVerified, pmBillingQuestion, pmGstDetailsRequest, pmKickoff, pmPaymentNeedsAttention,
  pmPaymentReceived, pmPaymentVerified, pmWelcome, type PmLanguage,
} from '../src/modules/projects/pm-messages.ts';

mock.module('../src/modules/crm/system-message.ts', { namedExports: { sendSystemText: async () => ({ kind: 'sent', messageId: 'm' }) } });
mock.module('../src/modules/projects/handlers.ts', { namedExports: {} });
const { readBillingAnswer } = await import('../src/modules/projects/pm-client-comms.ts');

const read = (p: string) => readFileSync(p, 'utf8');
const LANGUAGES: PmLanguage[] = ['en', 'hinglish', 'hindi'];

// Phase 2 PM §6, §14: the PM speaks to the client during onboarding in
// templates, in the client's language, never promising what the system does not
// hold. Proved against the running app in scripts/verify-pm-client-comms.mjs.

describe('what the PM says', () => {
  const all = (language: PmLanguage) => [
    pmWelcome({ language, agencyName: 'Demo Agency', projectName: 'Pharmacy app' }),
    pmBillingQuestion(language), pmGstDetailsRequest(language), pmPaymentReceived(language), pmAdvanceVerified(language),
    pmPaymentVerified(language, 'INV-7'), pmPaymentNeedsAttention(language, 'INV-7'), pmKickoff(language),
  ];

  test('every message exists in all three languages, and Hindi is in Devanagari', () => {
    for (const language of LANGUAGES) for (const m of all(language)) assert.ok(m.trim().length > 20, `${language}: empty`);
    for (const m of all('hindi')) assert.match(m, /[ऀ-ॿ]/, m);
    for (const m of all('hinglish')) assert.doesNotMatch(m, /[ऀ-ॿ]/, `Hinglish stays in Roman letters: ${m}`);
  });

  test('no message names an amount, a date, a model or a provider', () => {
    for (const language of LANGUAGES) {
      for (const m of all(language)) {
        assert.doesNotMatch(m, /[₹$]|\brs\.?\s*\d|\binr\b|\d{2,}/i, `an amount or date: ${m}`);
        assert.doesNotMatch(m, /claude|anthropic|openai|gpt|\bai\b|model|provider/i, `internal detail: ${m}`);
      }
    }
  });

  test('the billing question is the specification\'s own sentence', () => {
    assert.equal(pmBillingQuestion('en'), 'For billing, please confirm whether you need a GST invoice or a Non-GST invoice.');
    assert.equal(pmPaymentReceived('en'), 'We have received your payment details. We are verifying them and will update you shortly.');
    assert.equal(pmKickoff('en'), 'Your advance payment has been verified and the project setup is complete. We are officially starting your project now.');
  });

  test('a rejection says only that it could not be matched - never why', () => {
    for (const language of LANGUAGES) assert.doesNotMatch(pmPaymentNeedsAttention(language, 'INV-7'), /reject|mismatch|reason|wrong|fraud/i);
  });
});

describe('reading the client\'s billing answer', () => {
  const cases: Array<[string, 'gst' | 'non_gst' | null]> = [
    ['GST', 'gst'], ['GST invoice chahiye', 'gst'], ['gst please', 'gst'], ['जीएसटी चाहिए', 'gst'],
    ['Non-GST', 'non_gst'], ['non gst invoice', 'non_gst'], ['nongst', 'non_gst'], ['without GST', 'non_gst'],
    ['GST nahi chahiye', 'non_gst'], ['bina gst ke', 'non_gst'], ['no gst', 'non_gst'],
    ['kya GST zaruri hai?', null], ['GST or non-GST?', null], ['I am not sure', null], ['', null],
    ['gst aur non gst dono', null],
    ['x'.repeat(200) + ' gst', null],
  ];
  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text.slice(0, 40))} -> ${expected}`, () => assert.equal(readBillingAnswer(text), expected));
  }
});

describe('what is wired', () => {
  test('the welcome rides the handoff beside the start; GST details ride the confirmed mode; payments ride all four payment events', () => {
    assert.ok(SUBSCRIPTIONS['project.handoff_bound']?.includes('projects:welcomeClient'));
    assert.ok(SUBSCRIPTIONS['project.billing_mode_confirmed']?.includes('projects:askGstDetails'));
    for (const e of ['payment.submitted', 'payment.verified', 'payment.rejected', 'payment.mismatched']) {
      assert.deepEqual(SUBSCRIPTIONS[e], ['projects:updateClientOnPayment'], e);
    }
    assert.ok(SUBSCRIPTIONS['message.received']?.includes('projects:readBillingReply'));
    for (const h of ['projects:welcomeClient', 'projects:askGstDetails', 'projects:updateClientOnPayment', 'projects:readBillingReply']) {
      assert.ok(HANDLER_JOB_KIND[h as keyof typeof HANDLER_JOB_KIND], h);
    }
  });

  test('the runner drains all four, and each is a handler with a caller', () => {
    const route = read('app/api/jobs/run/route.ts');
    for (const fn of ['handleWelcomeClient', 'handleAskGstDetails', 'handlePaymentUpdate', 'handleReadBillingReply']) {
      assert.match(route, new RegExp(`${fn},\\s*\\n?\\s*'run`), fn);
    }
  });

  test('billing mode stays a person\'s act: the PM code never calls the confirming door', () => {
    // Code only: the file's comments explain WHY it does not call the door.
    const src = read('src/modules/projects/pm-client-comms.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /confirm_billing_mode|confirmBillingMode/);
    assert.match(src, /raise_alert/);
  });

  test('every PM message goes through the once-only sender, with a stable reference', () => {
    const src = read('src/modules/projects/pm-client-comms.ts');
    assert.equal((src.match(/sendSystemText\(/g) ?? []).length, 4);
    for (const ref of ['pm:welcome:', 'pm:billing-question:', 'pm:gst-details:', 'pm:payment:']) assert.ok(src.includes(ref), ref);
  });

  test('the kickoff button sends to the project group, checks readiness first, and records the sent message as evidence', () => {
    const src = read('src/modules/projects/kickoff-send.ts');
    const at = src.indexOf('export async function sendKickoffAndRecord');
    const body = src.slice(at);
    assert.ok(body.indexOf('pre_kickoff_readiness') < body.indexOf('sendClientMessage('), 'readiness must be checked before anything is sent');
    assert.match(body, /kind', 'project_group'/);
    assert.match(body, /recordKickoff\(\{ projectId: input\.projectId, evidenceRef: `pm:kickoff:/);
  });
});
