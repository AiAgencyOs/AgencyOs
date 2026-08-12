import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * The client portal — gap G-057.
 *
 * What a client can see is RLS's answer, and it is proved against a real
 * database by `scripts/verify-client-portal.mjs`. Restating those policies in
 * a mocked test would prove only that the mock agrees with itself.
 *
 * What is worth pinning here is what the *pages* must not do: re-implement the
 * scoping, or offer a client a way to approve their own work.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

/**
 * Comments stripped before scanning for forbidden predicates: these files
 * explain at length why they do not filter by client account, and the first
 * version of this test failed on the explanation.
 */
const code = (source: string) =>
  source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//') && !t.startsWith('*/');
    })
    .join('\n');

const queries = code(read('../src/modules/portal/queries.ts'));
const index = code(read('../app/(client)/portal/page.tsx'));
const detail = code(read('../app/(client)/portal/[projectId]/page.tsx'));
const detailWithComments = read('../app/(client)/portal/[projectId]/page.tsx');

describe('A. the scoping is not copied out of the database', () => {
  test('no page or query filters by client account', () => {
    for (const [name, source] of [
      ['queries', queries],
      ['index', index],
      ['detail', detail],
    ] as const) {
      assert.ok(
        !source.includes('client_account_id'),
        `${name} filters by client account itself — a second copy of a rule that already runs in RLS, and the copy that runs for a direct API call is the database's`,
      );
    }
  });

  test('and no page filters by visibility either', () => {
    assert.ok(!queries.includes("visibility"), 'the internal/client split is the policy’s to make');
  });

  test('every read refuses rather than rendering an empty page', () => {
    const guards = queries.match(/if \((?:\w+\.)?error\)/g) ?? [];
    const refusals = queries.match(/unreadable\(/g) ?? [];
    assert.equal(guards.length, refusals.length, 'a reader answers a failed read with a value');
    assert.ok(guards.length >= 5, 'every query has a guard');
  });
});

describe('B. a client cannot approve their own work here', () => {
  test('no approval action reaches the portal', () => {
    for (const source of [index, detail]) {
      assert.ok(!source.includes('decideApproval'), 'the portal offers an approval path');
      assert.ok(!source.includes('submitDeliverable'), 'the portal offers a submission path');
    }
  });

  test('and the page says who to tell instead', () => {
    // ADM-08d: the client agrees over WhatsApp and a staff member records it
    // with the message as evidence. A button here would either lie about who
    // decided or create a second decision path the audit trail cannot
    // reconcile with the first.
    assert.match(detail, /record your decision against the/);
  });
});

describe('C. what the client is shown', () => {
  test('known limitations travel with the version — directive §17', () => {
    assert.match(detail, /known_issues/);
    assert.match(detail, /Known limitations/);
  });

  test('and how to get into a build, which cannot contain the credentials', () => {
    assert.match(detail, /test_access_method/);
  });

  test('a project RLS does not return is not found, not forbidden', () => {
    // Saying "you may not see this" would confirm that it exists.
    assert.match(detail, /notFound\(\)/);
    assert.match(detailWithComments, /does not exist, and saying/);
  });
});
