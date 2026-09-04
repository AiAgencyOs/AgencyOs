import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * Which template, and in whose language — gap G-217.
 *
 * Two omissions, and they are the same one twice: nothing recorded WHICH
 * template carried a message, so nothing could say which ones work; and
 * nothing chose BETWEEN templates, so an agency serving Hindi and English
 * clients had to pick one language for everybody.
 *
 * The behaviour is proved against a real Postgres by `verify-outbound-window`
 * §14–§15 and, for the recording, by `verify-follow-up-delivery` §6 — the only
 * place a real handler sends a real template. What is here is the shape of the
 * rule and the decisions it deliberately does not make.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260906150000_which_template_and_in_whose_language.sql'));
const RAW = read('supabase/migrations/20260906150000_which_template_and_in_whose_language.sql');

describe('A. a situation holds one template per language', () => {
  test('the live slot is keyed by language', () => {
    assert.match(
      SQL,
      /whatsapp_templates_situation_key[\s\S]{0,200}?\(organization_id, situation_key, language_code\)[\s\S]{0,120}?where active and status = 'approved'/,
    );
  });

  test('and registering one language cannot overwrite another', () => {
    const fn = SQL.slice(SQL.indexOf('function crm.set_whatsapp_template'), SQL.indexOf('comment on function crm.set_whatsapp_template'));
    assert.match(fn, /lower\(t\.language_code\) = lower\(btrim\(p_language_code\)\)/);
  });

  test('withdrawing without naming a language withdraws nothing when two exist', () => {
    // An unasked question beats a wrong answer about what a client stops
    // receiving.
    const fn = SQL.slice(SQL.indexOf('function crm.clear_whatsapp_template'), SQL.indexOf('comment on function crm.clear_whatsapp_template'));
    assert.match(fn, /p_language_code is null or lower\(t\.language_code\) = lower\(btrim\(p_language_code\)\)/);
  });
});

describe('B. the choice is a rule, not a ranking', () => {
  const chooser = SQL.slice(SQL.indexOf('function crm.template_for'), SQL.indexOf('comment on function crm.template_for'));

  test('their own language first', () => {
    assert.match(chooser, /lower\(t\.language_code\) like \(\(select lang from wanted\) \|\| '%'\)/);
  });

  test('then English, as this deployment’s shared fallback', () => {
    assert.match(chooser, /lower\(t\.language_code\) like 'en%'/);
  });

  test('then oldest, so the answer is stable rather than whatever the planner returned', () => {
    assert.match(chooser, /t\.created_at\s*\n?\s*limit 1/);
  });

  /**
   * The absence that matters most, with its positive twin above. ADM-88
   * refused a lead score because a number that ranks is a number that
   * decides; choosing which approved message a client receives on last
   * month's reply rate is the same decision wearing a different hat, and
   * nobody has made it.
   */
  test('and nothing in the chooser reads performance', () => {
    assert.doesNotMatch(chooser, /replied|read|delivered|performance/);
  });

  test('the fallback is recorded, so a missing translation is visible', () => {
    assert.match(chooser, /matched_language/);
  });
});

describe('C. performance is derived, never counted', () => {
  const view = RAW.slice(RAW.indexOf('create or replace view crm.whatsapp_template_performance'), RAW.indexOf('comment on view'));

  test('every figure comes from a column written for another reason', () => {
    // Meta's own receipts (G-C10) and the client's own replies. Nothing here
    // is a counter, so there is nothing to drift and nothing to backfill.
    assert.match(view, /m\.metadata->>'wire_status'/);
    assert.match(view, /r\.author_type = 'client'/);
  });

  test('read implies delivered, because the wire states are monotonic', () => {
    assert.match(view, /wire_status' in \('delivered', 'read'\)/);
  });

  test('a reply is on the same thread and within seven days', () => {
    // Same thread, because attributing a reply across threads would credit a
    // template for a conversation it had no part in. Seven days, because a
    // reply three weeks later is an answer to something else.
    assert.match(view, /r\.conversation_id = m\.conversation_id/);
    assert.match(view, /interval '7 days'/);
  });

  test('and it is a view, so it cannot disagree with the transcript', () => {
    assert.doesNotMatch(SQL, /create table[\s\S]{0,80}whatsapp_template_performance/);
  });

  test('read through the caller’s own permissions, not the definer’s', () => {
    assert.match(RAW, /with \(security_invoker = true\)/);
  });
});

describe('D. what carried the message travels with it', () => {
  test('the template id is written at send time', () => {
    const fn = SQL.slice(SQL.indexOf('function crm.mark_message_as_outreach'), SQL.indexOf('comment on function crm.mark_message_as_outreach'));
    assert.match(fn, /jsonb_build_object\('template_id', p_template_id\)/);
  });

  test('and the form that could not say so is gone', () => {
    // A send that does not record what carried it is the state this gap
    // exists to end, so the one-argument function is dropped rather than
    // left as a quieter way to do the wrong thing.
    assert.match(SQL, /drop function if exists crm\.mark_message_as_outreach\(uuid\);/);
  });
});
