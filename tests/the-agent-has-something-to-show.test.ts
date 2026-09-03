import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

import { clientReplySchema } from '../src/modules/crm/schema.ts';

/**
 * The agent has something to show — G-197 (ADM-12, §5.3; audit SA-08).
 *
 * ── the finding ───────────────────────────────────────────────────────────
 *
 * `crm.portfolio_items` has existed since 2026-08-14 and its own migration
 * header says what it deliberately did not do: *"It sends nothing. Selecting
 * an item and putting it in front of a client is G-013 part 3, which needs
 * the agent architecture and — because a sample reaching a client is client
 * communication — ADM-70's consent gate. Neither exists."*
 *
 * Both exist now. What was left was a `count`: the agent was told *"there is
 * approved past work you may offer to show (4 items)"* and could not name any
 * of it, and nothing could be sent. So a client who said yes got a sentence
 * about a portfolio that never arrived — **an agency that offers to show
 * something it cannot send has told the client its first lie.**
 *
 * ── the control is the lookup, not the prompt ─────────────────────────────
 *
 * §5.3 permits sending samples *"only from a list the Admin maintains"*. The
 * way to enforce that is not to ask a model to behave. It is never to hand it
 * a URL — the file carries refs, titles and kinds and no addresses — and to
 * resolve what it hands back against the table, scoped to the organization
 * and to active rows.
 *
 * So a hallucinated ref sends nothing, and a URL written in prose is prose:
 * no address was ever put in front of the model to copy.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));

describe('A. what the agent is given — items, and no addresses', () => {
  test('the read takes the items, not a count', () => {
    assert.match(WORKFLOWS, /\.select\('id, kind, title, description'\)[\s\S]{0,200}?\.eq\('is_active', true\)/);
    assert.ok(!WORKFLOWS.includes("count: 'exact', head: true }).eq('organization_id', job.organization_id).eq('is_active', true)"));
  });

  test('and NO url is among them — the one thing a model must not invent', () => {
    // The whole control in one assertion: what is not selected cannot be
    // copied into prose. Both reads of the table are enumerated, because
    // asserting on "the first one" is asserting on file order — and the
    // resolver's read, which DOES take the url, sits above this one.
    const selects = [...WORKFLOWS.matchAll(/portfolio_items'\)\s*\.select\('([^']+)'\)/g)].map((m) => m[1] ?? '');
    assert.equal(selects.length, 2, 'exactly two reads of the list: the file’s and the resolver’s');
    const withUrl = selects.filter((columns) => columns.includes('url'));
    assert.equal(withUrl.length, 1, 'exactly one read may take an address');
    assert.equal(withUrl[0], 'id, title, url', 'and it is the resolver’s, which the model never sees');
    const forTheModel = selects.find((columns) => !columns.includes('url'));
    assert.equal(forTheModel, 'id, kind, title, description');
  });

  test('org-scoped, active-only, in the Admin’s own order, and bounded', () => {
    assert.match(WORKFLOWS, /\.order\('position'\)\.order\('created_at'\)\s*\.limit\(12\)/);
  });

  test('the file names each item by ref, kind and title', () => {
    assert.match(WORKFLOWS, /\[\$\{item\.ref\}\] \$\{item\.kind\.replace\('_', ' '\)\} — \$\{item\.title\}/);
  });

  test('and an empty list says so, plainly', () => {
    // "We can show you similar work" with nothing to send is the promise the
    // count was originally chosen to avoid, and then caused anyway.
    assert.match(WORKFLOWS, /There is NO approved past work to show\. Do not offer samples, demos or a portfolio/);
    assert.match(WORKFLOWS, /leave `show` empty/);
  });
});

describe('B. what the agent may hand back — refs, never links', () => {
  test('a ref is exactly eight hex characters', () => {
    const ok = clientReplySchema.safeParse({ reply: 'Here you go.', handToHuman: null, show: ['0a1b2c3d'] });
    assert.equal(ok.success, true);
    assert.deepEqual(ok.data?.show, ['0a1b2c3d']);
  });

  test('a URL in that field is refused by the shape itself', () => {
    const url = clientReplySchema.safeParse({
      reply: 'Here you go.',
      handToHuman: null,
      show: ['https://example.invalid/work'],
    });
    assert.equal(url.success, false);
  });

  test('at most three — a client asked for proof, not a catalogue', () => {
    const many = clientReplySchema.safeParse({
      reply: 'Here you go.',
      handToHuman: null,
      show: ['00000001', '00000002', '00000003', '00000004'],
    });
    assert.equal(many.success, false);
  });

  test('and omitting it is the same as sending nothing', () => {
    const none = clientReplySchema.safeParse({ reply: 'Hello.', handToHuman: null });
    assert.equal(none.success, true);
    assert.deepEqual(none.data?.show, []);
  });
});

describe('C. the lookup is the control', () => {
  test('refs are resolved against the table, org-scoped and active-only', () => {
    assert.match(WORKFLOWS, /async function portfolioLinksFor\(/);
    assert.match(
      WORKFLOWS,
      /from\('portfolio_items'\)\s*\.select\('id, title, url'\)\s*\.eq\('organization_id', organizationId\)\s*\.eq\('is_active', true\)/,
    );
  });

  test('the ref is matched the same way it was minted', () => {
    // Two slices, one meaning: a mismatch here would make every ref miss.
    assert.match(WORKFLOWS, /ref: String\(item\.id\)\.slice\(0, 8\)/);
    assert.match(WORKFLOWS, /String\(row\.id\)\.slice\(0, 8\)/);
  });

  test('a ref that matches nothing sends nothing, and is logged', () => {
    // Dropped rather than fatal: the message is already written and worth
    // sending, and refusing it would cost the client an answer to punish the
    // model.
    assert.match(WORKFLOWS, /no such item: \$\{missed\.join\(', '\)\}/);
    assert.match(WORKFLOWS, /if \(!row\) \{\s*missed\.push\(ref\);\s*continue;/);
  });

  test('a failed read attaches nothing rather than guessing', () => {
    assert.match(WORKFLOWS, /scope: 'portfolioLinksFor'/);
  });

  test('nothing is read at all when the model asked for nothing', () => {
    assert.match(WORKFLOWS, /if \(refs\.length === 0\) return \[\];/);
  });
});

describe('D. what the client receives', () => {
  test('the links are appended to the body the ROW guard sees', () => {
    // Before send_outbound_message, so consent, the sequence and the money
    // guard all apply to the whole message — an Admin whose item title names
    // an amount is refused exactly as the model would have been.
    const attach = WORKFLOWS.indexOf('const shown = await portfolioLinksFor(');
    const send = WORKFLOWS.indexOf("rpc('send_outbound_message'", attach);
    assert.ok(attach > 0 && send > attach, 'the links must be attached before the chokepoint');
    assert.match(WORKFLOWS, /p_body: body,/);
  });

  test('and the locally stored message is the same text the client got', () => {
    // Two different bodies would make the transcript a record of something
    // nobody sent.
    assert.match(WORKFLOWS, /\n {6}body,\n/);
  });

  test('nothing is appended when nothing resolved', () => {
    assert.match(WORKFLOWS, /shown\.length > 0\s*\?[\s\S]{0,160}?: validated\.data\.reply/);
  });
});

describe('E. the prompt says the rule the lookup enforces', () => {
  test('never write a URL, never describe work that is not on the list', () => {
    assert.match(WORKFLOWS, /NEVER write a URL yourself/);
    assert.match(WORKFLOWS, /has told the client its first lie/);
  });

  test('and nothing to show means no portfolio is mentioned at all', () => {
    assert.match(WORKFLOWS, /`show` is empty and you do not mention a portfolio/);
  });
});
