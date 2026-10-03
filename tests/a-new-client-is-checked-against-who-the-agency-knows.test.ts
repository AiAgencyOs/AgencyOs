import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { PostgrestClient } from '@supabase/postgrest-js';

import { clientIdentityMatches, describeIdentityMatches } from '../src/modules/sales/client-identity.ts';

/**
 * SCR-014 — "Client identity must deduplicate against lead/contact records".
 * The rule is pure (first suite); the door that applies it is run for real over
 * the real PostgREST client and a fake wire (second suite): a match stops the
 * create and creates nothing, a confirmed re-submit creates the client.
 */

describe('who a new client might already be', () => {
  const candidates = {
    clients: [
      { id: 'c1', name: 'Northwind Retail', billingEmail: 'accounts@northwind.example' },
      { id: 'c2', name: 'Northwind Retail Group', billingEmail: null },
    ],
    contacts: [
      { id: 'k1', fullName: 'Priya Raman', email: 'priya@northwind.example', company: 'Northwind Retail', clientAccountId: null, leadId: 'l1', leadTitle: 'Loyalty app build' },
      { id: 'k2', fullName: 'Asha Rao', email: 'asha@other.example', company: 'Other Co', clientAccountId: null, leadId: null, leadTitle: null },
    ],
  };

  test('the same name, whatever the case or spacing, names the client and the contact\'s company', () => {
    const m = clientIdentityMatches({ name: '  northwind   RETAIL ', billingEmail: '' }, candidates);
    assert.deepEqual(m.map((x) => `${x.kind}:${x.id}:${x.reason}`), ['client:c1:same name', 'contact:k1:same company as this contact']);
  });

  test('a longer name that merely contains it is a different business', () => {
    const m = clientIdentityMatches({ name: 'Northwind', billingEmail: '' }, candidates);
    assert.deepEqual(m, []);
  });

  test('the same billing email is enough, and the contact points at its lead', () => {
    const m = clientIdentityMatches({ name: 'Brand New Name', billingEmail: 'Priya@Northwind.example' }, candidates);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.kind, 'contact');
    assert.equal(m[0]!.href, '/leads/l1');
    assert.match(m[0]!.label, /Loyalty app build/);
  });

  test('a contact already filed under a client sends you to that client', () => {
    const m = clientIdentityMatches({ name: 'Asha Rao', billingEmail: '' }, { clients: [], contacts: [{ ...candidates.contacts[1]!, clientAccountId: 'c9' }] });
    assert.equal(m[0]!.href, '/clients/c9');
  });

  test('nothing matches, nothing is said', () => {
    assert.deepEqual(clientIdentityMatches({ name: 'Zeta Logistics', billingEmail: 'ops@zeta.example' }, candidates), []);
  });

  test('the sentence names the first three and counts the rest', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ kind: 'client' as const, id: `c${i}`, label: `Client ${i}`, reason: 'same name', href: `/clients/c${i}` }));
    const text = describeIdentityMatches(many);
    assert.match(text, /Client 0 \(same name\); Client 1 \(same name\); Client 2 \(same name\), and 2 more/);
  });
});

type Row = Record<string, unknown>;
const clients: Row[] = [{ id: 'c1', name: 'Northwind Retail', billing_email: 'accounts@northwind.example' }];
const contacts: Row[] = [{ id: 'k1', full_name: 'Priya Raman', email: 'priya@northwind.example', company: 'Brightleaf', client_account_id: null }];
const leads: Row[] = [{ id: 'l1', title: 'D2C storefront', contact_id: 'k1' }];
const inserted: Row[] = [];

const wire = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'POST') {
    const body = JSON.parse(String(init?.body)) as Row;
    inserted.push(body);
    return json({ id: 'new-client' }, 201);
  }
  const path = url.pathname;
  const or = url.searchParams.get('or') ?? '';
  const hit = (rows: Row[], cols: string[]) => rows.filter((r) => cols.some((c) => or.includes(`${c}.ilike`) && [...or.matchAll(/ilike\."\*(.*?)\*"/g)].some((m) => String(r[c] ?? '').toLowerCase().includes((m[1] ?? '').toLowerCase()))));
  if (path.endsWith('/client_accounts')) return json(hit(clients, ['name', 'billing_email']));
  if (path.endsWith('/contacts')) return json(hit(contacts, ['full_name', 'company', 'email']));
  if (path.endsWith('/leads')) return json(leads);
  return json([]);
}) as typeof fetch;

mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ role: 'owner', userId: 'u1', organizationId: 'o1', roles: ['owner'] }) } });
mock.module('@/lib/db/server', { exports: { createClient: async () => new PostgrestClient('http://wire/rest/v1', { fetch: wire }) } });

const { createClientAccount } = await import('../src/modules/sales/service.ts');

describe('the door that creates a client', () => {
  test('a name an existing client already has stops the create and creates nothing', async () => {
    inserted.length = 0;
    const r = await createClientAccount({ name: 'Northwind Retail' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.code, 'CONFLICT');
    assert.match(r.error.message, /Northwind Retail \(same name\)/);
    assert.equal(r.error.details?.matches?.length, 1);
    assert.equal(inserted.length, 0);
  });

  test('an email a lead\'s contact already uses is named with its lead', async () => {
    inserted.length = 0;
    const r = await createClientAccount({ name: 'Brand New Co', billingEmail: 'priya@northwind.example' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error.message, /Priya Raman — lead “D2C storefront”/);
    assert.equal(inserted.length, 0);
  });

  test('confirming creates it anyway, once', async () => {
    inserted.length = 0;
    const r = await createClientAccount({ name: 'Northwind Retail', confirmDuplicate: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]!.name, 'Northwind Retail');
  });

  test('a name nobody holds is created without being asked', async () => {
    inserted.length = 0;
    const r = await createClientAccount({ name: 'Zeta Logistics' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(inserted.length, 1);
  });
});
