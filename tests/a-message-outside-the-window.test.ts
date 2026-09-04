import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * A message outside the window — G-213.
 *
 * ── the finding ───────────────────────────────────────────────────────────
 *
 * WhatsApp carries a free-form message only within **24 hours of the
 * contact's last message**. Outside that, Meta accepts an approved TEMPLATE
 * and nothing else. This system had no template path at all, and its own
 * follow-up handler already named the consequence in a comment: *"a
 * plain-text follow-up past WhatsApp's 24-hour window → 400"*.
 *
 * ── the size of it ────────────────────────────────────────────────────────
 *
 * ADM-11's follow-up days are 2, 5, 8, 11, 14, 17, 20 and 7, 14, 21, 28, 35,
 * 42, 49. **Every one is outside the window.** And the twelve hundred
 * historical leads the reactivation work exists for last wrote months ago.
 *
 * It is stronger than "usually outside": for a situation defined by SILENCE
 * the window is *necessarily* shut, because a client who wrote within a day
 * has replied — and a reply stops the sequence. The live section proves that
 * pair directly.
 *
 * ── what is deliberately not built ────────────────────────────────────────
 *
 * The copy. A template's body is approved at Meta and lives there; this
 * records a name, a language and which facts fill its parameters. That is
 * precisely why it may be sent outside the window when free text may not —
 * somebody at Meta read it first.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SEND = codeOnly(read('src/lib/whatsapp/send.ts'));
const HANDLERS = codeOnly(read('src/modules/crm/handlers.ts'));
const MIGRATION = read('supabase/migrations/20260905140000_a_message_outside_the_window.sql');
const SQL = sqlCode(MIGRATION);

describe('A. the sender can say something Meta approved', () => {
  test('it sends type template, not text', () => {
    assert.match(SEND, /type: 'template',/);
    assert.match(SEND, /name: input\.templateName,/);
    assert.match(SEND, /language: \{ code: input\.languageCode \}/);
  });

  test('and it cannot say anything new — there is no body parameter', () => {
    // The property that makes this safe to run unattended against 1,200
    // people: the caller can only invoke something already approved.
    const signature = SEND.slice(SEND.indexOf('export async function sendWhatsAppTemplate'), SEND.indexOf('): Promise<SendResult>', SEND.indexOf('sendWhatsAppTemplate')));
    assert.ok(!/\bbody\b/.test(signature), 'a body argument would let a caller send unapproved words');
  });

  test('components are omitted entirely when there are no parameters', () => {
    // Meta refuses an empty components array on a template that declares no
    // variables — the commonest kind, and the first one an agency registers.
    // The ternary's empty branch is what proves it — matched across the
    // whole expression rather than within an arbitrary character budget,
    // which is what made the first version of this pin fail on formatting.
    assert.match(SEND, /parameters\.length > 0/);
    assert.match(SEND, /components: \[/);
    assert.match(SEND, /:\s*\{\},?\s*\)/);
  });

  test('a missing registration is permanent, not retried forever', () => {
    assert.match(SEND, /No approved template is registered for this situation\./);
  });
});

describe('B. the window is read from our own transcript', () => {
  test('it opens on THEIR message, not on ours', () => {
    assert.match(SQL, /where m\.conversation_id = p_conversation_id\s*\n\s*and m\.author_type = 'client'/);
  });

  test('and a contact who never wrote is SHUT, not open', () => {
    // `null > now()` is null, and a null read as "not false" would send to
    // every imported lead. The coalesce is the whole difference.
    assert.match(SQL, /coalesce\(crm\.window_open_until\(p_conversation_id\) > now\(\), false\)/);
  });
});

describe('C. what the follow-up does with it', () => {
  test('open window sends text, shut window looks for a template', () => {
    assert.match(HANDLERS, /if \(windowOpen === true\) \{[\s\S]{0,400}?sendWhatsAppText/);
    assert.match(HANDLERS, /sendWhatsAppTemplate\(\{/);
  });

  test('the lookup is scoped to the JOB’S organization', () => {
    /**
     * Load-bearing, and it was missing in the first version. This runs on the
     * admin client, which bypasses RLS — so without the filter one agency
     * sends another agency's approved template to its own client. The live
     * section caught it and red-proving by removing it reproduces it.
     */
    assert.match(HANDLERS, /\.from\('whatsapp_templates'\)[\s\S]{0,200}?\.eq\('organization_id', job\.organization_id\)/);
  });

  test('no template means SUPPRESSED — nothing is handed to Meta to refuse', () => {
    // Before this, an undeliverable send still spent an attempt and eventually
    // escalated as "the client ignored us". They ignored nothing.
    assert.match(HANDLERS, /outcome: 'suppressed'[\s\S]{0,160}?outside WhatsApp's 24-hour window/);
  });

  test('and the situation travels with the job rather than being re-derived', () => {
    const worker = codeOnly(read('src/modules/crm/follow-up-worker.ts'));
    assert.match(worker, /situationKey: seq\.situation_key,/);
  });
});

describe('D. the registry records a reference, never copy', () => {
  test('a name, a language and parameter NAMES', () => {
    assert.match(SQL, /template_name\s+text not null/);
    assert.match(SQL, /language_code\s+text not null/);
    assert.match(SQL, /parameters\s+text\[\] not null/);
  });

  test('and no column could hold a message body', () => {
    for (const invented of ['body', 'message_text', 'content', 'copy']) {
      assert.ok(
        !new RegExp(`\\n\\s+${invented}\\s+text`).test(SQL),
        `${invented} would be copy nobody at Meta approved`,
      );
    }
  });

  test('one live template per situation, so the sender never chooses', () => {
    // Choosing between approved templates is a marketing decision.
    assert.match(SQL, /create unique index if not exists whatsapp_templates_situation_key[\s\S]{0,160}?where active/);
  });

  test('registering one is admin-only in the database and audited', () => {
    assert.match(SQL, /if v_actor is not null and not \(select core\.is_admin\(\)\) then/);
    assert.match(SQL, /whatsapp_template\.set/);
    assert.match(SQL, /whatsapp_template\.withdrawn/);
  });

  test('and withdrawing deactivates rather than deletes', () => {
    assert.match(SQL, /update crm\.whatsapp_templates set active = false/);
  });
});
