import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import { linkWhatsAppGroupSchema } from '../src/modules/crm/schema.ts';
import type { Role } from '../src/lib/auth/claims.ts';

/**
 * G-015 and G-109 — the two WhatsApp groups.
 *
 * The Admin described both on 2026-08-13, and they answer different questions:
 *
 *   The **project group** is the client-facing thread for one project. ADM-13
 *   made it a condition of a project officially starting, so it stopped being
 *   a convenience.
 *
 *   The **internal group** is the owner, the staff and the agent — where the
 *   agent raises what it needs confirmed and gets approve, reject or feedback.
 *   Given unprompted while answering a question about payment verification.
 *
 * What is worth testing here, and what is not:
 *
 *   A. the shapes are unrepresentable rather than merely discouraged — a
 *      project group without a project, a direct thread that lost its lead
 *   B. one group of each kind, held by an index rather than a pre-check
 *   C. the caller turns four outcomes into four different answers
 *   D. who may link which kind
 *
 * The uniqueness itself is proved against real Postgres in
 * verify-whatsapp-groups.mjs — an index is not a thing a stub can demonstrate.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const migration = read('../supabase/migrations/20260813120014_whatsapp_groups.sql');

/** The SQL with comment lines removed, so a comment cannot satisfy an assertion. */
const executable = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

// ═══════════════════════════════════════════════════════════════════════════
// A. A group is a conversation, and each kind carries exactly its own links
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the shape of a conversation', () => {
  test('three kinds, and nothing else', () => {
    assert.match(
      executable,
      /check \(kind in \('direct', 'project_group', 'internal_group'\)\)/,
    );
  });

  test('a direct thread still requires its lead', () => {
    // `lead_id` stopped being NOT NULL so a group could exist without one. That
    // alone would let a 1:1 thread lose the person it is with, which is the
    // whole reason the column was there.
    assert.match(executable, /kind = 'direct'\s+and lead_id is not null and project_id is null/);
  });

  test('a project group requires a project and cannot carry a lead', () => {
    assert.match(executable, /kind = 'project_group'\s+and lead_id is null and project_id is not null/);
  });

  test('an internal group carries neither', () => {
    assert.match(executable, /kind = 'internal_group' and lead_id is null and project_id is null/);
  });

  test('the shape is a constraint, not a convention', () => {
    assert.match(executable, /add constraint conversations_kind_shape check/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. One of each, and one owner per group id
// ═══════════════════════════════════════════════════════════════════════════

describe('B. uniqueness lives in the database', () => {
  test('one live client group per project', () => {
    assert.match(
      executable,
      /create unique index if not exists conversations_project_group_key\s*\n\s*on crm\.conversations \(project_id\)\s*\n\s*where kind = 'project_group' and status <> 'abandoned'/,
    );
  });

  test('one live approval group per organization', () => {
    assert.match(
      executable,
      /create unique index if not exists conversations_internal_group_key\s*\n\s*on crm\.conversations \(organization_id\)\s*\n\s*where kind = 'internal_group' and status <> 'abandoned'/,
    );
  });

  test('abandoned is excluded, so a replaced group does not block its successor', () => {
    // The same reasoning as invoices_milestone_live_key excluding `void`: a
    // group the agency left must not make the project permanently ungroupable.
    const matches = executable.match(/status <> 'abandoned'/g) ?? [];
    assert.ok(matches.length >= 2, 'both group indexes must exclude abandoned');
  });

  test('a WhatsApp group id belongs to one conversation across the deployment', () => {
    // Not scoped by organization on purpose. Two tenants claiming one group is
    // the shape D22 was, and it would route one agency's approvals into
    // another agency's thread.
    assert.match(
      executable,
      /create unique index if not exists conversations_group_external_ref_key\s*\n\s*on crm\.conversations \(external_ref\)/,
    );
    assert.doesNotMatch(
      executable,
      /conversations_group_external_ref_key[\s\S]{0,160}organization_id/,
      'scoping the group id by organization would let two tenants claim one group',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. The function, and the caller's four answers
// ═══════════════════════════════════════════════════════════════════════════

describe('C. crm.link_whatsapp_group', () => {
  test('reads the constraint from diagnostics, not from the error message', () => {
    // SQLERRM is prose and prose is translated. Under a non-English
    // lc_messages a taken group would be reported as already-linked, and the
    // caller would tell somebody they own a group that belongs to another
    // agency.
    assert.match(executable, /get stacked diagnostics v_constraint = constraint_name/);
  });

  test('and tells a taken group apart from one already linked', () => {
    assert.match(executable, /if v_constraint = 'conversations_group_external_ref_key' then/);
    assert.match(executable, /return query select 'group_taken'::text/);
    assert.match(executable, /return query select 'already_linked'::text/);
  });

  test('is SECURITY INVOKER, so conversations_write still decides', () => {
    assert.match(executable, /security invoker/);
    assert.doesNotMatch(executable, /security definer/);
  });

  test('is not reachable by anon or the public role', () => {
    assert.match(executable, /revoke all on function crm\.link_whatsapp_group\([^)]*\) from public, anon;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The input, and who may link which kind
// ═══════════════════════════════════════════════════════════════════════════

describe('D. the request', () => {
  test('a project group must name a project', () => {
    const bad = linkWhatsAppGroupSchema.safeParse({
      kind: 'project_group',
      externalRef: 'g-1',
    });
    assert.equal(bad.success, false);
  });

  test('an internal group must not name one', () => {
    const bad = linkWhatsAppGroupSchema.safeParse({
      kind: 'internal_group',
      externalRef: 'g-1',
      projectId: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(bad.success, false);
  });

  test('and both are accepted in their own shape', () => {
    assert.equal(
      linkWhatsAppGroupSchema.safeParse({
        kind: 'project_group',
        externalRef: 'g-1',
        projectId: '11111111-1111-4111-8111-111111111111',
      }).success,
      true,
    );
    assert.equal(
      linkWhatsAppGroupSchema.safeParse({ kind: 'internal_group', externalRef: 'g-2' }).success,
      true,
    );
  });

  test('an empty group id is refused before the database is asked', () => {
    assert.equal(
      linkWhatsAppGroupSchema.safeParse({ kind: 'internal_group', externalRef: '   ' }).success,
      false,
    );
  });

  test('pointing the approval group somewhere is an owner-level act', () => {
    // The internal group is where money and delivery decisions are answered.
    // `organization.settings` already means "change what this agency is", and
    // it resolves to the owner alone — so the capability is reused rather than
    // a new one invented, which is finance's rule.
    assert.equal(can('owner', 'organization.settings'), true);
    assert.equal(can('ops_admin', 'organization.settings'), false);

    // A project group is ordinary CRM work.
    assert.equal(can('ops_admin', 'lead.write'), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. The caller, executed with only the database stubbed
// ═══════════════════════════════════════════════════════════════════════════

let role: Role = 'owner';
let rpcOutcome: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const seen = { rpcs: [] as [string, unknown][] };

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role,
      userId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    }),
  },
});

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema() {
        return {
          rpc(fn: string, args: unknown) {
            seen.rpcs.push([fn, args]);
            return { then: (resolve: (v: typeof rpcOutcome) => unknown) => resolve(rpcOutcome) };
          },
        };
      },
    }),
  },
});

const { linkWhatsAppGroup } = await import('../src/modules/crm/service.ts');

const INTERNAL = { kind: 'internal_group', externalRef: 'wa-group-1' } as const;

beforeEach(() => {
  role = 'owner';
  rpcOutcome = { data: null, error: null };
  seen.rpcs = [];
});

describe('E. linkWhatsAppGroup answers each outcome differently', () => {
  test('a linked group succeeds and says it was new', async () => {
    rpcOutcome = { data: [{ outcome: 'linked', conversation_id: 'conv-1' }], error: null };

    const result = await linkWhatsAppGroup(INTERNAL);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, { conversationId: 'conv-1', linked: true });
  });

  test('an existing group is the answer, not an error', async () => {
    // Two people linking the same group is a race, not a mistake. Both should
    // be told the same thing about the same conversation.
    rpcOutcome = { data: [{ outcome: 'already_linked', conversation_id: 'conv-1' }], error: null };

    const result = await linkWhatsAppGroup(INTERNAL);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, { conversationId: 'conv-1', linked: false });
  });

  test('a group somebody else holds is a conflict a retry cannot fix', async () => {
    rpcOutcome = { data: [{ outcome: 'group_taken', conversation_id: null }], error: null };

    const result = await linkWhatsAppGroup(INTERNAL);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'CONFLICT');
  });

  test('a failed call is an error, not a group quietly unlinked', async () => {
    rpcOutcome = { data: null, error: { message: 'could not connect to server' } };

    const result = await linkWhatsAppGroup(INTERNAL);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /could not connect|relation|server/);
  });

  test('an empty response is a failed read, not a silent success — G-054', async () => {
    rpcOutcome = { data: [], error: null };

    const result = await linkWhatsAppGroup(INTERNAL);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
  });

  test('an outcome nobody recognises is an error', async () => {
    rpcOutcome = { data: [{ outcome: 'banana', conversation_id: null }], error: null };

    const result = await linkWhatsAppGroup(INTERNAL);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
  });

  test('an ops admin cannot point the approval group somewhere', async () => {
    role = 'ops_admin';

    const result = await linkWhatsAppGroup(INTERNAL);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'FORBIDDEN');
    assert.deepEqual(seen.rpcs, [], 'a forbidden caller still reached the database');
  });

  test('but can link a project group, which is ordinary CRM work', async () => {
    role = 'ops_admin';
    rpcOutcome = { data: [{ outcome: 'linked', conversation_id: 'conv-2' }], error: null };

    const result = await linkWhatsAppGroup({
      kind: 'project_group',
      externalRef: 'wa-group-2',
      projectId: '33333333-3333-4333-8333-333333333333',
    });

    assert.equal(result.ok, true);
    assert.equal(seen.rpcs.length, 1);
  });
});
