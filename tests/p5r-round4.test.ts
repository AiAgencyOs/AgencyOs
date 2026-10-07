import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Round 4 text pins. Text can say a control is written down; only Postgres can say it works, and scripts/verify-p5r-round4.sql (live doors) plus
 * scripts/redproof/p5r-round4.py (each control removed from the live definition) do that. This holds the shape those rely on and the two connections
 * (the verifier in the CI chain, the completion report on the finance close page), so removing either turns this red.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = `${root}supabase/migrations/`;
const names = readdirSync(dir).filter((f) => /^20261205\d{6}_/.test(f)).sort();
const sql = names.map((f) => readFileSync(`${dir}${f}`, 'utf8')).join('\n');
const code = sql.replace(/--.*$/gm, '');
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');

describe('the round-four migration', () => {
  test('it is inside the allotted range and names new objects with the p5r_ prefix', () => {
    assert.ok(names.length >= 1);
    for (const n of names) {
      const ts = Number(n.slice(0, 14));
      assert.ok(ts >= 20261205000000 && ts <= 20261205990000, n);
    }
    for (const m of code.matchAll(/create or replace function ((?:projects|finance)\.\w+)/g)) assert.match(m[1]!, /\.p5r_/, String(m[1]));
  });
  test('no function sets the replication role; nothing deletes or drops', () => {
    assert.ok(!/session_replication_role/.test(code));
    assert.ok(!/\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b/i.test(code));
  });
  test('the how-to close requires a citation, then a still-approved article, and no longer accepts free text in its place', () => {
    assert.match(code, /approved_knowledge_citation_required/);
    assert.match(code, /cited_knowledge_no_longer_approved/);
    assert.match(code, /ticket_knowledge_citations kc where kc\.ticket_id = v_t\.id/);
    assert.match(code, /ka\.status = 'approved'/);
    assert.match(code, /\$n\$if v_note is null then return query select 'answer_and_source_required'/);
  });
  test('the patches are applied to the live definition and raise when the expected text is missing', () => {
    assert.match(code, /pg_get_functiondef\('projects\.advance_support_ticket/);
    assert.match(code, /pg_get_functiondef\('projects\.p8_build_intake/);
    assert.match(code, /expected text not found/);
  });
  test('the preference reader is internal-only; the report is for signed-in Admin/Finance and not for the service role or anon', () => {
    assert.match(code, /revoke all on function projects\.p5r_intake_preferences\(uuid, uuid\) from public, anon, authenticated, service_role/);
    assert.match(code, /revoke all on function finance\.p5r_finance_agent_completion_report\(uuid\) from public, anon, service_role/);
    assert.match(code, /grant execute on function finance\.p5r_finance_agent_completion_report\(uuid\) to authenticated/);
    assert.match(code, /v_kind not in \('admin', 'finance'\)/);
  });
  test('the report is derived: it creates no table and writes nothing', () => {
    assert.ok(!/create table/i.test(code));
    const fn = code.match(/create or replace function finance\.p5r_finance_agent_completion_report[\s\S]*?end \$\$;/);
    assert.ok(fn, 'the report function is present');
    assert.ok(!/\b(insert into|update|delete from)\s+\w+\./i.test(fn[0]));
  });
});

describe('the round-four connections', () => {
  test('the verifier is in the CI chain beside the 8A verifiers whose fixtures it changed', () => {
    const chain = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['db:verify:phase4'] ?? '';
    assert.ok(chain.includes('-f scripts/verify-p5r-round4.sql'));
    assert.ok(chain.includes('-f scripts/verify-phase-eight-a.sql'));
  });
  test('every 8A verifier that closes a how-to cites an approved article first', () => {
    for (const f of ['verify-phase-eight-a.sql', 'verify-phase-eight-d.sql', 'verify-phase-eight-a-gaps2.sql', 'verify-phase-eight-a-gaps-1.sql']) {
      const s = read(`scripts/${f}`);
      assert.ok(s.includes('p5r_cite_approved'), f);
      assert.ok(!s.includes("'knowledge: exports-guide v2')) = 'advanced'"), f);
    }
  });
  test('the finance close page shows the completion report through the guarded read', () => {
    const page = read('app/(internal)/finance/close/[projectId]/page.tsx');
    assert.match(page, /listFinanceAgentRunReports\(projectId\)/);
    assert.match(page, /Agent run completion reports/);
    const q = read('src/modules/finance/phase-nine-queries.ts');
    assert.match(q, /p5r_finance_agent_completion_report/);
    const body = q.slice(q.indexOf('export async function listFinanceAgentRunReports'), q.indexOf('export type PeriodCloseView'));
    assert.equal((body.match(/if \((?:res\.)?error\)/g) ?? []).length, (body.match(/unreadable\(/g) ?? []).length);
  });
  test('the support actions say what to do when a close is refused for want of a citation', () => {
    const a = read('src/modules/projects/phase-eight-actions.ts');
    assert.match(a, /approved_knowledge_citation_required:/);
    assert.match(a, /cited_knowledge_no_longer_approved:/);
  });
});
