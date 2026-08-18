import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * What a page does when the data behind it cannot be read.
 *
 * Gap G-054, and the last member of the family D3, D5, D6 and D7 belong to.
 * Every reader in a `queries.ts` logged its error and returned `[]` or `null`,
 * so a database that did not answer rendered as a page with nothing on it.
 * "No invoices." "Lead not found." Both are statements about the business, and
 * both were false — the calmest possible way to be wrong.
 *
 * Reads that render are the one place throwing is the right answer rather than
 * a lazy one. There is no caller to hand a `Result` to: the caller is a Server
 * Component, and React already has the mechanism in `error.tsx`. A `Result`
 * would mean every component branching on a failure it can do nothing about.
 *
 * Two halves here. The behavioural half executes the real readers against a
 * stubbed database and asserts they refuse. The structural half walks every
 * `queries.ts` in the repo and asserts none of them has grown a new swallow —
 * a per-function test would pass while the twelfth reader quietly returned an
 * empty list again.
 */

let outcome: { data: unknown; error: { message: string } | null } = { data: [], error: null };

function builder() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => outcome,
    then: (resolve: (v: typeof outcome) => unknown) => resolve(outcome),
  };
  return chain;
}

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({ role: 'owner', userId: 'u', organizationId: 'o' }),
    getAuthContext: async () => ({ role: 'owner', userId: 'u', organizationId: 'o' }),
  },
});
mock.module('@/lib/db/server', {
  exports: {
    // `rpc` returns the same stubbed outcome, so a read routed through a SQL
    // function (crm.reactivation_priority) fails exactly like a table read.
    createClient: async () => ({ schema: () => ({ from: () => builder(), rpc: async () => outcome }) }),
  },
});
// aiStatus pairs the registry read with a provider boolean; the boolean is not
// a read and must not mask a failed one.
mock.module('@/lib/ai/router', { exports: { hasConfiguredProvider: () => false } });

const finance = await import('../src/modules/finance/queries.ts');
const crm = await import('../src/modules/crm/queries.ts');
const projects = await import('../src/modules/projects/queries.ts');
const sales = await import('../src/modules/sales/queries.ts');
// Admin reads that render on the Settings and Agents pages — same G-054 rule,
// even though they live in src/lib/admin rather than a module queries.ts.
const reactivation = await import('../src/lib/admin/reactivation-summary.ts');
const agentStatus = await import('../src/lib/admin/agent-status.ts');

/** One reader per module family, exercised for real. */
const READERS: [string, () => Promise<unknown>][] = [
  ['finance.listInvoices', () => finance.listInvoices()],
  ['finance.getInvoice', () => finance.getInvoice('i')],
  ['finance.listInvoicePayments', () => finance.listInvoicePayments('i')],
  ['crm.listLeads', () => crm.listLeads()],
  ['crm.getLeadHeader', () => crm.getLeadHeader('l')],
  ['crm.listLeadActivities', () => crm.listLeadActivities('l')],
  ['projects.listProjects', () => projects.listProjects()],
  ['projects.getProject', () => projects.getProject('p')],
  ['sales.listOpportunities', () => sales.listOpportunities()],
  ['admin.reactivationSummary', () => reactivation.reactivationSummary()],
  ['admin.aiStatus', () => agentStatus.aiStatus()],
];

beforeEach(() => {
  outcome = { data: [], error: null };
});

// ═══════════════════════════════════════════════════════════════════════════
// A. The database did not answer
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a read that failed', () => {
  for (const [name, call] of READERS) {
    test(`${name} refuses rather than rendering an empty page`, async () => {
      outcome = { data: null, error: { message: 'could not connect to server' } };

      await assert.rejects(
        call,
        (thrown: Error) => {
          // Named, so the log and the boundary agree on which read failed.
          assert.match(thrown.message, /could not be read/);
          // And carrying none of the driver's words to the screen.
          assert.doesNotMatch(thrown.message, /could not connect|relation|server/);
          return true;
        },
        `${name} answered instead of failing — an empty page for an unanswered read`,
      );
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The database answered, and the answer was empty
// ═══════════════════════════════════════════════════════════════════════════

describe('B. a read that genuinely found nothing', () => {
  test('an empty list is still an empty list', async () => {
    outcome = { data: [], error: null };

    assert.deepEqual(await finance.listInvoices(), []);
    assert.deepEqual(await crm.listLeads(), []);
    assert.deepEqual(await projects.listProjects(), []);
  });

  test('a missing single row is still null', async () => {
    outcome = { data: null, error: null };

    assert.equal(await finance.getInvoice('i'), null);
    assert.equal(await crm.getLeadHeader('l'), null);
    assert.equal(await projects.getProject('p'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. No reader has grown the habit back
// ═══════════════════════════════════════════════════════════════════════════

const MODULES = fileURLToPath(new URL('../src/modules', import.meta.url));

describe('C. every reader in the repository', () => {
  const files = readdirSync(MODULES)
    .map((m) => `${MODULES}/${m}/queries.ts`)
    .filter((f) => {
      try {
        readFileSync(f);
        return true;
      } catch {
        return false;
      }
    });

  test('there are query files to scan, so a pass means something', () => {
    assert.ok(files.length >= 4, `expected several queries.ts, found ${files.length}`);
  });

  for (const file of files) {
    const name = file.slice(MODULES.length + 1);

    test(`${name} turns no error into an empty answer`, () => {
      const source = readFileSync(file, 'utf8');
      const body = source
        .split('\n')
        .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
        .join('\n');

      // The exact shape that was removed: a caught error answered with a value.
      assert.doesNotMatch(
        body,
        /if \(error\)[\s\S]{0,200}?return (?:\[\]|null|0);/,
        'a reader answers a failed read with a value again',
      );
    });

    test(`${name} reports every read failure`, () => {
      const source = readFileSync(file, 'utf8');
      const guards = source.match(/if \(error\)/g) ?? [];
      const refusals = source.match(/unreadable\(/g) ?? [];
      assert.equal(
        guards.length,
        refusals.length,
        `${guards.length} error guards but ${refusals.length} refusals — one of them does something else`,
      );
    });
  }
});
