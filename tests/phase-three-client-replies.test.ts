import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import {
  AUTO_APPLY_INTENTS,
  PERSON_ONLY_INTENTS,
  REPLY_INTENTS,
  decideReplyAction,
  designReplyBrief,
  fallbackClarification,
  isAcknowledgement,
  isPlainYes,
  type ReplyIntent,
} from '../src/modules/projects/design-reply.ts';
import { designReplySchema } from '../src/modules/projects/schema.ts';

const read = (p: string) => readFileSync(p, 'utf8');
const migration = read('supabase/migrations/20261012200000_a_client_reply_is_read_before_it_is_acted_on.sql');

// Phase 3 PM §4.5-§4.9. The PM reads a client's reply; what it may do ALONE is the reversible set, and the
// two acts that lock the design or stop the phase are a person's - in code AND in the database.

const base = { confidence: 0.95, themeShown: true, sharedOptionCount: 2, hasReference: true };

describe('what the PM may do on its own, and what it may never', () => {
  test('the final confirmation and a possible scope change are never applied, at any confidence', () => {
    for (const intent of PERSON_ONLY_INTENTS) {
      for (const confidence of [0.5, 0.99, 1]) assert.equal(decideReplyAction({ ...base, intent, confidence }), 'person', `${intent} @ ${confidence}`);
    }
  });

  test('the reversible set is applied only when the reading is sure AND names something the client was shown', () => {
    assert.equal(decideReplyAction({ ...base, intent: 'client_selected' }), 'apply');
    assert.equal(decideReplyAction({ ...base, intent: 'client_selected', themeShown: false }), 'clarify', 'a choice nobody was shown is asked about, not applied');
    assert.equal(decideReplyAction({ ...base, intent: 'client_selected', confidence: 0.6 }), 'person', 'an unsure reading is a person\'s');
    assert.equal(decideReplyAction({ ...base, intent: 'design_change_request', themeShown: false, sharedOptionCount: 1 }), 'apply', 'one option shared -> it is the one they mean');
    assert.equal(decideReplyAction({ ...base, intent: 'design_change_request', themeShown: false, sharedOptionCount: 3 }), 'clarify', 'several options -> ask which');
    assert.equal(decideReplyAction({ ...base, intent: 'client_reference', hasReference: false }), 'person', 'a reference with nothing to look at is not recorded');
    assert.equal(decideReplyAction({ ...base, intent: 'clarification_required' }), 'apply');
  });

  test('unclear is a question back to the client, unrelated is left alone', () => {
    assert.equal(decideReplyAction({ ...base, intent: 'unclear' }), 'clarify');
    assert.equal(decideReplyAction({ ...base, intent: 'unrelated' }), 'ignore');
  });

  test('every intent has a decision, and the apply set is exactly the four reversible ones', () => {
    for (const intent of REPLY_INTENTS) assert.ok(['apply', 'person', 'clarify', 'ignore'].includes(decideReplyAction({ ...base, intent })), intent);
    assert.deepEqual([...AUTO_APPLY_INTENTS].sort(), ['clarification_required', 'client_reference', 'client_selected', 'design_change_request']);
    assert.ok(AUTO_APPLY_INTENTS.every((i: ReplyIntent) => !PERSON_ONLY_INTENTS.includes(i)));
  });

  test('the database holds the same line without trusting the code: a CHECK, and the proposal door downgrades', () => {
    assert.match(migration, /design_reply_apply_is_the_safe_set[\s\S]{0,200}intent in \('client_selected', 'design_change_request', 'client_reference', 'clarification_required'\)/);
    assert.match(migration, /if p_intent in \('final_confirmed', 'possible_scope_change'\) and v_action = 'apply' then v_action := 'person'/);
  });

  test('an agent-applied decision never carries a person\'s name, and exactly one recorder is set', () => {
    assert.match(migration, /client_decisions_has_a_recorder\s+check \(\(recorded_by is not null\) <> \(recorded_by_agent is not null\)\)/);
    assert.match(migration, /recorded_by_agent\)\s+values[\s\S]{0,400}'project_manager'/);
  });
});

describe('the cheap path costs nothing', () => {
  test('thanks and a thumbs-up need no reading; a real sentence does', () => {
    for (const t of ['Thanks!', 'ok', 'Thank you 🙏', '👍', 'shukriya', 'noted']) assert.equal(isAcknowledgement(t), true, t);
    for (const t of ['thanks but can we change the colour', 'ok what about the logo', 'I like the second one']) assert.equal(isAcknowledgement(t), false, t);
  });

  test('a plain yes (English, Hinglish, Hindi) is recognised - and anything with a "but" or a question is not', () => {
    for (const t of ['Yes', 'yes, confirmed', 'Confirmed!', 'haan theek hai', 'ji bilkul', 'हाँ', 'Yes go ahead', 'approved ✅']) assert.equal(isPlainYes(t), true, t);
    for (const t of ['yes but change the logo', 'yes?', 'not yet', 'nahi', 'yes and also add a chat', 'I like option 2', 'confirmed but instead use blue']) assert.equal(isPlainYes(t), false, t);
  });
});

describe('what the model is given and what it may return', () => {
  test('the options are numbered and named, with no id the model could copy or invent', () => {
    const brief = designReplyBrief([{ index: 2, name: 'Bold', palettes: ['Bold Indigo'] }, { index: 1, name: 'Calm', palettes: [] }], 'I like the first', 'selection');
    assert.match(brief, /1\. Calm\n2\. Bold \(colour: Bold Indigo\)/);
    assert.doesNotMatch(brief, /[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test('a reading is schema-strict: an unknown intent, an out-of-range option or an unbounded confidence is refused', () => {
    const ok = { intent: 'client_selected', optionNumber: 2, evidence: 'the second', confidence: 0.9, reasoning: 'picks 2' };
    assert.equal(designReplySchema.safeParse(ok).success, true);
    for (const bad of [{ ...ok, intent: 'approve_everything' }, { ...ok, optionNumber: 9 }, { ...ok, confidence: 1.5 }, { ...ok, extra: 1 }, { ...ok, evidence: '' }]) {
      assert.equal(designReplySchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  test('the clarifying fallback is in the client\'s language and names the options', () => {
    assert.match(fallbackClarification('en', ['1. Calm', '2. Bold']), /which option you mean \(1\. Calm \/ 2\. Bold\)/);
    assert.match(fallbackClarification('hinglish', []), /Kripya bata dijiye/);
    assert.match(fallbackClarification('hindi', []), /कृपया बताइए/);
  });
});

describe('it is wired, not just written', () => {
  test('message.received reaches the reader and the job kind exists', () => {
    assert.ok(SUBSCRIPTIONS['message.received']?.includes('project_manager:readDesignReply'));
    assert.equal(HANDLER_JOB_KIND['project_manager:readDesignReply'], 'design.read_reply');
  });

  test('the workflow is registered and listens only while Phase 3 waits on the client', () => {
    const wf = read('app/api/jobs/run/workflows.ts');
    assert.match(wf, /\n {2}READ_DESIGN_REPLY,\n/);
    assert.match(wf, /\['waiting_client', 'client_review', 'final_confirmation', 'revision'\]\.includes\(phase\.state\)/);
  });

  test('the workflow reads each message once and applies only through the service-role door', () => {
    const wf = read('app/api/jobs/run/workflows.ts');
    const start = wf.indexOf('const READ_DESIGN_REPLY');
    const body = wf.slice(start, wf.indexOf('// ui_prototype', start));
    assert.match(body, /from\('design_reply_proposals'\)\.select\('id'\)\.eq\('message_id', msg\.id\)/);
    assert.match(body, /rpc\('agent_apply_design_reply'/);
    assert.doesNotMatch(body, /rpc\('record_client_design_decision'|rpc\('open_design_revision'/);
  });

  test('the Admin page shows the inbox and a person can act on a waiting reply', () => {
    assert.match(read('app/(internal)/projects/[projectId]/design/page.tsx'), /<ReplyInbox/);
    assert.match(read('src/modules/projects/design-reply-service.ts'), /rpc\('accept_design_reply_proposal'/);
    assert.match(read('src/modules/projects/design-reply-service.ts'), /rpc\('dismiss_design_reply_proposal'/);
  });

  test('the agent doors are callable by the service role alone', () => {
    for (const fn of ['agent_propose_design_reply', 'agent_apply_design_reply', 'agent_mark_design_reply_asked']) {
      assert.match(migration, new RegExp(`revoke all on function projects\\.${fn}\\([^)]*\\) from public, anon, authenticated`), fn);
      assert.match(migration, new RegExp(`grant execute on function projects\\.${fn}\\([^)]*\\) to service_role`), fn);
    }
  });
});
