import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import type { Role } from '../src/lib/auth/claims.ts';

/**
 * The last three defects from the Phase 14/15 sweep.
 *
 * D9 — convertToProject meant to be idempotent: it read projects by
 * opportunity_id and returned the existing one. But that read and the insert
 * are two statements, and nothing in the database held the rule. Two clicks on
 * a won deal both read nothing and both insert — two projects for one
 * opportunity, and two client accounts, because the account is created on the
 * same path. `projects_opportunity_key` now holds it, and losing to the index
 * is answered with the project that won rather than an error.
 *
 * D11 — appendMessage read the highest seq and dropped the error, so a failed
 * read fell through to seq 0. That collides with the first message already
 * there, and `unique (conversation_id, seq)` reported it to the operator as
 * "somebody else posted at the same moment" — a statement about another
 * person, for a database that did not answer.
 *
 * D12 — startConversation read for an active conversation and dropped the
 * error. Nothing in the database holds one-active-conversation-per-lead, so
 * that read was the only thing between a blip and a second conversation — and
 * a second one hides the first, because every later query takes the most
 * recent active thread.
 *
 * All three are the shapes this audit has been about: a decision from a read
 * that had already moved on, and a failed read answered as a fact.
 */

type Read = { data: unknown; error: { message: string } | null };

let leadRead: Read = { data: null, error: null };
let conversationLookup: Read = { data: null, error: null };
let seqRead: Read = { data: null, error: null };
let convRead: Read = { data: null, error: null };
let insertOutcome: Read = { data: { id: 'new' }, error: null };
let role: Role = 'owner';

const seen = { inserts: [] as string[] };

function client() {
  return {
    schema() {
      return {
        from(table: string) {
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: () => chain,
            is: () => chain,
            order: () => chain,
            limit: () => chain,
            maybeSingle: async () => {
              if (table === 'leads') return leadRead;
              if (table === 'conversations') return convRead.data ? convRead : conversationLookup;
              if (table === 'conversation_messages') return seqRead;
              return { data: null, error: null };
            },
            single: async () => insertOutcome,
          };
          return {
            ...chain,
            insert: () => {
              seen.inserts.push(table);
              return chain;
            },
            update: () => chain,
          };
        },
      };
    },
  };
}

mock.module('@/lib/auth/session', {
  exports: { requireInternal: async () => ({ role, userId: 'u', organizationId: 'o' }) },
});
mock.module('@/lib/audit', { exports: { recordAudit: async () => {} } });
mock.module('@/lib/events', { exports: { emitEvent: async () => {} } });
mock.module('@/lib/db/server', { exports: { createClient: async () => client() } });

const LEAD_ID = '11111111-1111-4111-8111-111111111111';
const CONV_ID = '22222222-2222-4222-8222-222222222222';

const { startConversation, appendMessage } = await import('../src/modules/crm/service.ts');

const FAILED = { data: null, error: { message: 'could not connect to server' } };

beforeEach(() => {
  role = 'owner';
  leadRead = {
    data: { id: LEAD_ID, organization_id: 'o', contact_id: 'c', status: 'qualifying' },
    error: null,
  };
  conversationLookup = { data: null, error: null };
  convRead = { data: null, error: null };
  seqRead = { data: null, error: null };
  insertOutcome = { data: { id: 'new' }, error: null };
  seen.inserts = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// D12. Starting a conversation
// ═══════════════════════════════════════════════════════════════════════════

describe('D12. the check for an existing conversation', () => {
  test('a failed read refuses rather than starting a second thread', async () => {
    conversationLookup = FAILED;

    const result = await startConversation({ leadId: LEAD_ID, channel: 'whatsapp' });

    assert.equal(result.ok, false, 'a second conversation was started on an unreadable database');
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.equal(
      seen.inserts.includes('conversations'),
      false,
      'a conversation was inserted without knowing whether one already existed',
    );
    assert.doesNotMatch(
      result.ok === false ? result.error.message : '',
      /could not connect|server/,
    );
  });

  test('an existing conversation is still returned, not duplicated', async () => {
    conversationLookup = { data: { id: CONV_ID }, error: null };

    const result = await startConversation({ leadId: LEAD_ID, channel: 'whatsapp' });

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.conversationId, CONV_ID);
    assert.deepEqual(seen.inserts, []);
  });

  test('and a genuinely absent one is still created', async () => {
    conversationLookup = { data: null, error: null };

    const result = await startConversation({ leadId: LEAD_ID, channel: 'whatsapp' });

    assert.equal(result.ok, true);
    assert.ok(seen.inserts.includes('conversations'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D11. Appending a message
// ═══════════════════════════════════════════════════════════════════════════

describe('D11. the highest seq in the transcript', () => {
  beforeEach(() => {
    convRead = { data: { id: CONV_ID, organization_id: 'o', status: 'active' }, error: null };
  });

  test('a failed read refuses rather than starting the transcript again', async () => {
    seqRead = FAILED;

    const result = await appendMessage({
      conversationId: CONV_ID,
      body: 'hello',
      authorType: 'client',
    });

    assert.equal(result.ok, false, 'a message was numbered from an unreadable transcript');
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    // Not the CONFLICT the collision used to produce, which blamed another
    // person for a database that did not answer.
    assert.notEqual(result.ok === false && result.error.code, 'CONFLICT');
    assert.equal(seen.inserts.includes('conversation_messages'), false);
  });

  test('an empty transcript is still an empty transcript', async () => {
    seqRead = { data: null, error: null };

    const result = await appendMessage({
      conversationId: CONV_ID,
      body: 'hello',
      authorType: 'client',
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(seen.inserts.includes('conversation_messages'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D9. One project per won deal
// ═══════════════════════════════════════════════════════════════════════════

const migration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260812120002_one_project_per_opportunity.sql', import.meta.url),
  ),
  'utf8',
);

const executableSql = migration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('D9. one project per opportunity', () => {
  test('the rule is held by an index, not only by the read before the insert', () => {
    assert.match(executableSql, /create unique index[\s\S]{0,120}on projects\.projects \(opportunity_id\)/);
  });

  test('it is partial, so a project raised without a deal is unaffected', () => {
    assert.match(executableSql, /where opportunity_id is not null/);
  });

  test('and a soft-deleted project frees the deal to be converted again', () => {
    // The same reasoning that makes invoices_milestone_live_key exclude void
    // invoices: a withdrawn thing is not a thing.
    assert.match(executableSql, /deleted_at is null/);
  });

  test('the service recognises the index by name rather than guessing', () => {
    const service = readFileSync(
      fileURLToPath(new URL('../src/modules/projects/service.ts', import.meta.url)),
      'utf8',
    );
    assert.match(service, /projects_opportunity_key/);
    assert.match(service, /'23505'/);
  });

  test('it changes no table', () => {
    assert.doesNotMatch(executableSql, /create table|alter table|drop table|drop constraint/);
  });
});
