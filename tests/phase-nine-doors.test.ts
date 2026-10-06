import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { HANDLER_JOB_KIND, SUBSCRIPTIONS, subscribersFor } from '../src/lib/events/catalog.ts';
import { financiallyClosedAnnouncementFor, financiallyClosedEventSchema } from '../src/modules/crm/schema.ts';
import { PHASE_NINE_DOORS, PHASE_NINE_WORDS, isPhaseNineDoor, phaseNineWords } from '../src/modules/finance/phase-nine-doors.ts';
import { BLOCKER_TITLES, blockerTitle, closeModeLabel, formatMinor, resultLabel, resultTone } from '../src/modules/finance/phase-nine-view.ts';

/**
 * The Phase 9 Admin / Finance surface: the whitelist of doors, the words a person reads, the read layer's failure discipline, the presentation helpers
 * and the one announcer. Pure or structural; the doors' BEHAVIOUR is proved on a real Postgres (scripts/verify-phase-nine.sql).
 */

const root = new URL('../', import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8');
const bare = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const phaseNineSql = readdirSync(new URL('supabase/migrations', root)).filter((f) => /^20261106/.test(f)).map((f) => read(`supabase/migrations/${f}`)).join('\n');

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe('the door whitelist', () => {
  const names = Object.keys(PHASE_NINE_DOORS);
  test('twelve doors, every one a real finance function this phase created', () => {
    assert.equal(names.length, 12);
    for (const n of names) {
      const rpc = PHASE_NINE_DOORS[n]!.rpc;
      assert.match(phaseNineSql, new RegExp(`create or replace function finance\\.${rpc}\\(`), `${n} -> finance.${rpc} is created by a Phase 9 migration`);
      assert.match(phaseNineSql, new RegExp(`grant execute on function finance\\.${rpc}\\([^)]*\\) to authenticated`), `${rpc} is granted to a signed-in person`);
    }
  });
  test('there is NO door that verifies a payment, records or approves a refund, edits an invoice or an amount, or sends a message', () => {
    const rpcs = names.map((n) => PHASE_NINE_DOORS[n]!.rpc).join(' ');
    for (const forbidden of ['verify', 'refund', 'issue_invoice', 'void_invoice', 'record_manual_payment', 'send', 'message', 'update_invoice', 'set_amount', 'edit']) {
      assert.ok(!rpcs.includes(forbidden), `no door contains "${forbidden}"`);
    }
  });
  test('an unknown name selects nothing, including inherited object keys', () => {
    for (const bad of ['', 'verify_payment', 'toString', '__proto__', 'constructor', 'hasOwnProperty']) assert.equal(isPhaseNineDoor(bad), false, bad);
    for (const n of names) assert.equal(isPhaseNineDoor(n), true, n);
  });
  test('every outcome a door treats as success has words, and a refusal is shown in plain language (never swallowed)', () => {
    for (const n of names) for (const outcome of PHASE_NINE_DOORS[n]!.ok) assert.ok(PHASE_NINE_WORDS[outcome], `${n}:${outcome} has words`);
    assert.equal(phaseNineWords('self_approval'), 'You requested this, so another Admin must decide it.');
    assert.equal(phaseNineWords('some_new_refusal'), 'Refused: some new refusal.');
    assert.match(phaseNineWords('accepted'), /Nothing was sent and no money moved/);
    assert.match(phaseNineWords('closed'), /not complete until Phase 7/);
  });
  test('the door arguments come from the form, and an amount that is not an amount is not sent', () => {
    assert.deepEqual(PHASE_NINE_DOORS.request_waiver!.args(fd({ invoiceId: 'i', amount: '5,000.50', reason: 'r' })), { p_invoice_id: 'i', p_amount_minor: 500050, p_reason: 'r' });
    for (const bad of ['', 'abc', '-5', '0', '1.005']) assert.equal(PHASE_NINE_DOORS.request_waiver!.args(fd({ invoiceId: 'i', amount: bad, reason: 'r' })), null, `amount "${bad}"`);
    assert.deepEqual(PHASE_NINE_DOORS.close_period!.args(fd({ periodStart: '2026-09-01', periodEnd: '2026-10-01', label: 'Sep', acknowledgement: '' })), { p_period_start: '2026-09-01', p_period_end: '2026-10-01', p_label: 'Sep', p_acknowledgement: null });
    assert.deepEqual(PHASE_NINE_DOORS.accept_proposal!.args(fd({ proposalId: 'p' })), { p_proposal_id: 'p', p_note: null });
    assert.deepEqual(PHASE_NINE_DOORS.open_exception!.args(fd({ kind: 'chargeback', reason: 'r', projectId: 'p' })), { p_kind: 'chargeback', p_reason: 'r', p_project_id: 'p', p_invoice_id: null, p_submission_id: null, p_evidence: {} });
  });
  test('a form cannot choose the actor, the organization or a status: no door takes one', () => {
    for (const n of names) {
      const built = PHASE_NINE_DOORS[n]!.args(fd({ projectId: 'p', invoiceId: 'i', amount: '1', actor: 'x', organizationId: 'o', status: 's', requestedBy: 'x', decidedBy: 'x' }));
      if (built === null) continue;
      for (const k of Object.keys(built)) assert.ok(!/actor|organization|status|requested_by|decided_by|opened_by/.test(k), `${n} sends ${k}`);
    }
  });
});

describe('the server action', () => {
  const src = read('src/modules/finance/phase-nine-actions.ts');
  test('a use-server file exports only async functions', () => {
    assert.match(src, /^'use server';/);
    const exports = [...bare(src).matchAll(/^export\s+(.*)$/gm)].map((m) => m[1]!);
    assert.deepEqual(exports.map((e) => e.replace(/\(.*$/, '')), ['async function phaseNineDoorAction']);
  });
  test('it dispatches through the whitelist only, gates on may-read-money, and reports a database failure as a failure', () => {
    const code = bare(src);
    assert.match(code, /can\(context, 'invoice\.read'\)/);
    assert.match(code, /isPhaseNineDoor\(name\)/);
    assert.match(code, /PHASE_NINE_DOORS\[name\]/);
    assert.match(code, /if \(error\) \{[\s\S]*?nothing was recorded/);
    assert.match(code, /if \(!door\.ok\.includes\(outcome\)\) return \{ status: 'error'/);
    assert.ok(!/\.(insert|update|upsert|delete)\(/.test(code), 'the action writes nothing itself');
  });
});

describe('the read layer refuses to render a read it could not do (G-054)', () => {
  const src = read('src/modules/finance/phase-nine-queries.ts');
  const code = bare(src);
  test('every database read is followed by an unreadable() refusal', () => {
    const reads = (code.match(/\.from\('|\.rpc\('/g) ?? []).length;
    const refusals = (code.match(/unreadable\(/g) ?? []).length;
    assert.equal(reads, refusals, `${reads} reads, ${refusals} refusals`);
    assert.match(code, /^import 'server-only';/m);
  });
  test('it computes no money: no arithmetic on a verified, invoiced or outstanding figure', () => {
    assert.ok(!/[+*/] ?\w*(verified|invoiced|outstanding|collected)/i.test(code.replace(/\/\/.*$/gm, '')), 'figures are the database\'s');
  });
  test('the pages are server components that gate on permission and never import a write path of their own', () => {
    for (const page of ['app/(internal)/finance/close/page.tsx', 'app/(internal)/finance/close/[projectId]/page.tsx']) {
      const p = bare(read(page));
      assert.match(p, /requireInternal\(/);
      assert.match(p, /can\(context, 'invoice\.read'\)/);
      assert.match(p, /<PermissionDenied/);
      assert.ok(!/\.rpc\(|\.insert\(|\.update\(/.test(p), `${page} writes nothing`);
    }
  });
  test('the forms file is a client component whose only action is the whitelist', () => {
    const f = read('app/(internal)/finance/close/phase-nine-forms.tsx');
    assert.match(f, /^'use client';/);
    assert.match(f, /phaseNineDoorAction/);
    assert.ok(!/@\/lib\/db|createClient/.test(f));
  });
  test('React keys are unique within each list (no index-only or repeated key)', () => {
    for (const page of ['app/(internal)/finance/close/page.tsx', 'app/(internal)/finance/close/[projectId]/page.tsx']) {
      const keys = [...read(page).matchAll(/key=\{([^}]+)\}/g)].map((m) => m[1]!);
      assert.ok(keys.length > 0);
      for (const k of keys) assert.ok(!/^i$|^index$/.test(k.trim()), `${page}: a bare index key (${k})`);
    }
  });
});

describe('presentation helpers', () => {
  test('rupees use Indian grouping; other currencies use thousands; negatives keep their sign; paise always show', () => {
    assert.equal(formatMinor(12345678), 'INR 1,23,456.78');
    assert.equal(formatMinor(100), 'INR 1.00');
    assert.equal(formatMinor(99), 'INR 0.99');
    assert.equal(formatMinor(100000), 'INR 1,000.00');
    assert.equal(formatMinor(-250050), '-INR 2,500.50');
    assert.equal(formatMinor(123456789, 'USD'), 'USD 1,234,567.89');
    assert.equal(formatMinor(0), 'INR 0.00');
  });
  test('result tones and labels: clear is not the same as a balance, and a balance is not a block', () => {
    assert.equal(resultTone('clear'), 'success');
    assert.equal(resultTone('outstanding_only'), 'warning');
    assert.equal(resultTone('blocked'), 'danger');
    assert.equal(resultTone(null), 'neutral');
    assert.equal(resultLabel(null), 'Not evaluated');
    assert.equal(closeModeLabel('approved_exception'), 'Closed against an approved exception');
    assert.equal(closeModeLabel(null), 'Not closed');
  });
  test('every blocker code the database emits has a title, and an unknown one is shown humanised, not hidden', () => {
    const emitted = [...new Set([...phaseNineSql.matchAll(/'code', '([a-z_]+)'/g)].map((m) => m[1]!))];
    assert.ok(emitted.length >= 10, emitted.join(','));
    for (const c of emitted) assert.ok(BLOCKER_TITLES[c], `${c} has a title`);
    assert.equal(blockerTitle('brand_new_code'), 'brand new code');
  });
});

describe('the one announcer: the PM is told a project\'s finances are closed, and that it is not completion', () => {
  test('the event is declared in the database, subscribed in the catalog, and its handler has a job kind', () => {
    assert.match(phaseNineSql, /insert into core\.event_types[\s\S]*?'project\.financially_closed'/);
    assert.deepEqual([...subscribersFor('project.financially_closed')], ['crm:announceFinanciallyClosed']);
    assert.equal(HANDLER_JOB_KIND['crm:announceFinanciallyClosed'], 'financially_closed.announce');
    assert.ok('project.financially_closed' in SUBSCRIPTIONS);
  });
  test('the event the database emits parses, and the announcement says what it is and is not', () => {
    const parsed = financiallyClosedEventSchema.safeParse({ projectId: '00000000-0000-4000-8000-000000000001', mode: 'zero_balance' });
    assert.equal(parsed.success, true);
    assert.equal(financiallyClosedEventSchema.safeParse({ projectId: 'x', mode: 'zero_balance' }).success, false);
    assert.equal(financiallyClosedEventSchema.safeParse({ projectId: '00000000-0000-4000-8000-000000000001', mode: 'anything' }).success, false);
    const zero = financiallyClosedAnnouncementFor({ projectName: 'Acme', mode: 'zero_balance' });
    const exc = financiallyClosedAnnouncementFor({ projectName: null, mode: 'approved_exception' });
    assert.match(zero, /zero balance/);
    assert.match(exc, /exception an Admin approved/);
    assert.match(exc, /an unnamed project/);
    for (const t of [zero, exc]) assert.match(t, /financial close only/);
  });
  test('the database emits exactly the payload the schema parses, and the runner executes the handler', () => {
    assert.match(phaseNineSql, /core\.emit_event\(v_org, 'project\.financially_closed', 'project', p_project_id, jsonb_build_object\('projectId', p_project_id, 'mode', v_mode\)\)/);
    const route = read('app/api/jobs/run/route.ts');
    assert.match(route, /runEventJobs\(admin, FINANCIALLY_CLOSED_ANNOUNCE_JOB_KIND, announceFinanciallyClosed,/);
    assert.match(route, /financiallyClosedAnnouncements: financiallyClosedAnnouncements\.results/);
    assert.match(read('src/modules/crm/handlers.ts'), /export async function announceFinanciallyClosed/);
  });
});
