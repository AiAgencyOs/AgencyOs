import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  defaultTemplateText,
  PM_LANGUAGES,
  PM_TEMPLATES,
  pmTemplateProblem,
  renderPmTemplate,
  templateDefinition,
  type PmTemplateKey,
} from '../src/modules/projects/pm-template-model.ts';
import { resolvePmText } from '../src/modules/projects/pm-template-resolve.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const migration = read('supabase/migrations/20261204200000_p1s_a_pm_client_message_template_is_edited_as_versions_and_goes_live_only_when_an_admin_approves.sql');

/**
 * P2-PM-006 / P2-FLOW-026: the PM's client messages are editable templates that go live only on an Admin's approval. The wording in code is untouched; a
 * sender uses an approved override when one exists and otherwise exactly what it always said.
 */

describe('the registry and the database agree', () => {
  test('the SQL registry lists exactly the templates the code lists, with the same placeholders and required ones', () => {
    const block = /from \(values([\s\S]*?)\) as t\(template_key, allowed, required\)/.exec(migration);
    assert.ok(block, 'registry block');
    const rows = [...block![1]!.matchAll(/\('(\w+)',\s*array\[([^\]]*)\](?:::text\[\])?,\s*array\[([^\]]*)\](?:::text\[\])?\)/g)].map((m) => ({
      key: m[1]!,
      allowed: [...(m[2] ?? '').matchAll(/'(\w+)'/g)].map((x) => x[1]!),
      required: [...(m[3] ?? '').matchAll(/'(\w+)'/g)].map((x) => x[1]!),
    }));
    assert.deepEqual(rows.map((r) => r.key), PM_TEMPLATES.map((t) => t.key));
    for (const r of rows) {
      const t = templateDefinition(r.key)!;
      assert.deepEqual(r.allowed, [...t.placeholders], `${r.key} placeholders`);
      assert.deepEqual(r.required, [...t.required], `${r.key} required`);
    }
  });

  test('the table\'s CHECK list is the same list', () => {
    const check = /template_key\s+text not null check \(template_key in \(([^)]*)\)\)/.exec(migration);
    assert.ok(check);
    assert.deepEqual([...check![1]!.matchAll(/'(\w+)'/g)].map((m) => m[1]), PM_TEMPLATES.map((t) => t.key));
  });
});

describe('the wording in code is itself a valid template (so the rules are not stricter than what the PM already says)', () => {
  for (const t of PM_TEMPLATES) {
    for (const language of PM_LANGUAGES) {
      test(`${t.key} / ${language}`, () => {
        const text = defaultTemplateText(t.key as PmTemplateKey, language);
        assert.equal(pmTemplateProblem(t.key, language, text), null, text);
        for (const need of t.required) assert.ok(text.includes(`{${need}}`), `${need} appears in the default`);
      });
    }
  }
});

describe('the rules, mirrored from the database', () => {
  const cases: Array<[string, string, RegExp | null]> = [
    ['welcome', 'Welcome to {agencyName}, we will look after {projectName} together.', null],
    ['welcome', 'Welcome, never send passwords or keys in this chat.', null],
    ['kickoff', 'We start now, the amount of care you get is high', null],
    ['payment_verified', 'Invoice {invoiceNumber} is verified, thank you.', null],
    ['payment_verified', 'Your payment was verified, thank you.', /must use \{invoiceNumber\}/],
    ['welcome', 'Welcome to {agencyName} and {nobody}.', /placeholder \{nobody\}/],
    ['welcome', 'Welcome to {agencyName and the rest', /brace is left open/],
    ['welcome', 'Hi', /too short/],
    ['kickoff', 'We start now and the first payment of Rs 5000 is done', /no amount/],
    ['kickoff', 'We start now, you save ₹500 on this', /no amount/],
    ['kickoff', 'We start now with 20% off for you', /no amount/],
    ['kickoff', 'We start now and we promise delivery on time', /no promise/],
    ['kickoff', 'We start now, a discount applies to you', /no promise/],
    ['kickoff', 'We start now, read https://example.test/x first', /no link/],
    ['kickoff', 'We start now, our Claude assistant will help', /model or provider/],
    ['nonsense', 'Some perfectly fine text here', /unknown template/],
  ];
  for (const [key, body, expected] of cases) {
    test(`${key}: ${body.slice(0, 50)}`, () => {
      const problem = pmTemplateProblem(key, 'en', body);
      if (expected === null) assert.equal(problem, null);
      else assert.match(problem ?? '', expected);
    });
  }

  test('a Devanagari body is valid (the amount rule must not match script bytes)', () => {
    assert.equal(pmTemplateProblem('billing_question', 'hindi', 'बिलिंग के लिए कृपया बताएँ कि आपको GST इनवॉइस चाहिए या नहीं।'), null);
  });

  test('the SQL carries the same rules in the same words', () => {
    for (const phrase of ['a client message states no amount', 'a client message makes no promise, discount or deadline', 'a client message carries no link', 'which model or provider is behind it', 'a brace is left open', 'is not allowed in this template']) {
      assert.ok(migration.includes(phrase), phrase);
    }
  });
});

describe('rendering', () => {
  test('placeholders are filled, and a message with a placeholder it cannot fill is not rendered at all', () => {
    assert.equal(renderPmTemplate('Invoice {invoiceNumber} is verified.', { invoiceNumber: 'INV-7' }), 'Invoice INV-7 is verified.');
    assert.equal(renderPmTemplate('Invoice {invoiceNumber} is verified.', {}), null);
    assert.equal(renderPmTemplate('Invoice {invoiceNumber} is verified.', { invoiceNumber: '  ' }), null);
    assert.equal(renderPmTemplate('No placeholders here at all.', {}), 'No placeholders here at all.');
  });

  test('a value that itself contains braces is inserted as text, never re-read as a placeholder', () => {
    assert.equal(renderPmTemplate('One question: {question}', { question: 'what is {agencyName}?' }), 'One question: what is {agencyName}?');
  });
});

describe('the sender: an approved override, else the wording in code', () => {
  type Call = { schema: string; fn: string; args: Record<string, unknown> };
  function fakeAdmin(reply: { data: unknown; error: { message: string } | null }, calls: Call[] = []) {
    return {
      schema: (schema: string) => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ schema, fn, args });
          return reply;
        },
      }),
    } as never;
  }
  const input = { organizationId: 'org-1', key: 'payment_verified' as const, language: 'en' as const, vars: { invoiceNumber: 'INV-9' }, fallback: 'FALLBACK' };

  test('an approved body is rendered and returned; the read is the service-role door with the right arguments', async () => {
    const calls: Call[] = [];
    const out = await resolvePmText(fakeAdmin({ data: [{ template_id: 't', version: 2, body: 'Payment for {invoiceNumber} is confirmed. Thank you.' }], error: null }, calls), input);
    assert.equal(out, 'Payment for INV-9 is confirmed. Thank you.');
    assert.deepEqual(calls, [{ schema: 'projects', fn: 'p1s_pm_template_approved', args: { p_organization_id: 'org-1', p_key: 'payment_verified', p_language: 'en' } }]);
  });

  test('no approved row: the wording in code', async () => {
    assert.equal(await resolvePmText(fakeAdmin({ data: [], error: null }), input), 'FALLBACK');
    assert.equal(await resolvePmText(fakeAdmin({ data: null, error: null }), input), 'FALLBACK');
  });

  test('an unreadable template falls back (and is logged), it never blocks the message', async () => {
    const original = console.error;
    const logged: string[] = [];
    console.error = (m: unknown) => logged.push(String(m));
    try {
      assert.equal(await resolvePmText(fakeAdmin({ data: null, error: { message: 'boom' } }), input), 'FALLBACK');
    } finally {
      console.error = original;
    }
    assert.match(logged.join(''), /resolvePmText/);
  });

  test('an approved body that no longer passes the rules is not sent', async () => {
    const original = console.error;
    console.error = () => undefined;
    try {
      assert.equal(await resolvePmText(fakeAdmin({ data: [{ body: 'Payment for {invoiceNumber} confirmed, you save 10% today.' }], error: null }), input), 'FALLBACK');
    } finally {
      console.error = original;
    }
  });

  test('an approved body with a placeholder the caller has no value for is not sent half-filled', async () => {
    assert.equal(await resolvePmText(fakeAdmin({ data: [{ body: 'Payment for {invoiceNumber} is confirmed. Thank you.' }], error: null }), { ...input, vars: {} }), 'FALLBACK');
  });
});

describe('wiring: every PM sender asks the resolver, with the wording it always used as the fallback', () => {
  const comms = read('src/modules/projects/pm-client-comms.ts');
  const followups = read('src/modules/projects/pm-followups.ts');
  const clar = read('src/modules/projects/pm-clarifications.ts');
  const kickoff = read('src/modules/projects/kickoff-send.ts');

  test('pm-client-comms: welcome, billing, GST, and the four payment messages', () => {
    assert.match(comms, /key: 'welcome'[\s\S]{0,200}fallback: pmWelcome\(/);
    assert.match(comms, /key: 'billing_question'[^\n]*fallback: pmBillingQuestion\(ctx\.language\)/);
    assert.match(comms, /key: 'gst_details_request'[^\n]*fallback: pmGstDetailsRequest\(ctx\.language\)/);
    for (const [key, fn] of [['payment_received', 'pmPaymentReceived'], ['advance_verified', 'pmAdvanceVerified'], ['payment_verified', 'pmPaymentVerified'], ['payment_needs_attention', 'pmPaymentNeedsAttention']] as const) {
      assert.match(comms, new RegExp(`key: '${key}', fallback: ${fn}\\(`), key);
    }
    assert.match(comms, /const body = await resolvePmText\(admin, \{[\s\S]{0,200}key: paymentTemplate\.key/);
  });

  test('pm-followups, pm-clarifications and the kickoff send', () => {
    assert.match(followups, /key: what === 'billing' \? 'follow_up_billing' : 'follow_up_gst_details'[\s\S]{0,200}fallback: pmFollowUp\(ctx\.language, what\)/);
    assert.match(clar, /key: 'clarification_ask'[\s\S]{0,200}fallback: pmClarificationAsk\(ctx\.language, next\.question\)/);
    assert.match(kickoff, /key: 'kickoff'[^\n]*fallback: pmKickoff\(language\)/);
  });

  test('no sender builds a client message from a code function without going through the resolver', () => {
    for (const [file, src] of [['pm-client-comms', comms], ['pm-followups', followups], ['pm-clarifications', clar], ['kickoff-send', kickoff]] as const) {
      assert.match(src, /resolvePmText/, file);
      // every `body:` that comes from a pm* function is the fallback of a resolver call, never the body itself
      assert.doesNotMatch(src, /body: pm[A-Z]\w*\(/, `${file} sends a code message directly`);
    }
  });

  test('the resolver reads only the approved-row door, and the migration grants it to the service role alone', () => {
    const src = read('src/modules/projects/pm-template-resolve.ts');
    assert.match(src, /rpc\('p1s_pm_template_approved'/);
    assert.doesNotMatch(src, /\.from\(/);
    assert.match(migration, /revoke all on function projects\.p1s_pm_template_approved\(uuid, text, text\) from public, anon, authenticated;/);
    assert.match(migration, /grant execute on function projects\.p1s_pm_template_approved\(uuid, text, text\) to service_role;/);
  });
});

describe('governance: who can do what, as the files say it', () => {
  test('approval is an Admin act at the app layer and at the database door; authoring is not', () => {
    const service = read('src/modules/projects/pm-template-service.ts');
    assert.match(service, /export async function decidePmTemplate[\s\S]{0,300}can\(context, 'organization\.settings'\)/);
    assert.match(migration, /function projects\.p1s_decide_pm_template[\s\S]{0,900}not coalesce\(\(select core\.is_admin\(\)\), false\) then return query select 'not_authorized'/);
    assert.match(migration, /function projects\.p1s_save_pm_template_draft[\s\S]{0,900}core\.can_write\(\)/);
  });

  test('the table is not writable except through the doors, and a left-draft row is immutable', () => {
    assert.doesNotMatch(migration, /grant (all|insert|update|delete)[^;]*p1s_pm_template_versions to authenticated/);
    assert.match(migration, /a template version is immutable once submitted/);
    assert.match(migration, /a template version that left draft is history and is never deleted/);
  });

  test('the actions file exports only async functions ("use server")', () => {
    const src = read('src/modules/projects/pm-template-actions.ts');
    assert.match(src, /^'use server';/);
    const exports = [...src.matchAll(/^export (\w+)/gm)].map((m) => m[1]);
    assert.ok(exports.length >= 5);
    assert.deepEqual([...new Set(exports)], ['async']);
  });

  test('the settings tab and page exist', () => {
    assert.match(read('app/(internal)/settings/layout.tsx'), /\{ href: '\/settings\/pm-templates', label: 'PM messages' \}/);
    assert.match(read('app/(internal)/settings/pm-templates/page.tsx'), /listPmTemplateVersions\(\)/);
  });
});
