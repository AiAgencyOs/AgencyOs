import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

/**
 * A reference is not the design — G-308, ADM-111.
 *
 * Designer §9's Image Generation Policy: optional support, never a substitute
 * for the canonical Figma artifact. Two halves. A stand-in HTTP server proves
 * `createOpenRouterImageGenerator` speaks the wire this port assumes — the
 * dedicated `/images` endpoint, not the chat-completions one `providers.ts`
 * already speaks, per the same "demonstrated, not asserted" discipline
 * `the-router-has-adapters-to-choose-between.test.ts` established. The
 * structural half walks the workflow and migration source for the properties
 * a live database and a wire stub cannot both prove in one file: that a
 * missing generator never fails the run, that the reuse key is the SAME
 * function theme_options uses rather than a second one, and that nothing here
 * claims a generated image is canonical.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

type Reply = { status: number; body: unknown };

let server: Server;
let baseURL: string;
let lastRequest: { path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> } = { path: '', body: {}, headers: {} };
let reply: Reply = { status: 200, body: {} };

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      lastRequest = { path: req.url ?? '', body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, headers: req.headers };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseURL = `http://127.0.0.1:${address.port}`;

  process.env.OPENROUTER_API_KEY = 'sk-or-test-openrouter-not-a-real-credential';
  process.env.OPENROUTER_BASE_URL = baseURL;
});

after(async () => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function generator() {
  const { createOpenRouterImageGenerator } = await import('../src/lib/ai/openrouter-image.ts');
  const made = await createOpenRouterImageGenerator();
  assert.ok(made, 'generator should exist when a key is configured');
  return made;
}

describe('A. the wire — a dedicated endpoint, not the chat-completions one', () => {
  test('POSTs to /images, not /chat/completions, with model and prompt', async () => {
    reply = { status: 200, body: { data: [{ b64_json: 'aW1hZ2U=', media_type: 'image/png' }], usage: { cost: 0.02 } } };
    const g = await generator();
    const result = await g.generateImage({ model: 'google/gemini-2.5-flash-image', prompt: 'a calm blue mood board' });

    assert.equal(lastRequest.path, '/images');
    assert.equal(lastRequest.body.model, 'google/gemini-2.5-flash-image');
    assert.equal(lastRequest.body.prompt, 'a calm blue mood board');
    assert.equal(lastRequest.headers.authorization, 'Bearer sk-or-test-openrouter-not-a-real-credential');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.imageBase64, 'aW1hZ2U=');
      assert.equal(result.mediaType, 'image/png');
      // Real cost IS in the response and is deliberately NOT converted to
      // costMinor — see openrouter-image.ts's own comment on why.
      assert.equal(result.usage.costMinor, 0);
    }
  });

  test('response_format is never sent — the image endpoint has no such parameter', async () => {
    reply = { status: 200, body: { data: [{ b64_json: 'eA==', media_type: 'image/png' }] } };
    const g = await generator();
    await g.generateImage({ model: 'x', prompt: 'y' });
    assert.equal(lastRequest.body.response_format, undefined);
  });
});

describe('B. answers that are not a usable image', () => {
  test('a refusal is an error, never a silent placeholder', async () => {
    reply = { status: 401, body: { error: { message: 'invalid key' } } };
    const g = await generator();
    const result = await g.generateImage({ model: 'x', prompt: 'y' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.permanent, true);
      assert.doesNotMatch(result.message, /invalid key/);
    }
  });

  test('a 429 is transient, not permanent', async () => {
    reply = { status: 429, body: { error: { message: 'slow down' } } };
    const g = await generator();
    const result = await g.generateImage({ model: 'x', prompt: 'y' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.permanent, false);
  });

  test('a media type this port does not recognise is refused rather than passed through', async () => {
    reply = { status: 200, body: { data: [{ b64_json: 'eA==', media_type: 'image/svg+xml' }] } };
    const g = await generator();
    const result = await g.generateImage({ model: 'x', prompt: 'y' });
    assert.equal(result.ok, false);
  });

  // "No key, no generator" is not re-tested here: serverEnv() caches its
  // parse for the life of the process (env.ts), so unsetting a variable
  // mid-file after an earlier test has already read it would prove nothing —
  // the same reason the router test file sets its env once, at the top,
  // before any import. `createOpenRouterImageGenerator` shares `keyFor` with
  // every other provider in `providers.ts`, and that contract (env, then the
  // vault, then null) is exercised there.
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = read('app/api/jobs/run/workflows.ts');
const MIGRATION = read('supabase/migrations/20260920160000_a_reference_is_not_the_design.sql');
const TYPES = read('src/lib/ai/types.ts');

describe('C. the workflow — optional support, never blocking', () => {
  test('the reuse key is the SAME function theme_options uses, not a second hash', () => {
    assert.match(MIGRATION, /v_context := projects\.design_context_version\(p_project_id\);/);
    assert.doesNotMatch(MIGRATION, /create (or replace )?function projects\.design_(asset|image)_context/);
  });

  test('a missing or failed generator never fails the run that proposed the directions', () => {
    const start = WORKFLOWS.indexOf('// Designer §9');
    const section = WORKFLOWS.slice(start, WORKFLOWS.indexOf('await succeedRun(admin, runId, validated.data', start));
    assert.doesNotMatch(section, /await failJob/);
    assert.doesNotMatch(section, /finishRun\(admin, runId, 'failed'/);
  });

  test('the reuse check happens BEFORE the model is asked — the door would refuse anyway, and a refused insert has already paid for the tokens', () => {
    const start = WORKFLOWS.indexOf('// Designer §9');
    const section = WORKFLOWS.slice(start, WORKFLOWS.indexOf('await succeedRun(admin, runId, validated.data', start));
    assert.ok(section.indexOf("from('design_assets')") < section.indexOf('resolveImageGenerator()'));
    assert.ok(section.indexOf('resolveImageGenerator()') < section.indexOf('generateImage('));
  });

  test('the door carries the service-role escape from the start, not rediscovered later (G-303s lesson)', () => {
    assert.match(MIGRATION, /if v_actor is null and \(select auth\.role\(\)\) is distinct from 'service_role' then/);
  });
});

describe('D. the port — a fourth capability, not a method bolted onto AiProvider', () => {
  test('AiImageGenerator is its own interface', () => {
    assert.match(TYPES, /export interface AiImageGenerator \{/);
    const provider = TYPES.slice(TYPES.indexOf('export interface AiProvider'), TYPES.indexOf('export interface AiProvider') + 800);
    assert.doesNotMatch(provider, /generateImage/);
  });
});
