import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, mock, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * One timeline for a lead — Doc 09 §28, closing a granular gap under an
 * already-built feature.
 *
 * `crm.lead_activities` (7 kinds) has been the lead detail page's only
 * activity feed since the CRM schema was built. Quote created/approved/sent,
 * objection logged, and discount/exception approvals ARE all recorded —
 * scattered across `audit.audit_log`, `sales.objections` and
 * `approvals.approval_requests` — but never surfaced on the one screen whose
 * job is showing them. `crm.lead_timeline` unions the four sources; this file
 * proves the union names the right columns and stays inside the RLS lines
 * its sources already draw, and that the reader used to be
 * `listLeadActivities` and is no longer built-and-unreachable itself.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260921110000_one_timeline_for_a_lead.sql'));

describe('A. the union covers the sources §28 names, and adds no reach of its own', () => {
  test('it is SECURITY INVOKER, not DEFINER — no widened reach', () => {
    assert.match(SQL, /security invoker/);
    assert.doesNotMatch(SQL, /security definer/);
  });

  test('lead_activities is scoped by lead_id directly', () => {
    assert.match(SQL, /from crm\.lead_activities la\s*\n\s*where la\.lead_id = p_lead_id/);
  });

  test('objections is scoped by lead_id directly, not through a proposal join', () => {
    assert.match(SQL, /from sales\.objections o\s*\n\s*where o\.lead_id = p_lead_id/);
  });

  test('proposal status changes are scoped to this lead\'s own opportunities', () => {
    assert.match(
      SQL,
      /where al\.subject_type = 'proposal'\s*\n\s*and al\.subject_id in \(\s*\n\s*select p\.id\s*\n\s*from sales\.proposals p\s*\n\s*join sales\.opportunities o on o\.id = p\.opportunity_id\s*\n\s*where o\.lead_id = p_lead_id/,
    );
  });

  test('named approvals are scoped the same way, and only the named ones', () => {
    assert.match(SQL, /ar\.payload \? 'kind'/);
    assert.match(SQL, /ar\.subject_type = 'proposal'/);
  });

  test('every quotation status transition the audit trigger can emit is labelled', () => {
    for (const action of [
      'proposal.drafted',
      'proposal.pending_approval',
      'proposal.approved',
      'proposal.sent',
      'proposal.accepted',
      'proposal.rejected',
      'proposal.repriced',
    ]) {
      assert.match(SQL, new RegExp(`'${action}'`), `${action} is not labelled`);
    }
  });

  test('an approval decision is worded as approved or rejected, not the raw action string', () => {
    assert.match(SQL, /case al\.action when 'approval\.approved' then 'approved' else 'rejected' end/);
  });

  test('invoice and payment events are deliberately not unioned in', () => {
    assert.doesNotMatch(SQL, /finance\.invoices/);
    assert.doesNotMatch(SQL, /finance\.payments/);
  });
});

describe('B. the old reader is gone, not left built-and-unreachable', () => {
  const QUERIES = readFileSync(
    fileURLToPath(new URL('../src/modules/crm/queries.ts', import.meta.url)),
    'utf8',
  );
  const PAGE = readFileSync(
    fileURLToPath(new URL('../app/(internal)/leads/[leadId]/page.tsx', import.meta.url)),
    'utf8',
  );

  test('listLeadActivities no longer exists', () => {
    assert.doesNotMatch(QUERIES, /export async function listLeadActivities/);
  });

  test('listLeadTimeline exists and is what the lead page actually calls', () => {
    assert.match(QUERIES, /export async function listLeadTimeline/);
    assert.match(PAGE, /listLeadTimeline\(leadId\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. The service's half — executed, with only the database stubbed
// ═══════════════════════════════════════════════════════════════════════════

let rpcResult: { data: unknown; error: { message: string } | null } = { data: [], error: null };
const seen = { rpcs: [] as [string, Record<string, unknown>][] };

function client() {
  return {
    schema() {
      return {
        rpc: (fn: string, args: Record<string, unknown>) => {
          seen.rpcs.push([fn, args]);
          return Promise.resolve(rpcResult);
        },
      };
    },
  };
}

mock.module('@/lib/db/server', { exports: { createClient: async () => client() } });

const { listLeadTimeline } = await import('../src/modules/crm/queries.ts');

describe('C. the reader asks the right function and refuses loudly on failure', () => {
  test('it calls crm.lead_timeline with the lead id', async () => {
    rpcResult = { data: [], error: null };
    await listLeadTimeline('l1');

    assert.equal(seen.rpcs[0]?.[0], 'lead_timeline');
    assert.equal(seen.rpcs[0]?.[1]?.p_lead_id, 'l1');
  });

  test('a limit trims the merged feed, not the SQL call', async () => {
    rpcResult = {
      data: Array.from({ length: 5 }, (_, i) => ({ occurred_at: String(i) })),
      error: null,
    };
    const result = await listLeadTimeline('l1', 2);

    assert.equal(result.length, 2);
  });

  test('a failed read throws rather than rendering an empty timeline (G-054)', async () => {
    rpcResult = { data: null, error: { message: 'connection reset' } };

    await assert.rejects(() => listLeadTimeline('l1'));
  });
});
