import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import {
  DELIVERABLE_KINDS,
  DELIVERABLE_STATUSES,
  DELIVERABLE_TRANSITIONS,
  isClientVisible,
} from '../src/modules/projects/schema.ts';

/**
 * Deliverables — Phase 12, gaps G-021, G-022, G-023.
 *
 * The missing middle. Lead capture through requirements was built and billing
 * through payment was built; everything between requirement approval and
 * invoice generation — design, prototype, client review, revision — had no
 * representation in the database at all.
 *
 * The guarantees that matter are held in Postgres and proved against a real
 * database by `scripts/verify-deliverables.mjs`: version allocation under the
 * project's lock, immutability, the approval request a submission raises, and
 * the supersession an approval causes. What is here is the vocabulary, pinned
 * against the constraints it mirrors, and the service's outcome mapping.
 */

const migration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260813120001_deliverables.sql', import.meta.url)),
  'utf8',
);

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

const seen = { calls: [] as [string, Record<string, unknown>][] };

let addResult: { data: unknown; error: { message: string } | null } = {
  data: [{ outcome: 'created', deliverable_id: '11111111-1111-4111-8111-111111111111', version: 3 }],
  error: null,
};
let submitResult: { data: unknown; error: { message: string } | null } = {
  data: [{ outcome: 'submitted', request_id: '22222222-2222-4222-8222-222222222222', status: 'in_review' }],
  error: null,
};

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role: 'delivery_lead',
      userId: '33333333-3333-4333-8333-333333333333',
      organizationId: '44444444-4444-4444-8444-444444444444',
    }),
  },
});
mock.module('@/lib/audit', { exports: { recordAudit: async () => {} } });
mock.module('@/lib/events', { exports: { emitEvent: async () => {} } });
mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema() {
        return {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            seen.calls.push([fn, args]);
            return fn === 'add_deliverable' ? addResult : submitResult;
          },
        };
      },
    }),
  },
});

const { addDeliverable, submitDeliverable } = await import('../src/modules/projects/service.ts');

const PROJECT = '55555555-5555-4555-8555-555555555555';
const DELIVERABLE = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  seen.calls = [];
  addResult = {
    data: [{ outcome: 'created', deliverable_id: DELIVERABLE, version: 3 }],
    error: null,
  };
  submitResult = {
    data: [{ outcome: 'submitted', request_id: '22222222-2222-4222-8222-222222222222', status: 'in_review' }],
    error: null,
  };
});

describe('A. the vocabulary matches the constraints it mirrors', () => {
  test('every kind and status in schema.ts is one the table admits', () => {
    for (const value of [...DELIVERABLE_KINDS, ...DELIVERABLE_STATUSES]) {
      assert.ok(migration.includes(`'${value}'`), `${value} is in schema.ts but not in the CHECK`);
    }
  });

  test('approved and superseded are terminal — an approval names a version', () => {
    assert.deepEqual(DELIVERABLE_TRANSITIONS.approved, []);
    assert.deepEqual(DELIVERABLE_TRANSITIONS.superseded, []);
  });

  test('changes_requested goes back for another round, which is the ordinary loop', () => {
    assert.ok(DELIVERABLE_TRANSITIONS.changes_requested.includes('in_review'));
  });

  test('a draft is the only thing a client never sees', () => {
    assert.equal(isClientVisible('draft'), false);
    for (const status of DELIVERABLE_STATUSES.filter((s) => s !== 'draft')) {
      assert.equal(isClientVisible(status), true, `${status} was shown to the client`);
    }
  });
});

describe('B. the rules the database holds', () => {
  test('the version is allocated under the project’s lock', () => {
    assert.match(migration, /from projects\.projects p[\s\S]*?for update/);
    assert.match(migration, /coalesce\(max\(d\.version\), 0\) \+ 1/);
  });

  test('a version is immutable apart from its status', () => {
    assert.match(migration, /deliverables_guard/);
    assert.match(migration, /is immutable; submit version/);
  });

  test('submitting raises an approval rather than inventing a second review', () => {
    assert.match(migration, /approvals\.request_approval\(/);
    assert.match(migration, /'deliverable',/);
  });

  test('the review is client-audience, so ADM-08d’s evidence rule applies', () => {
    const fn = migration.slice(migration.indexOf('function projects.submit_deliverable'));
    assert.match(fn.slice(0, 2500), /'client'/);
  });

  test('an approval supersedes earlier versions of the same kind, and deletes none', () => {
    assert.match(migration, /set status = 'superseded'/);
    assert.ok(!/delete from projects\.deliverables/i.test(migration), 'history is never deleted');
  });

  test('the decision is pulled, not pushed by a trigger on approvals', () => {
    assert.ok(
      !/create trigger \w+[\s\S]{0,120}on approvals\.approval_requests/.test(migration),
      'a trigger there would make settling an invoice reach into the delivery module',
    );
  });

  test('a client sees what was shown to them, never a draft', () => {
    assert.match(migration, /core\.is_client\(\)[\s\S]{0,200}status <> 'draft'/);
  });
});

describe('C. adding a version', () => {
  test('the caller’s project and kind reach the database unchanged', async () => {
    const result = await addDeliverable({ projectId: PROJECT, kind: 'design', title: 'Home screen' });

    assert.ok(result.ok);
    assert.equal(result.data.version, 3);
    const [, args] = seen.calls[0]!;
    assert.equal(args.p_project_id, PROJECT);
    assert.equal(args.p_kind, 'design');
  });

  test('optional fields are omitted rather than sent empty', async () => {
    await addDeliverable({ projectId: PROJECT, kind: 'build', title: 'APK 1.2' });

    const [, args] = seen.calls[0]!;
    assert.ok(!('p_artifact_url' in args));
    assert.ok(!('p_changelog' in args));
  });

  test('an unknown kind never reaches the database', async () => {
    const result = await addDeliverable({
      projectId: PROJECT,
      kind: 'mockup' as 'design',
      title: 'Something',
    });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'VALIDATION');
    assert.equal(seen.calls.length, 0);
  });

  test('a project that does not exist is NOT_FOUND', async () => {
    addResult = { data: [{ outcome: 'not_found', deliverable_id: null, version: null }], error: null };

    const result = await addDeliverable({ projectId: PROJECT, kind: 'design', title: 'Home screen' });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'NOT_FOUND');
  });

  test('a database that does not answer is INTERNAL, not a version that exists', async () => {
    addResult = { data: null, error: { message: 'connection reset by peer' } };

    const result = await addDeliverable({ projectId: PROJECT, kind: 'design', title: 'Home screen' });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /connection reset/);
  });
});

describe('D. sending it to the client', () => {
  test('a submission returns the approval request reviewing it', async () => {
    const result = await submitDeliverable({ deliverableId: DELIVERABLE });

    assert.ok(result.ok);
    assert.equal(result.data.requestId, '22222222-2222-4222-8222-222222222222');
    assert.equal(result.data.alreadyInReview, false);
  });

  test('submitting twice is a success that says it was already in review', async () => {
    submitResult = {
      data: [{ outcome: 'already_in_review', request_id: '22222222-2222-4222-8222-222222222222', status: 'in_review' }],
      error: null,
    };

    const result = await submitDeliverable({ deliverableId: DELIVERABLE });

    assert.ok(result.ok, 'the client is already looking at it, which is what the caller wanted');
    assert.equal(result.data.alreadyInReview, true);
  });

  test('no approval policy is a refusal that names the fix', async () => {
    submitResult = { data: [{ outcome: 'no_policy', request_id: null, status: 'draft' }], error: null };

    const result = await submitDeliverable({ deliverableId: DELIVERABLE });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(
      result.error.message,
      /owner sets one/,
      'a review nobody is named to answer is a promise the system cannot keep',
    );
  });

  test('an already-approved version is a conflict, not a second review', async () => {
    submitResult = { data: [{ outcome: 'settled', request_id: null, status: 'approved' }], error: null };

    const result = await submitDeliverable({ deliverableId: DELIVERABLE });

    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /already approved/);
  });
});
