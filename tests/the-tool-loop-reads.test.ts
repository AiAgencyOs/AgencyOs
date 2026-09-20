import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';

import { dispatchTool, dispatchableToolsFor, toolSpecFor } from '../src/modules/agents/tool-dispatch.ts';
import { toolsFor } from '../src/modules/agents/tools.ts';

// `claude.ts` reads `serverEnv()` at construction, which validates the whole
// public schema — the same reason `ai-extraction.test.ts` sets these.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

/**
 * The tool loop reads — G-187, ADM-99.
 *
 * Fourteen tools were declared, thirty-eight bindings named them, and the
 * authorization boundary (`resolveTool`) was built and tested — **and nothing
 * dispatched any of them**, because dispatching was the owner's call, not an
 * engineer's, and building it unasked would have been the same class of act
 * ADM-98 was careful to record as an override.
 *
 * Asked, the owner chose: **the four read-only tools.** This is that
 * dispatch, and it is narrowed twice over — once by `resolveTool` (does this
 * agent hold this, at a class its autonomy admits) and again by
 * `DISPATCHABLE` in `tool-dispatch.ts` (is this one of the four ADM-99 turns
 * on) — so a tool bound and authorized is not thereby executable, and the two
 * lists are allowed to disagree.
 *
 * ── what is proved here, and how ──────────────────────────────────────
 *
 * `dispatchTool` against a stubbed admin client, for the ordering and the
 * tenancy scoping a live database would otherwise have to demonstrate.
 * `generateWithTools` against a stand-in HTTP server shaped like Anthropic's
 * real API — the same technique `ai-extraction.test.ts` uses for
 * `generateStructured` — because the tool-use response shape (`stop_reason`,
 * `tool_use` content blocks) is new wire format this repository has not
 * exercised before.
 *
 * **Stated rather than implied: the live loop has not been driven end to
 * end.** No provider key is configured on this machine, and `lead.qualify`'s
 * live verification script drives the workflow without ever prompting the
 * model to reach for `memory.recall` — the same honesty this session's other
 * units gave the first real model call they could not make.
 */

// ── A. dispatchTool — the ordering, and the narrowing ─────────────────────

type Outcome<T = Record<string, unknown>> = { data: T | null; error: { message: string } | null };

let leadOutcome: Outcome = { data: null, error: null };
let conversationOutcome: Outcome = { data: null, error: null };
let messagesOutcome: Outcome<unknown[]> = { data: [], error: null };
let recallOutcome: Outcome<unknown[]> = { data: [], error: null };
let scopeVersionOutcome: Outcome = { data: null, error: null };
let scopeItemsOutcome: Outcome<unknown[]> = { data: [], error: null };
const seenTables: string[] = [];
const seenOrgFilters: string[] = [];

function chainFor(table: string) {
  const record = (
    result: Outcome | Outcome<unknown[]>,
    thenable: boolean,
  ) => {
    const chain: Record<string, unknown> = {
      eq: (col: string, value: unknown) => {
        if (col === 'organization_id') seenOrgFilters.push(`${table}:${String(value)}`);
        return chain;
      },
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => result,
    };
    if (thenable) {
      (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(result);
    }
    return chain;
  };

  return {
    select: () => {
      seenTables.push(table);
      switch (table) {
        case 'leads':
          return record(leadOutcome, false);
        case 'conversations':
          return record(conversationOutcome, false);
        case 'conversation_messages':
          return record(messagesOutcome, true);
        case 'scope_versions':
          return record(scopeVersionOutcome, false);
        case 'scope_items':
          return record(scopeItemsOutcome, true);
        default:
          throw new Error(`unexpected table ${table}`);
      }
    },
  };
}

const admin = {
  schema(_schemaName: string) {
    return {
      from: (table: string) => chainFor(table),
      rpc: async (_fn: string, _args: object) => recallOutcome,
    };
  },
} as never;

beforeEach(() => {
  leadOutcome = { data: null, error: null };
  conversationOutcome = { data: null, error: null };
  messagesOutcome = { data: [], error: null };
  recallOutcome = { data: [], error: null };
  scopeVersionOutcome = { data: null, error: null };
  scopeItemsOutcome = { data: [], error: null };
  seenTables.length = 0;
  seenOrgFilters.length = 0;
});

describe('A. the authorization boundary runs before dispatch, not instead of it', () => {
  test('a tool the agent does not hold is refused before any table is touched', async () => {
    const result = await dispatchTool({
      admin,
      organizationId: 'org-1',
      agentKey: 'requirement_collector',
      agentAutonomy: 'L1',
      toolName: 'crm.readLead',
      input: { leadId: 'lead-1' },
    });
    assert.equal(result.ok, false);
    assert.equal(seenTables.length, 0, 'a table was touched before authorization ran');
  });

  test('a tool the agent holds but ADM-99 has not turned on is refused as not_dispatched', async () => {
    // `sales` holds `crm.sendClientMessage` — bound, authorized at its class,
    // and still not one of the four.
    const result = await dispatchTool({
      admin,
      organizationId: 'org-1',
      agentKey: 'sales',
      agentAutonomy: 'L2',
      toolName: 'crm.sendClientMessage',
      input: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error.message, /has not turned on dispatch/);
    assert.equal(seenTables.length, 0);
  });

  test('the four are dispatched only for an agent actually bound to them', async () => {
    leadOutcome = { data: { id: 'lead-1', title: 'x', status: 'new', source: 'whatsapp', summary: null }, error: null };
    const result = await dispatchTool({
      admin,
      organizationId: 'org-1',
      agentKey: 'sales',
      agentAutonomy: 'L1',
      toolName: 'crm.readLead',
      input: { leadId: 'lead-1' },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seenTables, ['leads']);
  });
});

describe('B. tenancy is a parameter, not a hope', () => {
  test('crm.readLead scopes by organization_id', async () => {
    leadOutcome = { data: { id: 'lead-1' }, error: null };
    await dispatchTool({
      admin,
      organizationId: 'org-7',
      agentKey: 'sales',
      agentAutonomy: 'L1',
      toolName: 'crm.readLead',
      input: { leadId: 'lead-1' },
    });
    assert.deepEqual(seenOrgFilters, ['leads:org-7']);
  });

  test('crm.readConversation checks the CONVERSATION’s tenant before reading its messages', async () => {
    // A message table scoped only by conversation_id would answer a
    // conversation id from another organization with that organization's
    // transcript — the FK says nothing about which organization.
    conversationOutcome = { data: null, error: null };
    const result = await dispatchTool({
      admin,
      organizationId: 'org-7',
      agentKey: 'sales',
      agentAutonomy: 'L1',
      toolName: 'crm.readConversation',
      input: { conversationId: 'conv-1' },
    });
    assert.equal(result.ok, false);
    assert.equal(seenTables.includes('conversation_messages'), false, 'messages were read despite the tenant check failing');
  });

  test('memory.recall names the tenant explicitly (G-189’s fix, driven again)', async () => {
    recallOutcome = { data: [{ kind: 'pricing_decision', fact: 'x' }], error: null };
    const seenRpc: { fn: string; args: Record<string, unknown> }[] = [];
    const spyAdmin = {
      schema: () => ({
        from: (table: string) => chainFor(table),
        rpc: async (fn: string, args: Record<string, unknown>) => {
          seenRpc.push({ fn, args });
          return recallOutcome;
        },
      }),
    } as never;

    await dispatchTool({
      admin: spyAdmin,
      organizationId: 'org-9',
      agentKey: 'sales',
      agentAutonomy: 'L1',
      toolName: 'memory.recall',
      input: { scope: 'organization' },
    });

    assert.equal(seenRpc.length, 1);
    assert.equal(seenRpc[0]!.fn, 'recall');
    assert.equal(seenRpc[0]!.args.p_organization_id, 'org-9');
  });
});

describe('C. every tool refuses a malformed argument before touching the database', () => {
  test('crm.readLead needs a leadId', async () => {
    const result = await dispatchTool({
      admin,
      organizationId: 'org-1',
      agentKey: 'sales',
      agentAutonomy: 'L1',
      toolName: 'crm.readLead',
      input: {},
    });
    assert.equal(result.ok, false);
    assert.equal(seenTables.length, 0);
  });

  test('memory.recall needs a scopeId when the scope is not organization', async () => {
    const result = await dispatchTool({
      admin,
      organizationId: 'org-1',
      agentKey: 'sales',
      agentAutonomy: 'L1',
      toolName: 'memory.recall',
      input: { scope: 'lead' },
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error.message, /needs a scopeId/);
  });

  test('an unrecognised scope is refused rather than passed through to SQL', async () => {
    const result = await dispatchTool({
      admin,
      organizationId: 'org-1',
      agentKey: 'sales',
      agentAutonomy: 'L1',
      toolName: 'memory.recall',
      input: { scope: 'not_a_real_scope' },
    });
    assert.equal(result.ok, false);
  });
});

describe('D. projects.readScope answers "no baseline yet" rather than failing', () => {
  test('no active version is an empty answer, not an error', async () => {
    scopeVersionOutcome = { data: null, error: null };
    const result = await dispatchTool({
      admin,
      organizationId: 'org-1',
      agentKey: 'project_manager',
      agentAutonomy: 'L2',
      toolName: 'projects.readScope',
      input: { projectId: 'proj-1' },
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(JSON.parse(result.data), { active: null, items: [] });
  });

  test('an active version reads its items', async () => {
    scopeVersionOutcome = { data: { id: 'sv-1', version: 2, status: 'active' }, error: null };
    scopeItemsOutcome = { data: [{ id: 'i1', title: 'Login', inclusion: 'included' }], error: null };
    const result = await dispatchTool({
      admin,
      organizationId: 'org-1',
      agentKey: 'project_manager',
      agentAutonomy: 'L2',
      toolName: 'projects.readScope',
      input: { projectId: 'proj-1' },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      const parsed = JSON.parse(result.data) as { active: { id: string }; items: unknown[] };
      assert.equal(parsed.active.id, 'sv-1');
      assert.equal(parsed.items.length, 1);
    }
  });
});

describe('E. the offered set is the intersection, not either list alone', () => {
  test('dispatchableToolsFor(toolsFor(sales)) is exactly the three sales holds of the four', () => {
    const specs = dispatchableToolsFor(toolsFor('sales'));
    const names = specs.map((s) => s.name).sort();
    // sales is bound to crm.readLead, crm.readConversation and memory.recall —
    // not projects.readScope — so the intersection is three, not four.
    assert.deepEqual(names, ['crm.readConversation', 'crm.readLead', 'memory.recall']);
  });

  test('a tool with no dispatch handler yields no spec, however it is bound', () => {
    // sales also holds crm.sendClientMessage, approvals.requestApproval and
    // memory.remember — none dispatchable, and toolSpecFor says so directly.
    for (const name of ['crm.sendClientMessage', 'approvals.requestApproval', 'memory.remember']) {
      assert.equal(toolSpecFor(name), null, `${name} produced a spec`);
    }
  });

  test('project_manager’s intersection includes projects.readScope', () => {
    const specs = dispatchableToolsFor(toolsFor('project_manager'));
    assert.ok(specs.some((s) => s.name === 'projects.readScope'));
  });
});

// ── F. generateWithTools — the wire shape, against a stand-in server ──────

let server: Server;
let baseURL: string;
let requests = 0;
type Reply = { status: number; body: unknown; delayMs?: number };
let replies: Reply[] = [];

function willReply(...queue: Reply[]) {
  replies = queue;
  requests = 0;
}

before(async () => {
  server = createServer((req, res) => {
    requests += 1;
    const reply = replies[Math.min(requests - 1, replies.length - 1)] ?? {
      status: 500,
      body: { type: 'error', error: { type: 'api_error', message: 'no reply queued' } },
    };
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      void raw;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseURL = `http://127.0.0.1:${address.port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-a-real-credential';
  process.env.ANTHROPIC_BASE_URL = baseURL;
});

after(async () => {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function provider() {
  const { createClaudeProvider } = await import('../src/lib/ai/claude.ts');
  const made = await createClaudeProvider();
  assert.ok(made, 'provider should exist when a key is configured');
  return made;
}

const toolRequest = {
  model: 'claude-sonnet-5',
  system: 'answer using memory.recall if it helps',
  messages: [{ role: 'user' as const, content: 'what have we agreed with this client before?' }],
  tools: [{ name: 'memory.recall', description: 'recall memory', inputSchema: { type: 'object' } }],
};

describe('F. the model asking for a tool', () => {
  beforeEach(() => willReply());

  test('a tool_use stop reason produces kind: tool_calls, with the ids intact', async () => {
    willReply({
      status: 200,
      body: {
        model: 'claude-sonnet-5',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_01', name: 'memory.recall', input: { scope: 'organization' } },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    });

    const generateWithTools = (await provider()).generateWithTools;
    assert.ok(generateWithTools, 'generateWithTools is not implemented');
    const result = await generateWithTools(toolRequest);

    assert.equal(result.ok, true);
    if (result.ok && result.data.kind === 'tool_calls') {
      assert.equal(result.data.calls.length, 1);
      assert.equal(result.data.calls[0]!.id, 'toolu_01');
      assert.equal(result.data.calls[0]!.name, 'memory.recall');
      assert.deepEqual(result.data.calls[0]!.input, { scope: 'organization' });
    } else {
      assert.fail('expected kind: tool_calls');
    }
  });

  test('a tool_use stop reason with no tool_use block is a provider error, not a silent final', () => {
    // The provider contradicting its own field. Treating this as `final` would
    // hand the caller's JSON.parse text that was never meant to be an answer.
    return (async () => {
      willReply({
        status: 200,
        body: {
          model: 'claude-sonnet-5',
          stop_reason: 'tool_use',
          content: [{ type: 'text', text: 'oops' }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      });
      const generateWithTools = (await provider()).generateWithTools!;
      const result = await generateWithTools(toolRequest);
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.error.message, /signalled a tool call but sent none/);
    })();
  });

  test('end_turn with text is kind: final', async () => {
    willReply({
      status: 200,
      body: {
        model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"covered":[]}' }],
        usage: { input_tokens: 30, output_tokens: 15 },
      },
    });
    const generateWithTools = (await provider()).generateWithTools!;
    const result = await generateWithTools(toolRequest);
    assert.equal(result.ok, true);
    if (result.ok && result.data.kind === 'final') {
      assert.equal(result.data.text, '{"covered":[]}');
    } else {
      assert.fail('expected kind: final');
    }
  });

  test('a refusal stop reason is a provider error, same as generateStructured', async () => {
    willReply({
      status: 200,
      body: {
        model: 'claude-sonnet-5',
        stop_reason: 'refusal',
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    const generateWithTools = (await provider()).generateWithTools!;
    const result = await generateWithTools(toolRequest);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error.message, /declined/);
  });
});

// ── G. the wiring into lead.qualify is additive, not a rewrite ────────────

describe('G. lead.qualify’s new caller changes nothing a model does not ask for', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
  const WORKFLOWS = read('app/api/jobs/run/workflows.ts');
  const TOOLS_SOURCE = read('src/modules/agents/tools.ts');

  test('the call site uses the tool loop, offering only memory.recall', () => {
    const at = WORKFLOWS.indexOf("jobKind: 'lead.qualify'");
    assert.ok(at > 0, 'lead.qualify workflow not found');
    const body = WORKFLOWS.slice(at, at + 6000);
    assert.match(body, /callModelWithTools\(/);
    assert.match(body, /\.filter\(\(t\) => t\.name === 'memory\.recall'\)/);
    assert.doesNotMatch(body, /'crm\.readLead'|'crm\.readConversation'/);
  });

  test('the reasoning for excluding the other two bound tools is on the record', () => {
    const at = WORKFLOWS.indexOf("jobKind: 'lead.qualify'");
    const body = WORKFLOWS.slice(at, at + 6000);
    assert.match(body, /a round-trip that grants no new fact/);
  });

  test('and the docblock names it as the first live caller', () => {
    assert.match(TOOLS_SOURCE, /The first live caller is `lead\.qualify`/);
  });
});

// ── H. callModelWithTools — the loop itself, end to end ───────────────────
//
// One mock and one import, at module scope, deliberately: ESM caches a
// module graph on first evaluation, so a SECOND `mock.module` call for
// `@/lib/ai/router` after `agent-run.ts` has already been imported once does
// not reach the binding `agent-run.ts` closed over — the first test to import
// it fixes which `resolveProvider` every later test in the same process gets.
// Each test below instead reconfigures the ONE mock's behaviour through
// `providerState`, which the mock reads at call time rather than at import
// time.

const providerState: {
  mode: 'sequence' | 'always_tools';
  calls: number;
  toolCallsLog: string[];
} = { mode: 'sequence', calls: 0, toolCallsLog: [] };

const fakeProvider = {
  id: 'fake',
  supports: () => true,
  generateStructured: async (): Promise<never> => {
    throw new Error('not used by this suite');
  },
  generateWithTools: async () => {
    providerState.calls += 1;
    if (providerState.mode === 'always_tools' || providerState.calls === 1) {
      return {
        ok: true as const,
        data: {
          kind: 'tool_calls' as const,
          calls: [{ id: `t${providerState.calls}`, name: 'memory.recall', input: { scope: 'organization' } }],
          usage: { inputTokens: 10, outputTokens: 5, costMinor: 0 },
          model: 'fake-model',
        },
      };
    }
    return {
      ok: true as const,
      data: {
        kind: 'final' as const,
        text: '{"covered":[]}',
        usage: { inputTokens: 8, outputTokens: 3, costMinor: 0 },
        model: 'fake-model',
      },
    };
  },
};

const { mock: nodeMock } = await import('node:test');
nodeMock.module('@/lib/ai/router', { exports: { resolveProvider: () => ({ ok: true, data: fakeProvider }) } });
const { callModelWithTools } = await import('../app/api/jobs/run/agent-run.ts');

function freshCtx(jobId: string) {
  return {
    admin: { schema: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) },
    job: { id: jobId, kind: 'lead.qualify', organization_id: 'org-1', payload: null, attempts: 1, max_attempts: 3, correlation_id: null, last_error: null },
    agent: { key: 'sales', enabled: true, default_model: 'fake-model', default_effort: 'medium', autonomy_level: 'L1' },
    correlationId: 'corr-1',
    workClass: 'read',
  };
}

describe('H. the loop: recording, bounding, and the round-trip', () => {
  test('a tool_calls turn followed by final records a model_call, a tool_call, then a model_call', async () => {
    providerState.mode = 'sequence';
    providerState.calls = 0;

    const inserted: { kind: string; seq: number }[] = [];
    const admin = {
      schema: () => ({
        from: () => ({
          insert: async (row: { kind: string; seq: number }) => {
            inserted.push({ kind: row.kind, seq: row.seq });
            return { error: null };
          },
        }),
      }),
    };

    const dispatched: string[] = [];
    const result = await callModelWithTools(
      { ...freshCtx('job-1'), admin } as never,
      { systemPrompt: 'sys', schemaName: 'QualificationCoverage' },
      [{ role: 'user', content: 'hi' }],
      [{ name: 'memory.recall', description: 'recall', inputSchema: { type: 'object' } }],
      'run-1',
      async (call) => {
        dispatched.push(call.name);
        return { ok: true, data: '[]' };
      },
    );

    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.json, { covered: [] });
    assert.deepEqual(dispatched, ['memory.recall']);
    assert.deepEqual(inserted.map((i) => i.kind), ['model_call', 'tool_call', 'model_call']);
    // Sequence numbers strictly increase — a reader ordering ai.agent_steps by
    // seq gets the true order of a multi-turn run.
    assert.deepEqual(inserted.map((i) => i.seq), [0, 1, 2]);
  });

  test('a model that only ever asks for tools is bounded, not left to run forever', async () => {
    providerState.mode = 'always_tools';
    providerState.calls = 0;

    let dispatchCount = 0;
    const result = await callModelWithTools(
      freshCtx('job-2') as never,
      { systemPrompt: 'sys', schemaName: 'QualificationCoverage' },
      [{ role: 'user', content: 'hi' }],
      [{ name: 'memory.recall', description: 'recall', inputSchema: { type: 'object' } }],
      'run-2',
      async () => {
        dispatchCount += 1;
        return { ok: true, data: '[]' };
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.kind, 'tool_limit_exceeded');
    // Exactly one dispatch per bounded round — a loop that ran away would
    // dispatch far more than four times.
    assert.equal(dispatchCount, 4);
  });

  test('a provider without generateWithTools is refused by name, not by throwing', () => {
    // Not driven through the mock: the module-cache limitation this describe
    // block's own header explains means a THIRD `resolveProvider` behaviour
    // in the same process is not reachable from the already-bound import.
    // Pinned as source instead, the same way `read-failure-semantics.test.ts`
    // pins a rule that has no live path a unit test can reach.
    const source = readFileSync(fileURLToPath(new URL('../app/api/jobs/run/agent-run.ts', import.meta.url)), 'utf8');
    assert.match(source, /if \(!provider\.data\.generateWithTools\) \{/);
    assert.match(source, /does not support tool calling/);
  });
});
