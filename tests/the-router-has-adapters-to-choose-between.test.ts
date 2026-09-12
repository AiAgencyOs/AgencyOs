import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';

/**
 * The router has adapters to choose between — G-238, ADM-85.
 *
 * ADM-85 recorded the honest limit of the provider port while it had one
 * adapter: "the provider abstraction remains ASSERTED RATHER THAN
 * DEMONSTRATED. resolveProvider has never had two adapters to choose
 * between." This file is the demonstration. One stand-in HTTP server speaks
 * the chat-completions wire; four vendor configurations point at it; the
 * router is asked by model id and answers with the vendor — and every answer
 * the wire can give (a refusal, a truncation, a 401, a 429 worth one retry,
 * an echoed key) becomes the sentence the job records.
 *
 * Executed throughout: the request bodies are read off the wire, not off the
 * source.
 */

// env.ts parses the public variables at import; placeholders that never
// reach a network, the way tests/ai-extraction.test.ts does it.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

type Reply = { status: number; body: unknown };

let server: Server;
let baseURL: string;
let requests = 0;
let replies: Reply[] = [];
let lastRequest: { body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> } = { body: {}, headers: {} };
/** When > 0, the next N responses send headers, then destroy the socket mid-body. */
let dropNextBodies = 0;

const completion = (content: string, over: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-test',
  model: 'served-model',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 13, completion_tokens: 5 },
  ...over,
});

function willReply(...queue: Reply[]) {
  replies = queue;
  requests = 0;
}

before(async () => {
  server = createServer((req, res) => {
    requests += 1;
    const reply = replies[Math.min(requests - 1, replies.length - 1)] ?? { status: 500, body: { error: { message: 'no reply queued' } } };
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      lastRequest = { body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, headers: req.headers };
      if (dropNextBodies > 0) {
        dropNextBodies -= 1;
        res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': '1000' });
        res.write('{"partial":');
        res.socket?.destroy();
        return;
      }
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseURL = `http://127.0.0.1:${address.port}`;

  // Stand-in keys that never leave this machine; every base URL is the stub.
  // XAI_API_KEY is deliberately ABSENT, so one vendor is the unconfigured case.
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-not-a-real-credential';
  process.env.ANTHROPIC_BASE_URL = baseURL;
  process.env.OPENAI_API_KEY = 'sk-test-openai-not-a-real-credential';
  process.env.OPENAI_BASE_URL = baseURL;
  process.env.GEMINI_API_KEY = 'AIzaTESTgemini-not-a-real-credential-0000';
  process.env.GEMINI_BASE_URL = baseURL;
  process.env.OPENROUTER_API_KEY = 'sk-or-test-openrouter-not-a-real-credential';
  process.env.OPENROUTER_BASE_URL = baseURL;
  delete process.env.XAI_API_KEY;
});

after(async () => {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'GEMINI_BASE_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL']) delete process.env[k];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function router() {
  return import('../src/lib/ai/router.ts');
}

const request = (model: string, over: Record<string, unknown> = {}) => ({
  model,
  system: 'extract',
  messages: [{ role: 'user' as const, content: 'we need a website' }],
  jsonSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  schemaName: 'RequirementPayload',
  ...over,
});

describe('A. the router chooses by model id, and names what it has', () => {
  test('five ids, five vendors — and the one without a key is not registered', async () => {
    const { resolveProvider, configuredProviders } = await router();
    assert.deepEqual([...configuredProviders()], ['anthropic', 'openai', 'gemini', 'openrouter']);
    const pick = (model: string) => { const r = resolveProvider(model); return r.ok ? r.data.id : `error: ${r.error.message}`; };
    assert.equal(pick('claude-sonnet-5'), 'anthropic');
    assert.equal(pick('gpt-5'), 'openai');
    assert.equal(pick('o3-mini'), 'openai');
    assert.equal(pick('gemini-2.5-pro'), 'gemini');
    assert.equal(pick('meta-llama/llama-3.1-70b'), 'openrouter');
    assert.equal(pick('openai/gpt-4o'), 'openrouter', 'a slash is OpenRouter’s namespace even when the vendor before it has a direct account');
    assert.match(pick('grok-4'), /No configured AI provider serves model "grok-4" \(registered: anthropic, openai, gemini, openrouter\)/);
    assert.match(pick('mistral-large'), /registered: anthropic, openai, gemini, openrouter/);
  });
});

describe('B. what goes over the wire', () => {
  test('a system message first, the schema by name, the key as a bearer — and the answer parsed with its usage', async () => {
    const { resolveProvider } = await router();
    willReply({ status: 200, body: completion('{"summary":"a website"}') });
    const provider = resolveProvider('gpt-4o');
    assert.ok(provider.ok);
    const result = await provider.data.generateStructured(request('gpt-4o', { effort: 'high' }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data.json, { summary: 'a website' });
    assert.equal(result.data.model, 'served-model');
    assert.deepEqual(result.data.usage, { inputTokens: 13, outputTokens: 5, costMinor: 0 });
    assert.equal(requests, 1, 'a success is not retried');
    const messages = lastRequest.body.messages as Array<{ role: string; content: unknown }>;
    assert.deepEqual(messages[0], { role: 'system', content: 'extract' });
    assert.deepEqual(messages[1], { role: 'user', content: 'we need a website' });
    assert.deepEqual(lastRequest.body.response_format, { type: 'json_schema', json_schema: { name: 'RequirementPayload', schema: request('x').jsonSchema } });
    assert.equal(lastRequest.headers.authorization, 'Bearer sk-test-openai-not-a-real-credential');
    assert.equal('reasoning_effort' in lastRequest.body, false, 'a chat model is not sent a parameter it rejects');
    // Review: OpenAI retired max_tokens for its reasoning family; every current
    // model takes max_completion_tokens, and the compatible endpoints take max_tokens.
    assert.equal(lastRequest.body.max_completion_tokens, 8_000);
    assert.equal('max_tokens' in lastRequest.body, false);
  });

  test('effort reaches a reasoning model as reasoning_effort, capped at high; Gemini and OpenRouter are never sent it', async () => {
    const { resolveProvider } = await router();
    willReply({ status: 200, body: completion('{}') });
    const openai = resolveProvider('o3');
    assert.ok(openai.ok);
    await openai.data.generateStructured(request('o3', { effort: 'xhigh' }));
    assert.equal(lastRequest.body.reasoning_effort, 'high');
    await openai.data.generateStructured(request('gpt-5-mini', { effort: 'low' }));
    assert.equal(lastRequest.body.reasoning_effort, 'low');
    await openai.data.generateStructured(request('gpt-5-chat-latest', { effort: 'high' }));
    assert.equal('reasoning_effort' in lastRequest.body, false, 'the chat variant of the family is not a reasoning model');
    const gemini = resolveProvider('gemini-2.5-flash');
    assert.ok(gemini.ok);
    await gemini.data.generateStructured(request('gemini-2.5-flash', { effort: 'high' }));
    assert.equal('reasoning_effort' in lastRequest.body, false);
    assert.equal(lastRequest.body.max_tokens, 8_000, 'the compatible endpoints take max_tokens');
    const openrouter = resolveProvider('anthropic/claude-3.5');
    assert.ok(openrouter.ok);
    await openrouter.data.generateStructured(request('anthropic/claude-3.5', { effort: 'high' }));
    assert.equal('reasoning_effort' in lastRequest.body, false);
    assert.equal(lastRequest.headers['x-title'], 'AgencyOS', 'OpenRouter attributes traffic by its headers');
  });

  test('an image block becomes a data URL the wire understands, and the bytes are not kept', async () => {
    const { resolveProvider } = await router();
    willReply({ status: 200, body: completion('{}') });
    const provider = resolveProvider('gemini-2.5-pro');
    assert.ok(provider.ok);
    await provider.data.generateStructured(request('gemini-2.5-pro', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'this' }, { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }] }],
    }));
    const messages = lastRequest.body.messages as Array<{ role: string; content: unknown }>;
    assert.deepEqual(messages[1]!.content, [
      { type: 'text', text: 'this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });
});

describe('C. answers that are not usable output', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a refusal', { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' } }] }, /declined/i],
    ['a content filter', { choices: [{ index: 0, finish_reason: 'content_filter', message: { role: 'assistant', content: '' } }] }, /declined/i],
    ['running out of output budget', { choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{"partial":' } }] }, /output budget/i],
    ['empty text', { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '   ' } }] }, /no output/i],
    ['no choices at all', { choices: [] }, /no output/i],
    ['prose instead of JSON', { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'I think they want a website.' } }] }, /not valid JSON/i],
  ];
  test('content given as parts is read, not treated as silence', async () => {
    const { resolveProvider } = await router();
    willReply({ status: 200, body: completion('', { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] } }] }) });
    const provider = resolveProvider('openai/gpt-4o');
    assert.ok(provider.ok);
    const result = await provider.data.generateStructured(request('openai/gpt-4o'));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.data.json, { a: 1 });
  });
  for (const [name, over, expected] of cases) {
    test(`${name} is an error, not an extraction — and not retried`, async () => {
      const { resolveProvider } = await router();
      willReply({ status: 200, body: completion('', over) });
      const provider = resolveProvider('gpt-4o');
      assert.ok(provider.ok);
      const result = await provider.data.generateStructured(request('gpt-4o'));
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, expected);
      assert.equal(requests, 1);
    });
  }
});

describe('D. provider failures, said by name, retried only when a moment would help', () => {
  test('a connection dropped mid-body is a Result, never a throw — and it is retried', async () => {
    // Review: the first draft read the body outside the try, so an abort
    // during streaming escaped generateStructured as an exception.
    const { resolveProvider } = await router();
    const provider = resolveProvider('gpt-4o');
    assert.ok(provider.ok);
    dropNextBodies = 1;
    willReply({ status: 200, body: completion('{"ok":true}') });
    const result = await provider.data.generateStructured(request('gpt-4o'));
    assert.equal(result.ok, true, 'the second attempt answered');
    assert.equal(requests, 2);
  });

  test('a rejected key, a missing model, a forbidden model — one request each', async () => {
    const { resolveProvider } = await router();
    const provider = resolveProvider('gpt-4o');
    assert.ok(provider.ok);
    for (const [status, expected] of [[401, /OpenAI API key was rejected/], [404, /ai\.agents\.default_model/], [403, /may not use this model/]] as const) {
      willReply({ status, body: { error: { message: 'no' } } });
      const result = await provider.data.generateStructured(request('gpt-4o'));
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, expected);
      assert.equal(requests, 1, `${status} is not retried`);
    }
  });

  test('a 429 is retried once inside the function, and a second answer is used', async () => {
    const { resolveProvider } = await router();
    const provider = resolveProvider('gemini-2.5-pro');
    assert.ok(provider.ok);
    willReply({ status: 429, body: { error: { message: 'slow down' } } }, { status: 200, body: completion('{"ok":true}') });
    const result = await provider.data.generateStructured(request('gemini-2.5-pro'));
    assert.equal(result.ok, true);
    assert.equal(requests, 2);
  });

  test('a 5xx twice is the queue’s problem after exactly two attempts', async () => {
    const { resolveProvider } = await router();
    const provider = resolveProvider('gpt-4o');
    assert.ok(provider.ok);
    willReply({ status: 503, body: { error: { message: 'down' } } });
    const result = await provider.data.generateStructured(request('gpt-4o'));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /OpenAI returned 503\. The job will be retried/);
    assert.equal(requests, 2);
  });

  test('a 400 carries the vendor’s words, with any key in them redacted', async () => {
    const { resolveProvider } = await router();
    const provider = resolveProvider('openai/gpt-4o');
    assert.ok(provider.ok);
    willReply({ status: 400, body: { error: { message: 'Invalid schema for key sk-or-test-openrouter-not-a-real-credential and sk-abcdefghijklmnop: field "x"' } } });
    const result = await provider.data.generateStructured(request('openai/gpt-4o'));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /OpenRouter returned 400: Invalid schema for key \[redacted\] and \[redacted\]: field "x"/);
      assert.doesNotMatch(result.error.message, /not-a-real-credential|abcdefghijklmnop/);
    }
    assert.equal(requests, 1, 'a malformed request is never retried');
  });
});
