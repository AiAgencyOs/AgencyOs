import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Customer 360 reads, against a stand-in database that records which tables and functions are touched. What is held: finance is read only for a viewer who may
 * read it (and its absence is `null`, not an empty list), outstanding money is on the verified basis, every read that fails is refused rather than rendered empty,
 * and an eligibility answer that did not come back is shown as NOT allowed. The derived reads themselves are proved in Postgres by scripts/verify-phase-eight-d.sql.
 */

type Outcome = { data: unknown; error: { message: string } | null };
let tables: Record<string, unknown[]> = {};
let failing = new Set<string>();
let rpcs: Record<string, unknown> = {};
let touched: string[] = [];

const CLIENT = 'c0000000-0000-4000-8000-000000000001';
const P1 = 'a0000000-0000-4000-8000-000000000001';
const P2 = 'a0000000-0000-4000-8000-000000000002';

function chain(key: string): unknown {
  const result = (): Outcome => (failing.has(key) ? { data: null, error: { message: 'relation does not exist' } } : { data: tables[key] ?? [], error: null });
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'neq']) self[m] = () => self;
  self.maybeSingle = async () => {
    const r = result();
    return r.error ? r : { data: ((r.data as unknown[])[0] ?? null) as unknown, error: null };
  };
  self.then = (resolve: (v: Outcome) => unknown) => resolve(result());
  return self;
}

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema: (schema: string) => ({
        from: (table: string) => {
          touched.push(`${schema}.${table}`);
          return chain(`${schema}.${table}`);
        },
        rpc: async (fn: string, args?: Record<string, unknown>) => {
          touched.push(`rpc:${fn}`);
          if (failing.has(`rpc:${fn}`)) return { data: null, error: { message: 'function does not exist' } };
          const answer = rpcs[fn];
          return { data: typeof answer === 'function' ? (answer as (a?: Record<string, unknown>) => unknown)(args) : answer ?? [], error: null };
        },
      }),
    }),
  },
});
mock.module('@/modules/projects/project-lifecycle-queries', {
  exports: { readProjectLifecycles: async () => new Map([[P1, { phase: 'completed' }], [P2, { phase: 'development' }]]) },
});

const { readCustomer360, readValueReportFacts, ELIGIBILITY_QUESTIONS } = await import('../src/modules/projects/customer-360-queries.ts');

const baseTables = (): Record<string, unknown[]> => ({
  'core.client_accounts': [{ id: CLIENT, name: 'Acme Ltd', status: 'active', currency: 'INR' }],
  'projects.projects': [
    { id: P1, name: 'Portal', project_code: 'ACME-01', status: 'completed', completed_at: '2026-09-01T00:00:00Z' },
    { id: P2, name: 'Mobile app', project_code: 'ACME-02', status: 'active', completed_at: null },
  ],
  'projects.phase_eight': [{ project_id: P1, state: 'active', warranty_ends_on: '2026-12-01', cs_owner: 'u1' }],
  'projects.maintenance_plans': [
    { id: 'm1', project_id: P1, name: 'Care', version: 1, status: 'renewal_approaching', starts_on: '2026-01-01', ends_on: '2026-11-15', billing_model: 'monthly' },
    { id: 'm2', project_id: P1, name: 'Old', version: 1, status: 'cancelled', starts_on: '2025-01-01', ends_on: '2025-12-31', billing_model: 'annual' },
  ],
  'projects.recovery_plans': [{ id: 'r1', project_id: P1, status: 'open', owner_id: null, deadline: null, root_cause: null, outcome: null }],
  'projects.cs_check_ins': [{ id: 'k1', project_id: P1, kind: 'post_handover', status: 'due', due_on: '2026-09-10', engagement: null, channel: null, outcome: null }],
  'sales.phase_eight_opportunities': [{ id: 'o1', project_id: P1, kind: 'change_request', need: 'Add a reporting page', status: 'detected', urgency: 'normal', suppressed_reason: null }],
  'crm.contacts': [{ id: 'ct1', full_name: 'Asha' }, { id: 'ct2', full_name: 'Ravi' }, { id: 'ct3', full_name: 'Meera' }],
  'crm.communication_consent': [{ contact_id: 'ct1', status: 'granted' }, { contact_id: 'ct2', status: 'withdrawn' }],
  'projects.client_communication_caps': [{ id: 'cap1', channel: null, max_contacts: 2, window_days: 30, active: true }],
  'projects.client_quiet_periods': [{ id: 'q1', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-10-05T00:00:00Z', reason: 'audit week', cancelled_at: null }],
  'projects.value_report_drafts': [{
    id: 'v1', period_start: '2026-10-01', period_end: '2026-10-07', template_version: 1, status: 'draft', body: 'Report body for the period.', built_by_agent: 'customer_success', built_at: '2026-10-08T00:00:00Z',
    facts: [{ type: 'ticket_resolved', label: 'TKT-1 x', value: 1, unit: 'ticket', on: '2026-10-02', projectId: P1, sources: [{ table: 'projects.support_tickets', id: 't1' }] }], approved_at: null,
  }],
  'finance.invoices': [
    { id: 'i1', number: 'INV-1', project_id: P1, status: 'issued', currency: 'INR', total_minor: 100000, verified_minor: 40000, due_at: '2026-10-20T00:00:00Z' },
    { id: 'i2', number: 'INV-2', project_id: P1, status: 'draft', currency: 'INR', total_minor: 50000, verified_minor: 0, due_at: null },
    { id: 'i3', number: 'INV-3', project_id: null, status: 'paid', currency: 'INR', total_minor: 20000, verified_minor: 99999, due_at: null },
  ],
});
const baseRpcs = (): Record<string, unknown> => ({
  customer_health_status: [{ status: 'watch', reasons: [{ signal: 'open_tickets', value: '3', level: 'watch', detail: '3 open support tickets' }] }],
  support_queue: [
    { id: 't0', ticket_ref: 'TKT-0', title: 'old closed', status: 'closed', raised_at: '2026-09-01T00:00:00Z', closed_at: '2026-09-02T00:00:00Z', response_state: 'met', resolution_state: 'met', priority: 'p3', classification: 'how_to', coverage_decision: 'included_support' },
    { id: 't1', ticket_ref: 'TKT-1', title: 'cannot log in', status: 'assigned', raised_at: '2026-10-01T00:00:00Z', closed_at: null, response_state: 'met', resolution_state: 'breached', priority: 'p1', classification: 'warranty_bug', coverage_decision: 'covered_warranty', resolution_due_at: '2026-10-02T00:00:00Z' },
  ],
  client_communication_history: [{ id: 'l1', occurred_at: '2026-10-03T10:00:00Z', channel: 'whatsapp', purpose: 'relationship', entry_kind: 'sent_by_person', summary: 'Checked in', eligible_at_record: false, eligibility_reasons: ['no consent'], delivery_state: 'unknown', delivery_source: 'none', replied: false, recorded_by: 'u1', drafted_by_agent: null }],
  can_contact_now: (args?: Record<string, unknown>) => [{ allowed: args?.p_channel === 'call', reasons: args?.p_channel === 'call' ? [] : ['no recorded consent'] }],
});

beforeEach(() => {
  tables = baseTables();
  rpcs = baseRpcs();
  failing = new Set();
  touched = [];
});

describe('Customer 360 shows one client across its projects', () => {
  test('projects carry their phase, the Phase 8 workspace, plans, renewals, tickets (open first), health and the rest', async () => {
    const v = await readCustomer360(CLIENT, { mayReadFinance: true });
    assert.ok(v);
    assert.deepEqual(v.projects.map((p) => [p.name, p.phase, p.phaseLabel, p.phaseEight?.state ?? null]), [['Portal', 'completed', 'Completed', 'active'], ['Mobile app', 'development', 'Development', null]]);
    assert.deepEqual(v.tickets.map((t) => [t.ref, t.open]), [['TKT-1', true], ['TKT-0', false]]);
    assert.equal(v.tickets[0]!.resolutionState, 'breached');
    assert.equal(v.health[0]!.status, 'watch');
    assert.equal(v.health[0]!.projectName, 'Portal');
    assert.deepEqual(v.renewals.map((r) => [r.planName, r.status, r.endsOn]), [['Care', 'renewal_approaching', '2026-11-15']]);
    assert.equal(v.plans.length, 2);
    assert.equal(v.recovery[0]!.status, 'open');
    assert.equal(v.checkIns[0]!.kind, 'post_handover');
    assert.equal(v.opportunities[0]!.need, 'Add a reporting page');
    assert.deepEqual(v.contacts.map((c) => [c.name, c.whatsappConsent]), [['Asha', 'granted'], ['Ravi', 'withdrawn'], ['Meera', 'none']]);
    assert.equal(v.caps[0]!.maxContacts, 2);
    assert.equal(v.quietPeriods[0]!.reason, 'audit week');
    assert.equal(v.ledger[0]!.eligibleAtRecord, false);
    assert.equal(v.valueReports[0]!.factCount, 1);
  });

  test('the ticket queue and health are the database\'s derived reads, called once per live Phase 8 project', async () => {
    await readCustomer360(CLIENT, { mayReadFinance: false });
    assert.equal(touched.filter((t) => t === 'rpc:support_queue').length, 1);
    assert.equal(touched.filter((t) => t === 'rpc:customer_health_status').length, 1);
    assert.equal(touched.filter((t) => t === 'rpc:can_contact_now').length, ELIGIBILITY_QUESTIONS.length);
    assert.ok(!touched.includes('projects.support_tickets'), 'tickets are not read from the table and re-derived here');
  });

  test('an unknown client is null, not an empty page', async () => {
    tables['core.client_accounts'] = [];
    assert.equal(await readCustomer360(CLIENT, { mayReadFinance: true }), null);
  });
});

describe('finance is read only where the viewer may read it', () => {
  test('without the permission the finance schema is never touched and the invoice section is null, not empty', async () => {
    const v = await readCustomer360(CLIENT, { mayReadFinance: false });
    assert.equal(v!.invoices, null);
    assert.equal(v!.outstandingByCurrency, null);
    assert.ok(!touched.some((t) => t.startsWith('finance.')));
  });

  test('with it, outstanding is live invoices less VERIFIED money, clamped, and a draft owes nothing', async () => {
    const v = await readCustomer360(CLIENT, { mayReadFinance: true });
    assert.deepEqual(v!.invoices!.map((i) => [i.number, i.live, i.outstandingMinor]), [['INV-1', true, 60000], ['INV-2', false, 0], ['INV-3', true, 0]]);
    assert.deepEqual(v!.outstandingByCurrency, [{ currency: 'INR', outstandingMinor: 60000 }]);
  });

  test('a client with no invoice is an empty list for a viewer who may read finance (the two cases are different)', async () => {
    tables['finance.invoices'] = [];
    const v = await readCustomer360(CLIENT, { mayReadFinance: true });
    assert.deepEqual(v!.invoices, []);
    assert.deepEqual(v!.outstandingByCurrency, []);
  });
});

describe('eligibility is the database\'s answer, never assumed', () => {
  test('each question is asked and answered; the reasons are carried', async () => {
    const v = await readCustomer360(CLIENT, { mayReadFinance: false });
    assert.equal(v!.eligibility.length, ELIGIBILITY_QUESTIONS.length);
    const wa = v!.eligibility.find((e) => e.channel === 'whatsapp' && e.purpose === 'relationship')!;
    assert.deepEqual([wa.allowed, wa.reasons], [false, ['no recorded consent']]);
    assert.equal(v!.eligibility.find((e) => e.channel === 'call')!.allowed, true);
  });
  test('an answer that did not come back is NOT allowed, and says so', async () => {
    rpcs.can_contact_now = [];
    const v = await readCustomer360(CLIENT, { mayReadFinance: false });
    assert.ok(v!.eligibility.every((e) => !e.allowed && e.reasons[0] === 'no answer was returned'));
  });
});

describe('a read that fails is refused, never rendered as an empty section', () => {
  const READS = [
    'core.client_accounts', 'projects.projects', 'projects.phase_eight', 'projects.maintenance_plans', 'projects.recovery_plans', 'projects.cs_check_ins', 'sales.phase_eight_opportunities', 'crm.contacts',
    'projects.client_communication_caps', 'projects.client_quiet_periods', 'projects.value_report_drafts', 'finance.invoices', 'crm.communication_consent',
    'rpc:customer_health_status', 'rpc:support_queue', 'rpc:client_communication_history', 'rpc:can_contact_now',
  ];
  for (const read of READS) {
    test(`${read}`, async () => {
      failing = new Set([read]);
      await assert.rejects(() => readCustomer360(CLIENT, { mayReadFinance: true }), (e: Error) => {
        assert.match(e.message, /could not be read/);
        assert.doesNotMatch(e.message, /relation|function does not exist/);
        return true;
      });
    });
  }
  test('a stored report whose fact lost its source is refused, not shown', async () => {
    (tables['projects.value_report_drafts']![0] as { facts: unknown[] }).facts = [{ type: 'ticket_resolved', label: 'x', value: 1, unit: 'ticket', on: '2026-10-02', sources: [] }];
    await assert.rejects(() => readCustomer360(CLIENT, { mayReadFinance: false }), /cites no source row/);
  });
});

describe('the facts read for a report', () => {
  test('returns the parsed facts, the digest and the client name', async () => {
    rpcs.value_report_facts = [{ facts: [{ type: 'hours_logged', label: 'Hours', value: 2, unit: 'hours', on: '2026-10-02', sources: [{ table: 'projects.time_logs', id: 'x' }] }], digest: 'f'.repeat(32) }];
    const r = await readValueReportFacts(CLIENT, '2026-10-01', '2026-10-07');
    assert.equal(r!.digest, 'f'.repeat(32));
    assert.equal(r!.clientName, 'Acme Ltd');
    assert.equal(r!.facts[0]!.type, 'hours_logged');
  });
  test('a period or client the database would not answer is null; a failed read is refused', async () => {
    rpcs.value_report_facts = [];
    assert.equal(await readValueReportFacts(CLIENT, '2026-10-07', '2026-10-01'), null);
    failing = new Set(['rpc:value_report_facts']);
    await assert.rejects(() => readValueReportFacts(CLIENT, '2026-10-01', '2026-10-07'), /could not be read/);
  });
});
