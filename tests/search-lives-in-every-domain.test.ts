import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { ilikeAny, ilikeOperand, normaliseSearch } from '../src/lib/db/search.ts';

import { codeOnly } from './_code-only.ts';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Bucket G, stream G-3 — the shared rule "Search within domain" (PDF §3).
 *
 * Every list screen that can grow reads `?q=`, mounts the ONE shared search
 * box (`DomainSearch`), hands the text to its reader, and the reader filters
 * SERVER-SIDE with one PostgREST `or=` over the human-named columns, escaped
 * the same way everywhere. The page says "N results for 'q'" with a clear
 * link. Notifications is the one exception the test names: its items are
 * composed on the server from a dozen sources, so the search runs on the
 * server over the composed rows rather than in PostgREST.
 */

type Domain = {
  page: string;
  reader: string;
  /** The reader function that gains `q`. */
  fn: string;
  /** The columns the reader searches. */
  columns: string[];
  /** A parent matched by its own column first, then the row filtered by id. */
  via?: { column: string; filter: string };
};

const DOMAINS: Domain[] = [
  { page: 'app/(internal)/projects/page.tsx', reader: 'src/modules/projects/queries.ts', fn: 'listProjectsForTable', columns: ['name', 'code'] },
  { page: 'app/(internal)/follow-ups/page.tsx', reader: 'src/modules/crm/follow-up-detail-queries.ts', fn: 'listFollowUpSequencesDetailed', columns: ['title'] },
  // An embedded column cannot sit in the top-level `or=` (PostgREST refuses
  // the logic tree), so these two match the parent by name with the client's
  // own ilike() first and filter by id second — `via` names that read.
  { page: 'app/(internal)/meetings/page.tsx', reader: 'src/modules/crm/queries.ts', fn: 'listMeetings', columns: ['purpose'], via: { column: 'title', filter: 'lead_id.in.' } },
  { page: 'app/(internal)/finance/payments/page.tsx', reader: 'src/modules/finance/queries.ts', fn: 'listPayments', columns: ['provider_payment_id', 'provider'], via: { column: 'number', filter: 'invoice_id.in.' } },
  { page: 'app/(internal)/finance/expenses/page.tsx', reader: 'src/modules/finance/queries.ts', fn: 'listExpenses', columns: ['vendor', 'description', 'category'] },
  { page: 'app/(internal)/approvals/page.tsx', reader: 'src/modules/approvals/queries.ts', fn: 'listPendingApprovals', columns: ['summary', 'subject_type'] },
  { page: 'app/(internal)/settings/team/page.tsx', reader: 'src/modules/projects/queries.ts', fn: 'listInternalRosterWithRoles', columns: ['full_name', 'email'] },
  { page: 'app/(internal)/settings/templates/page.tsx', reader: 'src/modules/projects/project-template-queries.ts', fn: 'listProjectTemplates', columns: ['name', 'description'] },
  { page: 'app/(internal)/communication/campaigns/page.tsx', reader: 'src/modules/crm/campaign-queries.ts', fn: 'listCampaigns', columns: ['name'] },
  { page: 'app/(internal)/usage/runs/page.tsx', reader: 'src/lib/admin/agent-runs.ts', fn: 'listAgentRuns', columns: ['agent_key', 'trigger', 'model', 'error'] },
  { page: 'app/(internal)/qa/page.tsx', reader: 'src/modules/qa/queries.ts', fn: 'listOpenDefects', columns: ['title', 'environment'] },
  { page: 'app/(internal)/audit/page.tsx', reader: 'src/lib/audit/queries.ts', fn: 'readAuditPage', columns: ['action', 'subject_type'] },
];

/** The body of one exported async function, up to the next export. */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is not exported`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nexport /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe('A. the pattern is escaped once, the same way everywhere', () => {
  test('wildcards and quotes are escaped and the operand is quoted', () => {
    assert.equal(ilikeOperand('50%'), '"*50\\%*"');
    assert.equal(ilikeOperand('a_b'), '"*a\\_b*"');
    assert.equal(ilikeOperand('say "hi", (now)'), '"*say \\"hi\\", (now)*"');
    assert.equal(ilikeAny(['name', 'code'], 'acme'), 'name.ilike."*acme*",code.ilike."*acme*"');
  });

  test('the query is trimmed and bounded, and blank means no search', () => {
    assert.equal(normaliseSearch('  acme  '), 'acme');
    assert.equal(normaliseSearch(undefined), '');
    assert.equal(normaliseSearch('x'.repeat(200)).length, 120);
  });

  test('the helper lives in src/lib/db and imports nothing', () => {
    const helper = codeOnly(read('src/lib/db/search.ts'));
    assert.doesNotMatch(helper, /^import /m);
  });
});

describe('B. one shared search box, exported from @/ui', () => {
  test('DomainSearch is a GET form that submits ?q= to the list’s own path and keeps the other filters', () => {
    const primitive = read('src/ui/primitives/domain-search.tsx');
    assert.match(primitive, /export function DomainSearch\(/);
    assert.match(primitive, /<form action=\{action\} method="GET" role="search"/);
    assert.match(primitive, /type="search" name="q"/);
    assert.match(primitive, /export function SearchSummary\(/);
    assert.match(primitive, /result\{count === 1 \? '' : 's'\} for/);
    assert.match(primitive, /Clear search/);
    assert.match(read('src/ui/index.ts'), /export \* from '\.\/primitives\/domain-search';/);
  });
});

describe('C. every domain reads ?q=, mounts the box and filters server-side', () => {
  for (const d of DOMAINS) {
    const name = d.page.replace('app/(internal)/', '').replace('/page.tsx', '');

    test(`/${name} reads q, mounts DomainSearch with a summary, and hands q to ${d.fn}`, () => {
      const page = read(d.page);
      assert.match(page, /q\?: string/, 'the page does not declare ?q=');
      assert.match(page, /normaliseSearch\(/, 'the page does not normalise q');
      assert.match(page, new RegExp(`<DomainSearch action="/${name}"`), 'the shared box is not mounted on its own path');
      assert.match(page, /<SearchSummary q=/, 'no "N results for q" line');
      const call = new RegExp(`${d.fn}\\([^)]*q`);
      assert.match(page, call, `${d.fn} is not handed q`);
    });

    test(`${d.fn} filters server-side over ${d.columns.join(', ')}`, () => {
      const body = codeOnly(fnBody(read(d.reader), d.fn));
      assert.match(body, /\.or\(/, 'no PostgREST or= filter');
      assert.match(body, /ilikeAny\(|ilikeOperand\(/, 'the shared escaping is not used');
      for (const column of d.columns) assert.ok(body.includes(`'${column}'`), `${d.fn} does not search ${column}`);
      if (d.via) {
        assert.ok(body.includes(`.ilike('${d.via.column}', ilikePattern(`), `${d.fn} does not match the parent by ${d.via.column} with the shared escaping`);
        assert.ok(body.includes(d.via.filter), `${d.fn} does not filter by the matched parent ids`);
        assert.doesNotMatch(body, /ilikeAny\(\[[^\]]*'[a-z_]+\.[a-z_]+'/, `${d.fn} still puts an embedded column in or=`);
      }
    });
  }

  test('/notifications reads q and searches the composed items on the server, and says why', () => {
    const page = read('app/(internal)/notifications/page.tsx');
    assert.match(page, /q\?: string/);
    assert.match(page, /<DomainSearch action="\/notifications"/);
    assert.match(page, /<SearchSummary q=/);
    assert.match(page, /there is no column to hand PostgREST/);
    assert.match(page, /everything\.filter\(\(r\) => r\.title\.toLowerCase\(\)\.includes\(needle\)/);
  });
});
