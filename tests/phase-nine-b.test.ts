import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildFinanceHandoff, financeHandoffSchema, handoffPriority } from '../src/modules/finance/phase-nine-handoff.ts';
import { PHASE_NINE_B_DOORS, isPhaseNineBDoor, phaseNineBWords } from '../src/modules/finance/phase-nine-b-doors.ts';
import { cadenceSentence, lifecycleLabel, lifecycleTone } from '../src/modules/finance/phase-nine-b-view.ts';
import { buildVerificationPacket, type PacketFacts } from '../src/modules/finance/phase-nine-verification-packet.ts';

/**
 * Phase 9B: the pure parts (handoff payload, verification packet, door whitelist, view words) and structural pins on the migrations. The database
 * behaviour is proved by scripts/verify-phase-nine-b.sql on a real Postgres; nothing here pretends to be that.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = {
  organizationId: U(1), clientAccountId: U(2), projectId: U(3), requestId: U(4), requestedBy: U(5), agent: 'finance_reconciliation' as const,
  proposal: { kind: 'anomaly_flag' as const, evidenceRefs: [`invoice:${U(6)}`] }, invoice: { id: U(6), outstandingMinor: 30000 }, currency: 'INR', financialState: 'blocked',
  blockers: [{ code: 'unverified_money', ref: null }], correlationId: 'corr-1', attempt: 0, maxAttempts: 5,
};

describe('the handoff payload', () => {
  test('a complete build satisfies the schema and says no money authority and an independent review', () => {
    const r = buildFinanceHandoff(base);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.handoff.policy.moneyAuthority, 'none');
    assert.equal(r.handoff.approvals.independentReviewRequired, true);
    assert.equal(r.handoff.expectedAmountMinor, 30000);
    assert.equal(r.handoff.invoiceId, U(6));
    assert.equal(r.handoff.priority, 'high');
    assert.ok(financeHandoffSchema.safeParse(r.handoff).success);
  });
  test('no invoice means no expected amount; one cited milestone is carried, two are not', () => {
    const none = buildFinanceHandoff({ ...base, invoice: null });
    assert.ok(none.ok && none.handoff.invoiceId === null && none.handoff.expectedAmountMinor === null);
    const one = buildFinanceHandoff({ ...base, proposal: { kind: 'anomaly_flag', evidenceRefs: [`milestone:${U(7)}`] } });
    assert.ok(one.ok && one.handoff.milestoneId === U(7));
    const two = buildFinanceHandoff({ ...base, proposal: { kind: 'anomaly_flag', evidenceRefs: [`milestone:${U(7)}`, `milestone:${U(8)}`] } });
    assert.ok(two.ok && two.handoff.milestoneId === null);
  });
  test('a payload that is not valid is refused, never repaired', () => {
    assert.equal(buildFinanceHandoff({ ...base, organizationId: 'org-1' }).ok, false);
    assert.equal(buildFinanceHandoff({ ...base, requestedBy: '' }).ok, false);
    assert.equal(buildFinanceHandoff({ ...base, currency: 'RUPEES' }).ok, false);
  });
  test('the schema is strict: an extra key, a claim of money authority or a waived review is refused', () => {
    const r = buildFinanceHandoff(base);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(financeHandoffSchema.safeParse({ ...r.handoff, verified: true }).success, false);
    assert.equal(financeHandoffSchema.safeParse({ ...r.handoff, policy: { ...r.handoff.policy, moneyAuthority: 'full' } }).success, false);
    assert.equal(financeHandoffSchema.safeParse({ ...r.handoff, approvals: { ...r.handoff.approvals, independentReviewRequired: false } }).success, false);
  });
  test('priority follows the kind', () => {
    assert.equal(handoffPriority('anomaly_flag', null), 'high');
    assert.equal(handoffPriority('exception_classification', 'clear'), 'high');
    assert.equal(handoffPriority('close_readiness_note', 'blocked'), 'high');
    assert.equal(handoffPriority('close_readiness_note', 'clear'), 'normal');
    assert.equal(handoffPriority('reminder_draft', 'blocked'), 'normal');
  });
});

const facts = (over: Partial<PacketFacts> = {}): PacketFacts => ({
  claim: { id: 's1', status: 'pending_verification', amountMinor: 12000, currency: 'INR', method: 'upi', reference: 'UTR1', payerName: 'Acme', paidAt: null, submittedAt: '2026-10-01', hasProof: true, receivingAccountLabel: 'Operating' },
  invoice: { number: 'INV-1', status: 'issued', currency: 'INR', totalMinor: 12000, verifiedMinor: 0, dueAt: null },
  clientName: 'Acme Widgets', projectName: 'Site', otherClaims: [], crossCheck: { kind: 'reference_and_amount', line: { id: 'b', statementDate: '2026-10-01', description: 'UPI UTR1', reference: 'UTR1', amountMinor: 12000, status: 'pending' } },
  openExceptions: [], accountCheck: { outcome: 'consistent', clientName: 'Acme Widgets' }, ...over,
});

describe('the verification packet', () => {
  test('everything agreeing is ready, and it still never says verified', () => {
    const p = buildVerificationPacket(facts());
    assert.equal(p.readiness, 'ready');
    assert.match(p.reminder, /only a person verifying/);
    assert.doesNotMatch(JSON.stringify(p), /is verified|payment received/i);
  });
  test('each thing a reviewer must look at is a flag', () => {
    const codes = (f: PacketFacts) => buildVerificationPacket(f).flags.filter((x) => x.tone !== 'ok').map((x) => x.code);
    assert.ok(codes(facts({ claim: { ...facts().claim, amountMinor: 5000 } })).includes('partial_amount'));
    assert.ok(codes(facts({ claim: { ...facts().claim, amountMinor: 20000 } })).includes('amount_exceeds'));
    assert.ok(codes(facts({ claim: { ...facts().claim, reference: null } })).includes('no_reference'));
    assert.ok(codes(facts({ claim: { ...facts().claim, hasProof: false } })).includes('no_proof'));
    assert.ok(codes(facts({ otherClaims: [{ id: 's2', status: 'pending_verification', reference: ' utr1 ', amountMinor: 1 }] })).includes('duplicate_reference'));
    assert.ok(codes(facts({ crossCheck: { kind: 'none' } })).includes('bank_cross_check'));
    assert.ok(codes(facts({ accountCheck: { outcome: 'both', clientName: 'Acme' } })).includes('account_check'));
    assert.ok(codes(facts({ accountCheck: null })).includes('account_unchecked'));
    assert.ok(codes(facts({ openExceptions: [{ id: 'e', kind: 'chargeback', blocking: true, reason: 'disputed' }] })).includes('exception_chargeback'));
    assert.ok(codes(facts({ invoice: { ...facts().invoice, currency: 'USD' } })).includes('currency_differs'));
    assert.ok(codes(facts({ invoice: { ...facts().invoice, verifiedMinor: 12000 } })).includes('nothing_remaining'));
    assert.ok(codes(facts({ claim: { ...facts().claim, status: 'rejected' } })).includes('already_decided'));
  });
  test('the pure module and its reads never write', () => {
    for (const f of ['src/modules/finance/phase-nine-verification-packet.ts', 'src/modules/finance/phase-nine-packet-queries.ts', 'app/(internal)/invoices/verify/verification-packet.tsx']) {
      const src = code(f);
      for (const w of ['.insert(', '.update(', '.upsert(', '.delete(', 'verify_payment', 'reject_payment', 'sendClientMessage']) assert.ok(!src.includes(w), `${f} must not use ${w}`);
    }
    const q = code('src/modules/finance/phase-nine-packet-queries.ts');
    assert.equal((q.match(/if \([A-Za-z.]*[eE]rror\)/g) ?? []).length, (q.match(/unreadable\(/g) ?? []).length, 'every read failure is reported');
  });
});

describe('the Phase 9B door whitelist', () => {
  test('exactly three doors; none verifies, refunds, edits or sends', () => {
    assert.deepEqual(Object.keys(PHASE_NINE_B_DOORS).sort(), ['check_payment_account', 'set_automation_paused', 'set_reconciliation_schedule']);
    for (const d of Object.values(PHASE_NINE_B_DOORS)) assert.doesNotMatch(d.rpc, /verify|refund|invoice|send|amount|close/);
    assert.ok(!isPhaseNineBDoor('verify_payment') && !isPhaseNineBDoor('__proto__') && !isPhaseNineBDoor('constructor'));
  });
  test('arguments are built from the form and a bad form sends nothing', () => {
    const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
    const sch = PHASE_NINE_B_DOORS.set_reconciliation_schedule!;
    assert.equal(sch.args(fd({ cadenceCount: 'x', cadenceUnit: 'week' })), null);
    assert.deepEqual(sch.args(fd({ cadenceCount: '2', cadenceUnit: 'week', anchorDate: '2030-01-07', source: 'bank', enabled: 'false' })), { p_account_id: null, p_cadence_unit: 'week', p_cadence_count: 2, p_anchor_date: '2030-01-07', p_source: 'bank', p_enabled: false });
    const pause = PHASE_NINE_B_DOORS.set_automation_paused!;
    assert.equal(pause.args(fd({ agentKey: 'all', paused: 'maybe', reason: 'x' })), null);
    assert.deepEqual(pause.args(fd({ agentKey: 'all', paused: 'true', reason: 'why' })), { p_agent_key: 'all', p_paused: true, p_reason: 'why' });
  });
  test('a refusal is shown in words, and an unknown one is still shown', () => {
    assert.match(phaseNineBWords('not_authorized'), /permission/);
    assert.match(phaseNineBWords('something_new'), /Refused: something new/);
  });
  test('the server-action file exports only async functions', () => {
    const src = code('src/modules/finance/phase-nine-b-actions.ts');
    const exported = src.split('\n').filter((l) => l.startsWith('export '));
    assert.equal(exported.length, 1);
    assert.match(exported[0] ?? '', /^export async function phaseNineBDoorAction\(/);
  });
});

describe('the view words', () => {
  test('every lifecycle state has a label and a tone', () => {
    for (const s of ['not_invoiced', 'invoiced', 'partially_verified', 'fully_verified', 'waived', 'refunded', 'overdue', 'disputed']) {
      assert.ok(lifecycleLabel(s).length > 0 && !lifecycleLabel(s).includes('_'));
      assert.ok(['success', 'warning', 'danger', 'neutral'].includes(lifecycleTone(s)));
    }
    assert.equal(lifecycleTone('overdue'), 'danger');
    assert.equal(lifecycleTone('fully_verified'), 'success');
    assert.equal(cadenceSentence('week', 1), 'every week');
    assert.equal(cadenceSentence('month', 3), 'every 3 months');
  });
});

describe('the Phase 9B migrations (structure; the behaviour is the SQL verifier)', () => {
  const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
  const files = readdirSync(dir).filter((f) => /^202611110\d{5}|^20261111\d{6}/.test(f)).sort();
  test('versions stay inside 20261111000000 to 20261111999999 and there are four', () => {
    assert.equal(files.length, 4);
    for (const f of files) assert.ok(f.slice(0, 14) >= '20261111000000' && f.slice(0, 14) <= '20261111999999', f);
  });
  test('no migration sets the replication role (CI runs on a non-superuser)', () => {
    for (const f of files) assert.doesNotMatch(read(`supabase/migrations/${f}`), /session_replication_role/);
  });
  test('every new table has RLS on, a finance/admin select policy, no end-user writes, tenancy freeze', () => {
    const tables = ['reconciliation_schedules', 'reconciliation_due_items', 'payment_account_checks', 'finance_automation_controls', 'finance_automation_changes'];
    const all = files.map((f) => read(`supabase/migrations/${f}`)).join('\n');
    for (const t of tables) {
      assert.match(all, new RegExp(`create table if not exists finance\\.${t} `), t);
    }
    for (const f of files.filter((x) => /reconciliation|automation/.test(x))) {
      const s = read(`supabase/migrations/${f}`);
      assert.match(s, /enable row level security/);
      assert.match(s, /core\.is_admin\(\)\) or \(select core\.is_finance\(\)\)/);
      assert.match(s, /revoke insert, update, delete on finance\.%I from authenticated/);
      assert.match(s, /core\.freeze_organization_id\(\)/);
    }
    const wrong = read(`supabase/migrations/${files.find((x) => /wrong_account/.test(x))}`);
    assert.match(wrong, /enable row level security/);
    assert.match(wrong, /core\.enforce_parent_org\(%L, %L\)/);
    assert.match(wrong, /'client_account_id', 'core\.client_accounts'/);
    assert.match(wrong, /phase9_history_append_only/);
  });
  test('every definer function sets an empty search_path and every runner door checks the service role inside', () => {
    for (const f of files) {
      const s = read(`supabase/migrations/${f}`);
      const defs = [...s.matchAll(/create or replace function ([a-z0-9_.]+)\(([\s\S]*?)\n(?:\$\$|end \$\$;)/g)];
      for (const d of defs) if (/security definer/.test(d[0])) assert.match(d[0], /set search_path = ''/, `${d[1]} in ${f}`);
    }
    const all = files.map((f) => read(`supabase/migrations/${f}`)).join('\n');
    for (const door of ['sweep_reconciliation_due', 'sweep_payment_account_checks', 'finance_automation_is_paused']) {
      const i = all.indexOf(`create or replace function finance.${door}(`);
      assert.ok(i >= 0, door);
      assert.match(all.slice(i, i + 900), /auth\.role\(\)\), ''\) <> 'service_role'/, `${door} checks the role inside`);
    }
  });
  test('no Phase 9B migration touches verification, refund, issue or void', () => {
    for (const f of files) {
      const s = read(`supabase/migrations/${f}`).replace(/--.*$/gm, '');
      assert.doesNotMatch(s, /create or replace function finance\.(verify_payment|record_manual_payment|record_refund|request_refund|issue_invoice|void_invoice)/);
    }
  });
});
