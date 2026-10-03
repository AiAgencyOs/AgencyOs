import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';

import { createChatCompletionsProvider } from '../src/lib/ai/chat-completions.ts';
import type { ToolUseRequest } from '../src/lib/ai/types.ts';

// Tool calling used to exist only on the Anthropic adapter, so every
// tool-using agent (qualifier, quotation drafter, ...) could run on nothing
// else and "use OpenAI / OpenRouter for this agent" was not a setting but a
// refusal. The chat-completions adapter now carries it.

const provider = createChatCompletionsProvider({
  id: 'openrouter', name: 'OpenRouter', baseUrl: 'http://stub.invalid/v1', apiKey: 'k', supports: () => true, keyPatterns: [],
});

const tools = [{ name: 'crm.read_thread', description: 'reads', inputSchema: { type: 'object', properties: {} } }];
const base: ToolUseRequest = { model: 'openai/gpt-x', system: 's', messages: [{ role: 'user', content: 'hi' }], tools };

describe('tool calling over the chat-completions wire', () => {
  afterEach(() => mock.restoreAll());

  const answer = (body: unknown) => {
    const seen: Array<Record<string, unknown>> = [];
    mock.method(globalThis, 'fetch', async (_url: unknown, init?: { body?: string }) => {
      seen.push(JSON.parse(init?.body ?? '{}'));
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return seen;
  };

  test('the tools go out in the function shape, with wire-safe names', async () => {
    const seen = answer({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
    await provider.generateWithTools!(base);
    const t = (seen[0]!.tools as Array<{ type: string; function: { name: string } }>)[0]!;
    assert.equal(t.type, 'function');
    assert.doesNotMatch(t.function.name, /\./, 'a dotted name is refused by the vendors');
  });

  test('a model that asks for a tool is answered with tool_calls, arguments parsed, name restored', async () => {
    answer({
      model: 'openai/gpt-x',
      usage: { prompt_tokens: 5, completion_tokens: 3 },
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'crm__read_thread', arguments: '{"limit":3}' } },
      ] } }],
    });
    const r = await provider.generateWithTools!(base);
    assert.ok(r.ok);
    assert.equal(r.data.kind, 'tool_calls');
    if (r.data.kind === 'tool_calls') {
      assert.equal(r.data.calls[0]!.id, 'call_1');
      assert.deepEqual(r.data.calls[0]!.input, { limit: 3 });
      assert.equal(r.data.calls[0]!.name, 'crm.read_thread');
    }
  });

  test('without tool calls the answer is final text', async () => {
    answer({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
    const r = await provider.generateWithTools!(base);
    assert.ok(r.ok && r.data.kind === 'final' && r.data.text === '{"ok":true}');
  });

  test('broken tool arguments are a refusal, not a call with made-up input', async () => {
    answer({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
      { id: 'c', type: 'function', function: { name: 'crm__read_thread', arguments: '{nope' } },
    ] } }] });
    const r = await provider.generateWithTools!(base);
    assert.equal(r.ok, false);
  });

  test('the transcript replays the call and its result in the order the wire requires', async () => {
    const seen = answer({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] });
    await provider.generateWithTools!({
      ...base,
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'crm.read_thread', input: { limit: 3 } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'thread text' }] },
      ],
    });
    const m = seen[0]!.messages as Array<Record<string, unknown>>;
    assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'tool']);
    const asst = m[2] as { tool_calls: Array<{ id: string; function: { arguments: string } }> };
    assert.equal(asst.tool_calls[0]!.id, 'call_1');
    assert.equal(asst.tool_calls[0]!.function.arguments, '{"limit":3}');
    assert.equal((m[3] as { tool_call_id: string }).tool_call_id, 'call_1');
  });

  test('the final-answer schema rides along only when one was given', async () => {
    let seen = answer({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] });
    await provider.generateWithTools!({ ...base, jsonSchema: { type: 'object' } });
    assert.ok(seen[0]!.response_format);
    mock.restoreAll();
    seen = answer({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] });
    await provider.generateWithTools!(base);
    assert.equal(seen[0]!.response_format, undefined);
  });
});
