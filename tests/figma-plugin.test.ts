import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, mock, test } from 'node:test';

const env: Record<string, string | undefined> = { VAULT_ENCRYPTION_KEY: 'test-vault-key-for-figma-codes-0123456789', CRON_SECRET: undefined };
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: unknown = [{ outcome: 'recorded', import_id: 'imp-1' }];
let exportResult: unknown = null;

mock.module('server-only', { exports: {} });
mock.module('@/lib/env', { exports: { serverEnv: () => env } });
mock.module('@/lib/db/admin', {
  exports: {
    createAdminClient: () => ({ schema: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { rpcCalls.push({ fn, args }); return { data: rpcResult, error: null }; } }) }),
  },
});
mock.module('@/modules/projects/figma-export', { exports: { buildFigmaExport: async () => exportResult } });

const { signFigmaCode, verifyFigmaCode } = await import('../src/modules/projects/figma-export-token.ts');
const reportRoute = await import('../app/api/design/figma/[projectId]/report/route.ts');
const readRoute = await import('../app/api/design/figma/[projectId]/route.ts');

const require = createRequire(import.meta.url);
const plugin = require('../figma-plugin/code.js') as {
  buildSpec: (p: unknown) => { pageName: string; frames: Array<{ key: string; screenId: string | null; name: string; x: number; y: number; w: number; h: number; children: Array<{ type: string; y: number; h?: number }> }> };
  render: (figma: unknown, spec: unknown) => Promise<{ fileKey: string | null; pageId: string; pageName: string; frames: Array<{ key: string; nodeId: string }> }>;
  paletteOf: (d: unknown) => Record<string, string>;
  isWide: (s: unknown) => boolean;
  hex: (v: unknown, f: string) => string;
};

const ORG = '00000000-0000-4000-8000-000000000001';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const now = 1_800_000_000;

describe('the plugin code', () => {
  const key = env.VAULT_ENCRYPTION_KEY as string;

  test('a code round-trips to exactly the project and organization it was made for', () => {
    const claim = verifyFigmaCode(signFigmaCode({ organizationId: ORG, projectId: PROJECT }, key, now), key, now + 60);
    assert.deepEqual(claim, { organizationId: ORG, projectId: PROJECT, expiresAt: now + 24 * 3600 });
  });

  test('it expires, cannot be edited into another project, and is refused under another key', () => {
    const code = signFigmaCode({ organizationId: ORG, projectId: PROJECT }, key, now);
    assert.equal(verifyFigmaCode(code, key, now + 24 * 3600 + 1), null, 'expired');
    const [payload, sig] = code.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ o: ORG, p: OTHER, x: now + 99999, u: 'figma-import' })).toString('base64url');
    assert.equal(verifyFigmaCode(`${forged}.${sig}`, key, now), null, 'edited payload');
    assert.equal(verifyFigmaCode(`${payload}.${sig.slice(0, -2)}xx`, key, now), null, 'edited signature');
    assert.equal(verifyFigmaCode(code, 'a-different-key', now), null, 'wrong key');
    assert.equal(verifyFigmaCode('', key, now), null);
    assert.equal(verifyFigmaCode('garbage', key, now), null);
    assert.throws(() => signFigmaCode({ organizationId: ORG, projectId: PROJECT }, '', now), /no signing key/);
  });
});

describe('the routes the plugin calls', () => {
  const key = env.VAULT_ENCRYPTION_KEY as string;
  const validCode = () => signFigmaCode({ organizationId: ORG, projectId: PROJECT }, key, Math.floor(Date.now() / 1000));
  const req = (url: string, init: RequestInit & { code?: string | null } = {}) =>
    new Request(url, { ...init, headers: { ...(init.code === null ? {} : { authorization: `Bearer ${init.code ?? validCode()}` }), 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const params = (id: string) => ({ params: Promise.resolve({ projectId: id }) });
  const frame = { key: 'S-1', screenId: null, name: 'S-1 - Home', nodeId: '12:34' };

  test('reading needs a genuine code for THAT project', async () => {
    exportResult = { version: 1, screens: [] };
    assert.equal((await readRoute.GET(req('http://x/api', { code: null }), params(PROJECT))).status, 401);
    assert.equal((await readRoute.GET(req('http://x/api', { code: 'nope' }), params(PROJECT))).status, 401);
    assert.equal((await readRoute.GET(req('http://x/api'), params(OTHER))).status, 403, 'a code for one project cannot read another');
    const ok = await readRoute.GET(req('http://x/api'), params(PROJECT));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    exportResult = null;
    assert.equal((await readRoute.GET(req('http://x/api'), params(PROJECT))).status, 404, 'an unknown project is a 404, not an empty success');
  });

  test('answers the preflight for the plugin iframe, and sets no cookie-based authority', async () => {
    const pre = readRoute.OPTIONS();
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/);
    const res = await readRoute.GET(req('http://x/api'), params(PROJECT));
    assert.equal(res.headers.get('set-cookie'), null);
  });

  test('a report is recorded under the code\'s own organization - never one the body names', async () => {
    rpcCalls = [];
    rpcResult = [{ outcome: 'recorded', import_id: 'imp-1' }];
    const res = await reportRoute.POST(req('http://x/api', { method: 'POST', body: JSON.stringify({ fileKey: 'AbC123xyz', pageId: '5:1', pageName: 'AgencyOS - Demo', frames: [frame], organizationId: OTHER }) }), params(PROJECT));
    assert.equal(res.status, 200);
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0]?.args.p_organization_id, ORG);
    assert.equal(rpcCalls[0]?.args.p_project_id, PROJECT);
    assert.equal(rpcCalls[0]?.args.p_file_key, 'AbC123xyz');
  });

  test('a malformed, empty, oversize or unauthorised report records nothing', async () => {
    rpcCalls = [];
    const post = (body: unknown, code?: string | null) => reportRoute.POST(req('http://x/api', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), code }), params(PROJECT));
    assert.equal((await post({ frames: [] })).status, 400, 'no frames');
    assert.equal((await post({ frames: [{ ...frame, nodeId: 'drop table;' }] })).status, 400, 'a node id that is not a Figma node id');
    assert.equal((await post({ fileKey: 'bad key!', frames: [frame] })).status, 400, 'a file key that is not a file key');
    assert.equal((await post({ frames: Array.from({ length: 401 }, () => frame) })).status, 400, 'more than 400 frames');
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post('x'.repeat(200_001))).status, 413);
    assert.equal((await post({ frames: [frame] }, null)).status, 401);
    assert.equal(rpcCalls.length, 0, 'none of them reached the database');
    rpcResult = [{ outcome: 'unknown_project', import_id: null }];
    assert.equal((await post({ frames: [frame] })).status, 404);
  });
});

describe('what the plugin draws', () => {
  const screen = (over: Record<string, unknown> = {}) => ({
    id: 'sid-1', key: 'SCR-001', name: 'Order medicines', role: 'customer', purpose: 'Search and order', entryPoint: null, exitAction: null,
    requiredData: 'Medicine name; Price; Stock', actions: 'Add to basket; Pay', components: ['Search bar', 'Product card'], devices: ['mobile'],
    states: { has_empty_state: true, has_loading_state: true, has_error_state: false, has_success_state: false }, figmaUrl: null, ...over,
  });
  const payload = (screens: unknown[], direction: unknown = null) => ({ version: 1, project: { id: PROJECT, name: 'Pharmacy' }, baselineVersion: 1, direction, screens });

  test('one direction frame, one frame per screen, and one per state the screen must handle - each named by its key', () => {
    const spec = plugin.buildSpec(payload([screen(), screen({ id: 'sid-2', key: 'SCR-002', name: 'Admin', devices: ['desktop'], states: { has_empty_state: false, has_loading_state: false, has_error_state: false, has_success_state: false } })]));
    assert.deepEqual(spec.frames.map((f) => f.key), ['direction', 'SCR-001', 'SCR-001:empty', 'SCR-001:loading', 'SCR-002']);
    assert.ok(spec.frames.every((f) => f.key === 'direction' || f.name.startsWith(f.key.split(':')[0] as string)), 'every frame name starts with its screen key, so AgencyOS can match it back');
    assert.equal(spec.pageName, 'AgencyOS - Pharmacy');
  });

  test('desktop screens are wide, phones are phone-sized, and a screen for both is a phone', () => {
    assert.equal(plugin.isWide({ devices: ['desktop'] }), true);
    assert.equal(plugin.isWide({ devices: ['web', 'mobile'] }), false);
    assert.equal(plugin.isWide({ devices: [] }), false);
    const spec = plugin.buildSpec(payload([screen(), screen({ id: 'b', key: 'SCR-002', devices: ['desktop'] })]));
    const byKey = Object.fromEntries(spec.frames.map((f) => [f.key, f]));
    assert.deepEqual([byKey['SCR-001']?.w, byKey['SCR-001']?.h], [390, 844]);
    assert.deepEqual([byKey['SCR-002']?.w, byKey['SCR-002']?.h], [1280, 800]);
  });

  test('colours come from the client\'s palette; anything that is not a hex colour falls back and never reaches the file', () => {
    const pal = plugin.paletteOf({ palette: { primary: '#AA00BB', secondary: 'not-a-colour', accent: null, background: '112233' } });
    assert.equal(pal.primary, '#aa00bb');
    assert.equal(pal.background, '#112233');
    assert.equal(pal.secondary, '#aa00bb', 'a bad secondary falls back to the primary, not to junk');
    assert.equal(plugin.hex('javascript:alert(1)', '#000000'), '#000000');
    assert.equal(plugin.paletteOf(null).primary, '#2f5bea', 'no direction: neutral colours, never a crash');
  });

  test('the layout is deterministic, frames never overlap, and nothing is drawn below the bottom of its frame', () => {
    const p = payload([screen(), screen({ id: 'b', key: 'SCR-002', requiredData: Array.from({ length: 30 }, (_, i) => `Field ${i}`).join(';') })]);
    const a = plugin.buildSpec(p);
    assert.deepEqual(a, plugin.buildSpec(p));
    const frames = a.frames;
    for (let i = 0; i < frames.length; i += 1) {
      for (let j = i + 1; j < frames.length; j += 1) {
        const f = frames[i]!;
        const g = frames[j]!;
        const apart = f.x + f.w <= g.x || g.x + g.w <= f.x || f.y + f.h <= g.y || g.y + g.h <= f.y;
        assert.ok(apart, `${f.key} and ${g.key} overlap`);
      }
    }
    for (const f of frames) for (const c of f.children) if (c.type === 'rect' && c.h && c.y > 0) assert.ok(c.y + c.h <= f.h, `${f.key}: a block hangs out of the frame`);
  });

  test('with no finalized screen the plugin draws only the direction; with no direction it still draws the screens', () => {
    assert.deepEqual(plugin.buildSpec(payload([])).frames.map((f) => f.key), ['direction']);
    assert.equal(plugin.buildSpec(payload([screen()], null)).frames.length >= 2, true);
  });

  test('render drives the Figma API and reports one node id per frame, in the shape the report accepts', async () => {
    const spec = plugin.buildSpec(payload([screen()]));
    let n = 0;
    const node = () => ({ id: `${(n += 1)}:${n}`, x: 0, y: 0, height: 20, children: [] as unknown[], appendChild(c: unknown) { this.children.push(c); }, resize() {} });
    const page = { ...node(), name: '' };
    const fake = {
      fileKey: 'FileKey123',
      loadFontAsync: async () => undefined,
      createPage: () => page,
      setCurrentPageAsync: async () => undefined,
      createFrame: () => node(),
      createRectangle: () => node(),
      createText: () => node(),
      viewport: { scrollAndZoomIntoView() {} },
    };
    const report = await plugin.render(fake, spec);
    assert.equal(report.frames.length, spec.frames.length);
    assert.equal(report.pageName, 'AgencyOS - Pharmacy');
    assert.ok(report.frames.every((f) => /^[A-Za-z0-9:;_-]{1,40}$/.test(f.nodeId)));
    assert.equal(report.fileKey, 'FileKey123');
  });
});

describe('the plugin package and its place in AgencyOS', () => {
  const manifest = JSON.parse(readFileSync('figma-plugin/manifest.json', 'utf8')) as { main: string; ui: string; networkAccess: { allowedDomains: string[]; reasoning: string } };
  test('the manifest points at files that exist and says why it needs the network', () => {
    assert.equal(readFileSync(`figma-plugin/${manifest.main}`, 'utf8').length > 100, true);
    assert.equal(readFileSync(`figma-plugin/${manifest.ui}`, 'utf8').length > 100, true);
    assert.ok(manifest.networkAccess.reasoning.length > 30);
  });
  test('the UI sends the code only as an Authorization header - never in a URL', () => {
    const ui = readFileSync('figma-plugin/ui.html', 'utf8');
    assert.match(ui, /Authorization: `Bearer/);
    assert.ok(!/\?.*token|\?code=|token=\$\{/.test(ui));
  });
  test('the Figma tab is reachable from the Design sub-navigation, and the page asks for project access', () => {
    assert.match(readFileSync('app/(internal)/projects/[projectId]/design/design-subnav.tsx', 'utf8'), /\/figma`, label: 'Figma'/);
    assert.match(readFileSync('app/(internal)/projects/[projectId]/design/figma/actions.ts', 'utf8'), /can\(context, 'project\.write'\)/);
  });
});
