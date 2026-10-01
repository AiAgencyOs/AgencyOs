import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { AgentBudgetRefusal } from '@/lib/ai/run-gates';
import { can } from '@/lib/authz/permissions';
import { embeddableText, looksLikeCredential } from '@/lib/search/embeddable-text';
import type { IndexDeps, IndexStore, SourceRow } from '@/lib/search/semantic-indexer';
import { mergeResults, parseMode, passesConditions } from '@/lib/search/semantic-results';
import { SEMANTIC_SOURCES } from '@/lib/search/semantic-sources';

// assembled at run time so the repository's secret scan does not read a fixture as a key
const FAKE_KEY = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUV'].join('-');

// The indexer module reads the public environment when loaded; nothing here calls out.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key-not-used';
const { indexPage, runIndexingTick } = await import('@/lib/search/semantic-indexer');

const DIMS = 16;
/** A deterministic fake embedding: each word lands in a slot; "car" and "automobile" are one concept. */
function fakeEmbed(texts: string[]) {
  const calls: string[] = [];
  const embed = async (batch: string[]) => {
    calls.push(...batch);
    return {
      vectors: batch.map((t) => {
        const v = new Array(DIMS).fill(0);
        for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) v[createHash('sha256').update(w === 'automobile' ? 'car' : w).digest()[0]! % DIMS] += 1;
        return v;
      }),
      tokens: batch.length * 5,
    };
  };
  void texts;
  return { embed, calls };
}

function memoryStore(rows: SourceRow[]) {
  const stored = new Map<string, { hash: string; vector: number[] }>();
  const store: IndexStore = {
    readPage: async (_g, after, limit) => rows.filter((r) => after === null || r.id > after).slice(0, limit),
    storedHashes: async (_g, ids) => new Map(ids.filter((i) => stored.has(i)).map((i) => [i, stored.get(i)!.hash])),
    upsert: async (_g, batch) => void batch.forEach((b) => stored.set(b.id, { hash: b.hash, vector: b.vector })),
    remove: async (_g, ids) => void ids.forEach((i) => stored.delete(i)),
  };
  return { store, stored };
}

const deps = (store: IndexStore, embed: IndexDeps['embed'], over: Partial<IndexDeps> = {}): IndexDeps => ({
  store, embed, model: 'fake', dimensions: DIMS, pricePerMtokMinor: null, gate: async () => undefined, recordUsage: async () => undefined, ...over,
});

const row = (id: string, name: string, extra: Record<string, string> = {}): SourceRow => ({ id, fields: { name, ...extra }, deleted: false });

describe('what may be embedded', () => {
  test('a field that is a credential is withheld, the rest is kept', () => {
    const r = embeddableText('Client', { name: 'Acme', notes: 'password: hunter2hunter2', key: FAKE_KEY });
    assert.deepEqual(r.withheld, ['notes', 'key']);
    assert.equal(r.text, 'Client\nname: Acme');
  });
  test('a record that is only credentials yields no text at all', () => {
    assert.equal(embeddableText('Client', { a: 'token=abcdef123456' }).text, null);
    assert.equal(looksLikeCredential('a perfectly ordinary sentence'), false);
  });
  test('no source lists a secret-bearing column', () => {
    const all = SEMANTIC_SOURCES.map((s) => s.columns).join(',');
    for (const banned of ['gstin', 'pan,', 'billing_address', 'storage_path', 'url', 'ciphertext', 'billing_email']) assert.ok(!all.includes(banned), banned);
  });
});

describe('the indexing job', () => {
  test('embeds new records once and skips them by content hash afterwards', async () => {
    const { store } = memoryStore([row('1', 'Automobile dealer'), row('2', 'Bakery')]);
    const f = fakeEmbed([]);
    const d = deps(store, f.embed);
    const first = await indexPage(d, 'Client', await store.readPage('Client', null, 10));
    assert.equal(first.embedded, 2);
    const second = await indexPage(d, 'Client', await store.readPage('Client', null, 10));
    assert.equal(second.embedded, 0);
    assert.equal(second.unchanged, 2);
    assert.equal(f.calls.length, 2);
  });
  test('a changed record is embedded again, only that one', async () => {
    const rows = [row('1', 'Dealer'), row('2', 'Bakery')];
    const { store } = memoryStore(rows);
    const f = fakeEmbed([]);
    const d = deps(store, f.embed);
    await indexPage(d, 'Client', rows);
    rows[0] = row('1', 'Dealer Ltd');
    const again = await indexPage(d, 'Client', rows);
    assert.equal(again.embedded, 1);
  });
  test('a credential never reaches the embedder, and a record that becomes unsafe loses its vector', async () => {
    const rows = [row('1', 'Acme'), row('2', 'Zed')];
    const { store, stored } = memoryStore(rows);
    const f = fakeEmbed([]);
    const d = deps(store, f.embed);
    await indexPage(d, 'Client', rows);
    assert.ok(stored.has('2'));
    const out = await indexPage(d, 'Client', [row('1', 'Acme'), { id: '2', fields: { name: FAKE_KEY }, deleted: false }]);
    assert.equal(out.removed, 1);
    assert.ok(!stored.has('2'));
    assert.ok(!f.calls.some((t) => t.includes('sk-ant')));
  });
  test('a deleted record is removed', async () => {
    const rows = [row('1', 'Acme')];
    const { store, stored } = memoryStore(rows);
    const d = deps(store, fakeEmbed([]).embed);
    await indexPage(d, 'Lead', rows);
    await indexPage(d, 'Lead', [{ ...rows[0]!, deleted: true }]);
    assert.equal(stored.size, 0);
  });
  test('a refused budget stops the tick before any embedding is made', async () => {
    const { store, stored } = memoryStore([row('1', 'Acme')]);
    const f = fakeEmbed([]);
    const refuse = async () => {
      throw new AgentBudgetRefusal({ agentKey: 'semantic_indexer', provider: 'openai', runId: null, capMinor: 1, spentMinor: 5, reason: 'provider "openai" has reached its monthly budget' });
    };
    const r = await runIndexingTick(deps(store, f.embed, { gate: refuse }), { status: 'requested', cursors: {}, passes: {} }, ['Client']);
    assert.equal(r.state.status, 'blocked');
    assert.match(r.blockedReason ?? '', /monthly budget/);
    assert.equal(f.calls.length, 0);
    assert.equal(stored.size, 0);
  });
  test('the ledger is told what each call used', async () => {
    const { store } = memoryStore([row('1', 'Acme')]);
    const used: number[][] = [];
    const d = deps(store, fakeEmbed([]).embed, { pricePerMtokMinor: 2_000_000, recordUsage: async (t, c) => void used.push([t, c]) });
    await indexPage(d, 'Client', await store.readPage('Client', null, 5));
    assert.deepEqual(used, [[5, 10]]);
  });
  test('a tick walks every group and ends done', async () => {
    const { store } = memoryStore([row('1', 'Acme')]);
    const r = await runIndexingTick(deps(store, fakeEmbed([]).embed), { status: 'requested', cursors: {}, passes: {} }, ['Client', 'Lead']);
    assert.equal(r.state.status, 'done');
  });
});

describe('modes and results', () => {
  test('anything but meaning or both is keyword — the palette default', () => {
    assert.equal(parseMode(undefined), 'keyword');
    assert.equal(parseMode('x'), 'keyword');
    assert.equal(parseMode('both'), 'both');
  });
  test('a record both modes found says so and comes first; meaning by score before keyword-only', () => {
    const k = [{ id: 'a', group: 'Lead', createdAt: '2026-01-02' }, { id: 'b', group: 'Lead', createdAt: '2026-01-01' }];
    const m = [{ id: 'c', group: 'Lead', createdAt: null, score: 0.9 }, { id: 'b', group: 'Lead', createdAt: null, score: 0.5 }, { id: 'd', group: 'Lead', createdAt: null, score: 0.7 }];
    const out = mergeResults(k, m);
    assert.deepEqual(out.map((r) => `${r.id}:${r.matched}`), ['b:both', 'c:meaning', 'd:meaning', 'a:keyword']);
  });
  test('conditions apply to a hydrated row; a type with no owner column is left out of an owner filter', () => {
    assert.equal(passesConditions({ status: 'won', owner: undefined, createdAt: null }, [{ field: 'owner', op: 'is', value: 'x' }]), false);
    assert.equal(passesConditions({ status: 'won', owner: 'x', createdAt: '2026-05-05T00:00:00Z' }, [{ field: 'status', op: 'is', value: 'won' }, { field: 'created', op: 'after', value: '2026-05-01' }]), true);
    assert.equal(passesConditions({ status: 'won', owner: 'x', createdAt: null }, [{ field: 'status', op: 'not', value: 'won' }]), false);
  });
});

describe('who may search which types', () => {
  const types = (role: Parameters<typeof can>[0]) => SEMANTIC_SOURCES.filter((s) => can(role, s.capability)).map((s) => s.group);
  test('finance reaches invoices only', () => assert.deepEqual(types('finance'), ['Invoice']));
  test('a contractor reaches delivery records, not leads, money or audit', () => {
    const t = types('contractor');
    assert.ok(t.includes('Project') && !t.includes('Lead') && !t.includes('Invoice') && !t.includes('Audit'));
  });
  test('a member reaches no money and no audit', () => {
    const t = types('member');
    assert.ok(t.includes('Lead') && !t.includes('Invoice') && !t.includes('Audit'));
  });
});
