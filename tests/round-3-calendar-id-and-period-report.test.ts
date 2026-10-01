import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * Round 3, owner decisions Q-D1 and Q-D2 of 2026-10-01.
 *
 * Q-D1  The Google Calendar id is an organization setting editable in the
 *       panel, read BEFORE the environment value.
 * Q-D2  "Generate period report" stores a dated snapshot that "Export history"
 *       lists, and a period lock may refer to it.
 *
 * The real service code runs with only the session, the database client and
 * the settings read stubbed; scripts/verify-r3-stream.mjs proves
 * the database doors against real Postgres.
 */

const ORG = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const REPORT = '33333333-3333-4333-8333-333333333333';

let role: 'owner' | 'finance' | 'member' | 'ops_admin' = 'owner';
let settings: Record<string, unknown> = {};
let settingsFail = false;
let env: Record<string, string | undefined> = {};
let rpcOutcome: Record<string, unknown> = { outcome: 'generated', id: REPORT, invoice_count: 3 };
const rpcs: { fn: string; args: Record<string, unknown> }[] = [];

mock.module('@/lib/auth/session', { exports: { requireInternal: async () => ({ role, userId: USER, organizationId: ORG }) } });
mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema: () => ({
        async rpc(fn: string, args: Record<string, unknown>) {
          rpcs.push({ fn, args });
          return { data: [rpcOutcome], error: null };
        },
      }),
    }),
  },
});
mock.module('@/lib/env', { exports: { serverEnv: () => env, clientEnv: {} } });
mock.module('@/lib/secrets/resolve', { exports: { resolveSecret: async () => '-----KEY-----' } });
mock.module('@/lib/admin/settings', {
  exports: {
    readOperationalSettings: async () => {
      if (settingsFail) throw new Error('settings unreadable');
      return settings;
    },
  },
});

const { googleCalendarConfig, resolveCalendarId } = await import('../src/lib/scheduling/google.ts');
const { generatePeriodReport } = await import('../src/modules/finance/period-report-service.ts');
const { describeSnapshot, reportsOfPeriod, snapshotCurrencies, generatePeriodReportSchema } = await import('../src/modules/finance/period-report-schema.ts');
const { lockTaxPeriod } = await import('../src/modules/finance/tax-lock-service.ts');

beforeEach(() => {
  role = 'owner';
  settings = {};
  settingsFail = false;
  env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@project.iam.example', GOOGLE_CALENDAR_ID: 'env-calendar@agency.example' };
  rpcOutcome = { outcome: 'generated', id: REPORT, invoice_count: 3 };
  rpcs.length = 0;
});

describe('Q-D1: the calendar id is read from the panel before the environment', () => {
  test('the order, as a pure function: setting, then environment, then nothing', () => {
    assert.deepEqual(resolveCalendarId('panel@agency.example', 'env@agency.example'), { id: 'panel@agency.example', source: 'setting' });
    assert.deepEqual(resolveCalendarId(undefined, 'env@agency.example'), { id: 'env@agency.example', source: 'environment' });
    assert.deepEqual(resolveCalendarId('   ', 'env@agency.example'), { id: 'env@agency.example', source: 'environment' }, 'a blank setting is no setting');
    assert.deepEqual(resolveCalendarId(42, undefined), { id: undefined, source: 'none' }, 'a non-text value is not an id');
    assert.equal(resolveCalendarId('  padded@agency.example  ', undefined).id, 'padded@agency.example');
  });

  test('the booking configuration uses the panel value even when the environment has another', async () => {
    settings = { google_calendar_id: 'panel@agency.example' };
    const config = await googleCalendarConfig();
    assert.equal(config?.calendarId, 'panel@agency.example');
  });

  test('with nothing in the panel the environment value still serves, as before', async () => {
    const config = await googleCalendarConfig();
    assert.equal(config?.calendarId, 'env-calendar@agency.example');
  });

  test('clearing the panel value falls back to the environment; with neither the adapter does not register', async () => {
    settings = { google_calendar_id: '' };
    assert.equal((await googleCalendarConfig())?.calendarId, 'env-calendar@agency.example');
    env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@project.iam.example' };
    assert.equal(await googleCalendarConfig(), null);
  });

  test('a panel id alone is enough when the environment has none (the owner moved it into the panel)', async () => {
    env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@project.iam.example' };
    settings = { google_calendar_id: 'only-panel@agency.example' };
    assert.equal((await googleCalendarConfig())?.calendarId, 'only-panel@agency.example');
  });

  test('a settings read that fails is logged and the environment value serves; it never invents an id', async () => {
    settingsFail = true;
    assert.equal((await googleCalendarConfig())?.calendarId, 'env-calendar@agency.example');
    env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@project.iam.example' };
    assert.equal(await googleCalendarConfig(), null);
  });
});

describe('Q-D2: generate period report', () => {
  test('stores a snapshot of exactly the period asked, through the door, and says how many invoices it held', async () => {
    const r = await generatePeriodReport({ periodStart: '2026-09-01', periodEnd: '2026-10-01', label: 'September 2026' });
    assert.equal(r.ok && r.data.reportId, REPORT);
    assert.equal(r.ok && r.data.invoiceCount, 3);
    assert.equal(rpcs[0]!.fn, 'generate_period_report');
    assert.deepEqual(rpcs[0]!.args, { p_period_start: '2026-09-01', p_period_end: '2026-10-01', p_label: 'September 2026' });
    assert.equal('p_snapshot' in rpcs[0]!.args, false, 'the caller supplies no figures; the door computes them');
  });

  test('the owner, ops admin and finance may generate; a member may not, and the door is not even called', async () => {
    for (const who of ['owner', 'ops_admin', 'finance'] as const) {
      role = who;
      assert.equal((await generatePeriodReport({ periodStart: '2026-09-01', periodEnd: '2026-10-01' })).ok, true, who);
    }
    rpcs.length = 0;
    role = 'member';
    const r = await generatePeriodReport({ periodStart: '2026-09-01', periodEnd: '2026-10-01' });
    assert.equal(r.ok, false);
    assert.equal(rpcs.length, 0);
  });

  test('a period that ends before it starts is refused before the door', async () => {
    const r = await generatePeriodReport({ periodStart: '2026-10-01', periodEnd: '2026-09-01' });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error.message : '', /end after it starts/);
    assert.equal(rpcs.length, 0);
    assert.equal(generatePeriodReportSchema.safeParse({ periodStart: 'yesterday', periodEnd: '2026-10-01' }).success, false);
  });

  test('the door\'s refusals come back in words and an unknown answer is never a success', async () => {
    rpcOutcome = { outcome: 'forbidden' };
    assert.match(String((await generatePeriodReport({ periodStart: '2026-09-01', periodEnd: '2026-10-01' }) as { error: { message: string } }).error.message), /database refused/);
    rpcOutcome = { outcome: 'surprise' };
    assert.equal((await generatePeriodReport({ periodStart: '2026-09-01', periodEnd: '2026-10-01' })).ok, false);
  });
});

describe('Q-D2: the history line and the lock that refers to a report', () => {
  const fmt = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;
  const snapshot = [{ currency: 'INR', invoices: { count: 2, subtotal_minor: 100000, tax_minor: 18000, total_minor: 118000, paid_minor: 0 }, by_mode: {}, expenses: { count: 1, amount_minor: 4000 } }];

  test('the history line names the invoices, the taxable value, the tax and the expenses', () => {
    assert.equal(describeSnapshot(snapshot, 2, fmt), '2 invoices · taxable INR 1000.00, tax INR 180.00, expenses INR 40.00');
    assert.equal(describeSnapshot([], 0, fmt), '0 invoices · nothing issued or spent in the period');
    assert.equal(describeSnapshot(snapshot, 1, fmt).startsWith('1 invoice ·'), true);
  });

  test('R3-2: a snapshot that holds payments and profit-and-loss shows them in the history line', () => {
    const rich = [{ ...snapshot[0], payments: { count: 2, received_minor: 90000, refunded_minor: 10000, net_received_minor: 80000 }, profit_and_loss: { revenue_minor: 80000, expenses_minor: 4000, net_minor: 76000 } }];
    assert.equal(
      describeSnapshot(rich, 2, fmt),
      '2 invoices · taxable INR 1000.00, tax INR 180.00, expenses INR 40.00, payments received INR 800.00, profit and loss: revenue INR 800.00, expenses INR 40.00, net INR 760.00',
    );
  });

  test('a snapshot the database might hold in an odd shape reads as nothing rather than throwing', () => {
    assert.deepEqual(snapshotCurrencies(null), []);
    assert.deepEqual(snapshotCurrencies({ a: 1 }), []);
    assert.deepEqual(snapshotCurrencies([{ nope: true }, snapshot[0]]), [snapshot[0]]);
  });

  test('a lock may refer only to reports of exactly its own period, newest first', () => {
    const reports = [
      { id: 'a', periodStart: '2026-09-01', periodEnd: '2026-10-01', generatedAt: '2026-10-02T10:00:00Z' },
      { id: 'b', periodStart: '2026-08-01', periodEnd: '2026-09-01', generatedAt: '2026-10-03T10:00:00Z' },
      { id: 'c', periodStart: '2026-09-01', periodEnd: '2026-10-01', generatedAt: '2026-10-04T10:00:00Z' },
    ];
    assert.deepEqual(reportsOfPeriod(reports, '2026-09-01', '2026-10-01').map((r) => r.id), ['c', 'a']);
    assert.deepEqual(reportsOfPeriod(reports, '2026-01-01', '2026-12-31'), []);
  });

  test('locking names the report to the door; the door\'s mismatch answer is said in words', async () => {
    rpcOutcome = { outcome: 'locked', lock_id: 'lock-1' };
    const r = await lockTaxPeriod({ periodStart: '2026-09-01', periodEnd: '2026-10-01', note: 'GSTR-3B filed', reportId: REPORT });
    assert.equal(r.ok && r.data.lockId, 'lock-1');
    assert.equal(rpcs[0]!.fn, 'lock_tax_period');
    assert.equal(rpcs[0]!.args.p_report_id, REPORT);

    rpcOutcome = { outcome: 'report_mismatch' };
    const bad = await lockTaxPeriod({ periodStart: '2026-09-01', periodEnd: '2026-10-01', reportId: REPORT });
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.error.message : '', /not a snapshot of exactly this period/);
  });

  test('locking without a report is unchanged: no report argument is sent', async () => {
    rpcOutcome = { outcome: 'locked', lock_id: 'lock-2' };
    await lockTaxPeriod({ periodStart: '2026-09-01', periodEnd: '2026-10-01' });
    assert.equal('p_report_id' in rpcs[0]!.args, false);
  });
});
