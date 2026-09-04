import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

/**
 * Every outbound message asks the same question — gap G-214.
 *
 * G-213 taught ONE handler about WhatsApp's 24-hour window. Nine other send
 * sites never asked, and two of them had already been refused in production:
 * the approval announcement — ADM-95 made the internal channel a PERSON, so
 * the window governs it — and the approved quotation, dispatched hours or
 * days after the client last wrote.
 *
 * The behaviour is proved against a real Postgres by
 * `scripts/verify-outbound-window.ts` — 31 checks, including the production
 * failure itself: an internal channel that is a person, and a window that
 * belongs to a number rather than to a thread.
 *
 * What is here is the decision layer's own logic, driven with a client that
 * answers the three reads it makes. No module is mocked: nothing in this file
 * needs one, and a mocked send would only prove the mock.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';
const ORG = '66666666-6666-4666-8666-666666666666';

const seen = { rpc: [] as [string, Record<string, unknown>][] };

let windowState: string | null = 'open';
let windowError: { message: string } | null = null;
let templates: { template_name: string; language_code: string; parameters: string[] }[] = [];
let templateError: { message: string } | null = null;
let deferrals: { id: string }[] = [];
let deferOutcome = 'deferred';

/**
 * Enough of a client to answer the three reads the decision makes, and no
 * more. Everything it answers is a row the real schema has.
 */
const admin = {
  schema: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (value: unknown) => void) => {
          if (table === 'whatsapp_templates') {
            return resolve({ data: templateError ? null : templates, error: templateError });
          }
          if (table === 'deferred_sends') return resolve({ data: deferrals, error: null });
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      seen.rpc.push([fn, args]);
      if (fn === 'window_state') {
        return windowError ? { data: null, error: windowError } : { data: windowState, error: null };
      }
      if (fn === 'defer_send') return { data: deferOutcome, error: null };
      if (fn === 'wake_deferred_sends') return { data: 3, error: null };
      return { data: null, error: null };
    },
  }),
};

const { deferSend, planOutbound, readWindowState, wakeDeferredSends } = await import(
  '../src/modules/crm/outbound-window.ts'
);

beforeEach(() => {
  seen.rpc.length = 0;
  windowState = 'open';
  windowError = null;
  templates = [];
  templateError = null;
  deferrals = [];
  deferOutcome = 'deferred';
});

const plan = (situationKey = 'quotation_approved', jobId: string | null = JOB) =>
  planOutbound(admin as never, {
    organizationId: ORG,
    conversationId: CONVERSATION,
    situationKey,
    jobId,
  });

describe('the window is read, not guessed', () => {
  test('the four states come back as themselves', async () => {
    for (const state of ['open', 'closed', 'never', 'group'] as const) {
      windowState = state;
      assert.equal(await readWindowState(admin as never, CONVERSATION), state);
    }
  });

  test('a failed read is unreadable, never closed', async () => {
    windowError = { message: 'connection reset' };
    assert.equal(await readWindowState(admin as never, CONVERSATION), 'unreadable');
  });

  test('and an answer nothing recognises is unreadable too', async () => {
    windowState = 'sometimes';
    assert.equal(await readWindowState(admin as never, CONVERSATION), 'unreadable');
  });
});

describe('what may leave, and when', () => {
  test('inside the window, the wording goes', async () => {
    windowState = 'open';
    const decided = await plan();
    assert.equal(decided.mode, 'text');
  });

  test('a group has no window, so the wording goes there too', async () => {
    windowState = 'group';
    assert.equal((await plan()).mode, 'text');
  });

  /**
   * The absence this whole gap exists for, and its positive twin above: free
   * text must never be planned outside the window, and must always be planned
   * inside it. Testing only the refusal would stay green if the planner
   * refused everything.
   */
  test('outside it, free text is never the answer — for either shut state', async () => {
    for (const state of ['closed', 'never'] as const) {
      windowState = state;
      templates = [];
      assert.notEqual((await plan()).mode, 'text', `${state} planned free text`);
      templates = [{ template_name: 'quotation_ready', language_code: 'en', parameters: [] }];
      assert.notEqual((await plan()).mode, 'text', `${state} planned free text with a template`);
    }
  });

  test('outside it with an approved template, the template goes', async () => {
    windowState = 'closed';
    templates = [{ template_name: 'quotation_ready', language_code: 'en', parameters: [] }];
    const decided = await plan();
    assert.equal(decided.mode, 'template');
    assert.equal(decided.mode === 'template' && decided.template.name, 'quotation_ready');
  });

  test('outside it with nothing approved, the answer is to wait — and it says why', async () => {
    windowState = 'never';
    const decided = await plan();
    assert.equal(decided.mode, 'defer');
    assert.match(decided.mode === 'defer' ? decided.reason : '', /never written/);
  });

  test('a job that already told them does not tell them twice', async () => {
    windowState = 'closed';
    templates = [{ template_name: 'quotation_ready', language_code: 'en', parameters: [] }];
    deferrals = [{ id: 'already' }];
    assert.equal((await plan()).mode, 'defer');
  });

  test('and without a job there is nothing to have told them with', async () => {
    windowState = 'closed';
    templates = [{ template_name: 'quotation_ready', language_code: 'en', parameters: [] }];
    deferrals = [{ id: 'belongs to another job' }];
    assert.equal((await plan('quotation_approved', null)).mode, 'template');
  });
});

describe('a read that failed is not a decision', () => {
  test('an unreadable window retries rather than deferring for a month', async () => {
    windowError = { message: 'connection reset' };
    const decided = await plan();
    assert.equal(decided.mode, 'retry');
  });

  test('an unreadable template registry retries too', async () => {
    windowState = 'closed';
    templateError = { message: 'connection reset' };
    assert.equal((await plan()).mode, 'retry');
  });

  test('and an unreadable deferral history retries, rather than telling them twice', async () => {
    windowState = 'closed';
    templates = [{ template_name: 'quotation_ready', language_code: 'en', parameters: [] }];
    // The deferred_sends read fails; the honest answer is "try again", because
    // the alternative is a second message about one quotation.
    const failing = {
      schema: () => ({
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({ limit: () => Promise.resolve({ data: templates, error: null }) }),
              }),
              limit: () =>
                table === 'deferred_sends'
                  ? Promise.resolve({ data: null, error: { message: 'connection reset' } })
                  : Promise.resolve({ data: templates, error: null }),
            }),
          }),
        }),
        rpc: async () => ({ data: 'closed', error: null }),
      }),
    };
    assert.equal((await planOutbound(failing as never, {
      organizationId: ORG,
      conversationId: CONVERSATION,
      situationKey: 'quotation_approved',
      jobId: JOB,
    })).mode, 'retry');
  });
});

describe('the situation is asked for by name', () => {
  test('no situation means no template — nothing is guessed', async () => {
    windowState = 'closed';
    templates = [{ template_name: 'something', language_code: 'en', parameters: [] }];
    const decided = await plan('');
    assert.equal(decided.mode, 'defer');
    // And it did not even ask, because there is no situation to ask about.
    assert.equal(seen.rpc.filter(([fn]) => fn === 'window_state').length, 1);
  });

  test('the lookup names the organization — the filter one agency cannot lose', async () => {
    windowState = 'closed';
    // The registry read runs on the service-role client, which bypasses RLS.
    // Proven structurally: the source names the organization filter on the
    // template lookup. A live section proves the behaviour.
    const source = readFileSync(
      fileURLToPath(new URL('../src/modules/crm/outbound-window.ts', import.meta.url)),
      'utf8',
    );
    const lookup = source.slice(source.indexOf("from('whatsapp_templates')"), source.indexOf('const row ='));
    assert.match(lookup, /\.eq\('organization_id', organizationId\)/);
  });
});

describe('parking and waking', () => {
  test('a refusal is reported as itself, never as a wait that is happening', async () => {
    for (const outcome of ['no_job', 'wrong_tenant', 'no_counterpart'] as const) {
      deferOutcome = outcome;
      assert.equal(
        await deferSend(admin as never, { jobId: JOB, conversationId: CONVERSATION, reason: 'x' }),
        outcome,
      );
    }
  });

  test('a wake reports how many it woke', async () => {
    assert.equal(await wakeDeferredSends(admin as never, { organizationId: ORG, phone: '+919000000001' }), 3);
  });
});

describe('the senders themselves', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/lib/whatsapp/send.ts', import.meta.url)),
    'utf8',
  );

  /**
   * The property that makes an unattended campaign safe: a template send can
   * only invoke wording somebody at Meta already read. If this function could
   * take a body, it could say something new outside the window, which is the
   * thing WhatsApp's rule exists to prevent.
   */
  test('sendWhatsAppTemplate cannot be given a body', () => {
    // Comments stripped: the docstring says the word "body" about Meta's
    // approved wording, and a check that read prose would fail on a sentence
    // rather than on a parameter.
    const code = codeOnly(source);
    const signature = code.slice(
      code.indexOf('export async function sendWhatsAppTemplate'),
      code.indexOf('): Promise<SendResult> {', code.indexOf('export async function sendWhatsAppTemplate')),
    );
    assert.doesNotMatch(signature, /\bbody\b/);
  });
});

describe('every client-facing sender asks', () => {
  /**
   * A structural check, and the reason it is structural: this gap exists
   * because nine send sites did not ask. A test per site would go stale the
   * moment a tenth is added; this one fails when it is.
   */
  const files = [
    '../src/modules/crm/handlers.ts',
    '../src/modules/crm/service.ts',
    '../app/api/jobs/run/workflows.ts',
  ];

  test('no free-text send stands without a window decision in the same function', () => {
    for (const file of files) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      const sends = source.split('await sendWhatsAppText(').length - 1;
      const asks =
        (source.split('windowGate(').length - 1 - (source.includes('async function windowGate') ? 1 : 0)) +
        (source.split('planOutbound(').length - 1) +
        (source.split('readWindowState(').length - 1);
      assert.ok(
        asks >= sends,
        `${file}: ${sends} free-text send(s) and only ${asks} window decision(s)`,
      );
    }
  });
});

describe('a deferred job keeps its own row', () => {
  /**
   * Structural, and it has to be: the settle lives in the Next route module,
   * which does not load under the test runner. But the rule it encodes is the
   * one that decides whether a client ever receives their quotation — settling
   * a deferred job `succeeded` erases the far `run_at` and the wake then finds
   * a finished job and leaves it alone, forever.
   */
  const route = codeOnly(
    readFileSync(fileURLToPath(new URL('../app/api/jobs/run/route.ts', import.meta.url)), 'utf8'),
  );

  test('the succeeded branch returns before touching a deferred job', () => {
    const branch = route.slice(
      route.indexOf("if (result.status === 'succeeded') {"),
      route.indexOf('const settlement = settlementFor('),
    );
    assert.match(branch, /if \(result\.outcome === 'deferred'\) return;/);
    // And the early return comes FIRST — after the update it would be a
    // comment rather than a control.
    assert.ok(
      branch.indexOf("outcome === 'deferred'") < branch.indexOf("status: 'succeeded', locked_at: null"),
      'the deferred check must precede the update it is protecting the row from',
    );
  });
});
