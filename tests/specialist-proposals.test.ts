import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGENT_DEFINITIONS, definitionFor } from '../src/modules/agents/registry.ts';
import {
  DEVELOPMENT_SPECIALIST_KEYS,
  EVIDENCE_KINDS,
  FORBIDDEN_ACTION_PATTERNS,
  FORBIDDEN_PATH_PATTERNS,
  PROPOSAL_REJECTIONS,
  RESULT_REJECTIONS,
  SPECIALIST_PROFILES,
  doorDetail,
  forbiddenActionIn,
  forbiddenPathReason,
  pathWithinAffected,
  proposalJsonSchema,
  proposalSchema,
  validateExecutionResult,
  validateProposal,
  type Proposal,
  type ProposalContext,
  type ProposalRejection,
  type ResultRejection,
} from '../src/modules/projects/specialist-proposals.ts';

/**
 * The pure rules for the nine development specialists' proposals and for a reported execution result. Nothing here ran on a real model: what is proved
 * is that every profile accepts what it should, that every rejection code is reachable, and that these rules are the ones the database door holds.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const secret = () => `api_key=${'x'.repeat(20)}`;
const DEFECT = '11111111-1111-4111-8111-111111111111';

const EVIDENCE: Record<string, string[]> = Object.fromEntries(DEVELOPMENT_SPECIALIST_KEYS.map((k) => [k, [...(definitionFor(k)?.verification.requiredEvidence ?? [])]]));
const PATHS: Record<string, string[]> = {
  frontend_developer: ['src/ui', 'app/cart/page.tsx'],
  backend_developer: ['src/api'],
  database_developer: ['supabase/migrations', 'src/db/**'],
  mobile_developer: ['mobile/lib'],
  integration: ['src/integrations'],
  devops_build: ['scripts/build'],
  security_review: ['src/auth'],
  bug_fix: ['src/cart'],
  refactor_performance: ['src/perf'],
};
const FILE: Record<string, string> = {
  frontend_developer: 'src/ui/button.tsx',
  backend_developer: 'src/api/pay.ts',
  database_developer: 'supabase/migrations/20261103800000_cart.sql',
  mobile_developer: 'mobile/lib/main.dart',
  integration: 'src/integrations/maps.ts',
  devops_build: 'scripts/build/run.sh',
  security_review: 'src/auth/session.ts',
  bug_fix: 'src/cart/total.ts',
  refactor_performance: 'src/perf/index.ts',
};

const ctx = (agent: string, over: Partial<ProposalContext> = {}): ProposalContext => ({
  agentKey: agent,
  affectedPaths: PATHS[agent] ?? [],
  requiredCapability: agent,
  requiredEvidence: EVIDENCE[agent] ?? [],
  linkedDefectIds: [DEFECT],
  recordedNotRequired: false,
  ...over,
});

function good(agent: string): Proposal {
  const base = {
    outcome: 'proposal' as const,
    summary: 'Plan the change in small, reviewable steps.',
    plannedFiles: [FILE[agent]!],
    plannedTests: ['tests/one.test.ts'],
    risks: ['a regression in a neighbouring screen'],
    evidencePlan: [...(EVIDENCE[agent] ?? [])] as Proposal['evidencePlan'],
  };
  if (agent === 'database_developer') return proposalSchema.parse({ ...base, migrations: [FILE[agent]] });
  if (agent === 'bug_fix') return proposalSchema.parse({ ...base, defectId: DEFECT, rootCause: 'rounding before summing' });
  if (agent === 'security_review') return proposalSchema.parse({ ...base, plannedFiles: [], findings: [{ severity: 'high', path: 'src/auth/session.ts', description: 'the cookie is not httpOnly' }] });
  if (agent === 'refactor_performance') return proposalSchema.parse({ ...base, measurement: { metric: 'p95 ms', baseline: '420', target: '300' } });
  if (agent === 'mobile_developer') return proposalSchema.parse({ ...base, target: 'Flutter' });
  return proposalSchema.parse(base);
}
const withP = (agent: string, over: Record<string, unknown>): Proposal => proposalSchema.parse({ ...good(agent), ...over });

const reached = new Set<ProposalRejection>();
function codesOf(p: Proposal, c: ProposalContext): ProposalRejection[] {
  const v = validateProposal(p, c);
  if (v.ok) return [];
  for (const code of v.codes) reached.add(code);
  return v.codes;
}

describe('the nine specialists and their profiles', () => {
  test('exactly the development specialists the registry defines, minus the two with their own workflows', () => {
    const fromRegistry = AGENT_DEFINITIONS.filter((d) => d.layer === 'development' && !['documentation', 'test_automation'].includes(d.key)).map((d) => d.key).sort();
    assert.deepEqual([...DEVELOPMENT_SPECIALIST_KEYS].sort(), fromRegistry);
    assert.equal(DEVELOPMENT_SPECIALIST_KEYS.length, 9);
    for (const k of DEVELOPMENT_SPECIALIST_KEYS) assert.ok(SPECIALIST_PROFILES[k], k);
  });
  test('every evidence kind a specialist requires is one a proposal may plan', () => {
    for (const k of DEVELOPMENT_SPECIALIST_KEYS) for (const e of EVIDENCE[k]!) assert.ok((EVIDENCE_KINDS as readonly string[]).includes(e), `${k} ${e}`);
  });
  for (const agent of DEVELOPMENT_SPECIALIST_KEYS) {
    test(`${agent}: a well-formed proposal passes its profile`, () => {
      assert.deepEqual(validateProposal(good(agent), ctx(agent)), { ok: true });
    });
  }
  test('only the profiles that should carry a detail key carry it', () => {
    assert.deepEqual(SPECIALIST_PROFILES.database_developer.detailKeys, ['migrations']);
    assert.deepEqual(SPECIALIST_PROFILES.security_review.detailKeys, ['findings']);
    assert.deepEqual(SPECIALIST_PROFILES.bug_fix.detailKeys, ['defectId', 'rootCause']);
    assert.deepEqual(SPECIALIST_PROFILES.frontend_developer.detailKeys, []);
    assert.equal(SPECIALIST_PROFILES.database_developer.mayPlanMigrations, true);
    assert.equal(Object.entries(SPECIALIST_PROFILES).filter(([, p]) => p.mayPlanMigrations).length, 1);
    assert.equal(SPECIALIST_PROFILES.security_review.mayPlanFiles, false);
    assert.deepEqual(Object.entries(SPECIALIST_PROFILES).filter(([, p]) => p.mayBeNotRequired).map(([k]) => k).sort(), ['mobile_developer', 'refactor_performance']);
  });
  test('every prompt says the specialist only proposes and never deploys or approves', () => {
    for (const k of DEVELOPMENT_SPECIALIST_KEYS) assert.match(SPECIALIST_PROFILES[k].guidance, /only PROPOSE/);
  });
});

describe('the schema is strict', () => {
  test('an extra field, a status, an unknown evidence kind, a bad severity or a non-uuid defect is refused', () => {
    const base = good('frontend_developer');
    for (const bad of [{ ...base, status: 'approved' }, { ...base, evidencePlan: ['vibes'] }, { ...base, defectId: 'not-a-uuid' }, { ...base, findings: [{ severity: 'catastrophic', path: 'a', description: 'b' }] }, { ...base, plannedFiles: Array(41).fill('src/ui/a.tsx') }, { ...base, summary: '' }]) {
      assert.equal(proposalSchema.safeParse(bad).success, false);
    }
  });
  test('the JSON schema is closed and names the same fields', () => {
    const js = proposalJsonSchema() as { properties: Record<string, unknown>; additionalProperties: boolean; required: string[] };
    assert.equal(js.additionalProperties, false);
    for (const key of Object.keys(proposalSchema.shape)) assert.ok(key in js.properties, key);
  });
  test('doorDetail carries only what is set', () => {
    assert.deepEqual(doorDetail(good('frontend_developer')), {});
    assert.deepEqual(Object.keys(doorDetail(good('bug_fix'))).sort(), ['defectId', 'rootCause']);
  });
});

describe('every proposal rejection', () => {
  test('wrong_agent: a task assigned to a different specialist, or to none', () => {
    assert.deepEqual(codesOf(good('frontend_developer'), ctx('frontend_developer', { requiredCapability: 'backend_developer' })), ['wrong_agent']);
    assert.deepEqual(codesOf(good('frontend_developer'), ctx('frontend_developer', { requiredCapability: null })), ['wrong_agent']);
    assert.deepEqual(codesOf(good('frontend_developer'), ctx('quality_assurance')), ['wrong_agent']);
  });
  test('outside_affected_paths: a file outside, a prefix sibling, a parent walk, an absolute path, and a task with no paths', () => {
    for (const f of ['src/api/pay.ts', 'src/uikit/x.tsx', 'src/ui/../api/pay.ts', '/etc/passwd']) {
      assert.deepEqual(codesOf(withP('frontend_developer', { plannedFiles: [f] }), ctx('frontend_developer')), ['outside_affected_paths'], f);
    }
    assert.deepEqual(codesOf(good('frontend_developer'), ctx('frontend_developer', { affectedPaths: [] })), ['outside_affected_paths']);
  });
  test('forbidden_path: .env, secrets and key material for everyone; migrations for everyone but the database developer', () => {
    for (const f of ['src/ui/.env.local', 'src/ui/secrets/keys.ts', 'src/ui/server.pem', 'src/ui/id_rsa']) {
      assert.deepEqual(codesOf(withP('frontend_developer', { plannedFiles: [f] }), ctx('frontend_developer')), ['forbidden_path'], f);
    }
    const wide = ctx('frontend_developer', { affectedPaths: ['src/ui', 'supabase/migrations'] });
    assert.deepEqual(codesOf(withP('frontend_developer', { plannedFiles: ['supabase/migrations/20261103999999_x.sql'] }), wide), ['forbidden_path']);
    assert.deepEqual(codesOf(withP('database_developer', { plannedFiles: ['supabase/migrations/.env'], migrations: null }), ctx('database_developer')), ['forbidden_path']);
    assert.deepEqual(validateProposal(good('database_developer'), ctx('database_developer')), { ok: true });
  });
  test('forbidden_action: deploy, merge, self-approval, scope, payment and a secret value, each in a different field', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['deploy', { summary: 'Build it, then deploy to production.' }],
      ['merge', { plannedTests: ['then merge the branch into main'] }],
      ['self-approval', { risks: ['the agent approves its own work'] }],
      ['scope', { summary: 'Also widen the scope to a wishlist.' }],
      ['payment', { summary: 'Verify the payment as received.' }],
      ['secret', { risks: [`uses ${secret()}`] }],
    ];
    for (const [name, over] of cases) assert.deepEqual(codesOf(withP('backend_developer', over), ctx('backend_developer')), ['forbidden_action'], name);
  });
  test('forbidden_action: the same words in the detail (a finding, a root cause) are refused too', () => {
    assert.deepEqual(codesOf(withP('security_review', { findings: [{ severity: 'low', path: 'a', description: 'fix then deploy to production' }] }), ctx('security_review')), ['forbidden_action']);
    assert.deepEqual(codesOf(withP('bug_fix', { rootCause: 'merge into main to fix it' }), ctx('bug_fix')), ['forbidden_action']);
  });
  test('ordinary words that merely resemble a forbidden action pass', () => {
    assert.deepEqual(validateProposal(withP('frontend_developer', { summary: 'Add a button; the release notes stay unchanged. Confirm the layout at 320px.' }), ctx('frontend_developer')), { ok: true });
  });
  test('missing_evidence: one kind left out, none planned, and an envelope that requires none', () => {
    assert.deepEqual(codesOf(withP('frontend_developer', { evidencePlan: ['typecheck', 'lint', 'tests'] }), ctx('frontend_developer')), ['missing_evidence']);
    assert.deepEqual(codesOf(withP('frontend_developer', { evidencePlan: [] }), ctx('frontend_developer')), ['missing_evidence']);
    assert.deepEqual(codesOf(good('frontend_developer'), ctx('frontend_developer', { requiredEvidence: [] })), ['missing_evidence']);
  });
  test('empty_plan: a plan that names no file', () => {
    assert.deepEqual(codesOf(withP('frontend_developer', { plannedFiles: [] }), ctx('frontend_developer')), ['empty_plan']);
  });
  test('defect_required: a bug fix with no defect, a defect of another task, an invented one', () => {
    assert.deepEqual(codesOf(withP('bug_fix', { defectId: null }), ctx('bug_fix')), ['defect_required']);
    assert.deepEqual(codesOf(good('bug_fix'), ctx('bug_fix', { linkedDefectIds: ['22222222-2222-4222-8222-222222222222'] })), ['defect_required']);
    assert.deepEqual(codesOf(good('bug_fix'), ctx('bug_fix', { linkedDefectIds: [] })), ['defect_required']);
  });
  test('findings_required and review_must_not_edit: a security review proposes findings and never edits', () => {
    assert.deepEqual(codesOf(withP('security_review', { findings: [] }), ctx('security_review')), ['findings_required']);
    assert.deepEqual(codesOf(withP('security_review', { findings: null }), ctx('security_review')), ['findings_required']);
    assert.deepEqual(codesOf(withP('security_review', { plannedFiles: ['src/auth/session.ts'] }), ctx('security_review')), ['review_must_not_edit']);
  });
  test('findings carry a severity class, and nothing else may be a class', () => {
    for (const sev of ['critical', 'high', 'medium', 'low', 'info']) assert.equal(proposalSchema.safeParse({ ...good('security_review'), findings: [{ severity: sev, path: 'a', description: 'b' }] }).success, true, sev);
    assert.equal(proposalSchema.safeParse({ ...good('security_review'), findings: [{ severity: 'blocker', path: 'a', description: 'b' }] }).success, false);
  });
  test('not_required: honest for mobile and refactor with no plan; refused for anyone else, and refused with a plan', () => {
    const none = { outcome: 'not_required', summary: 'The project has no mobile target.', plannedFiles: [], plannedTests: [], risks: [], evidencePlan: [] };
    assert.deepEqual(validateProposal(proposalSchema.parse(none), ctx('mobile_developer')), { ok: true });
    assert.deepEqual(validateProposal(proposalSchema.parse(none), ctx('refactor_performance')), { ok: true });
    assert.deepEqual(codesOf(proposalSchema.parse(none), ctx('frontend_developer')), ['not_required_not_allowed']);
    assert.deepEqual(codesOf(proposalSchema.parse({ ...none, plannedFiles: ['mobile/lib/a.dart'] }), ctx('mobile_developer')), ['not_required_has_a_plan']);
  });
  test('fabricated_work: a plan for real mobile work on a project that records mobile NOT_REQUIRED', () => {
    assert.deepEqual(codesOf(good('mobile_developer'), ctx('mobile_developer', { recordedNotRequired: true })), ['fabricated_work']);
  });
  test('detail_not_allowed: a field the agent has no business with', () => {
    assert.deepEqual(codesOf(withP('frontend_developer', { defectId: DEFECT }), ctx('frontend_developer')), ['detail_not_allowed']);
    assert.deepEqual(codesOf(withP('backend_developer', { migrations: ['src/api/x.sql'] }), ctx('backend_developer')), ['detail_not_allowed']);
    assert.deepEqual(codesOf(withP('bug_fix', { findings: [{ severity: 'low', path: 'a', description: 'b' }] }), ctx('bug_fix')), ['detail_not_allowed']);
  });
  test('migration_not_planned: a migration named in the detail that is not a planned file', () => {
    assert.deepEqual(codesOf(withP('database_developer', { migrations: ['supabase/migrations/20261103800001_other.sql'] }), ctx('database_developer')), ['migration_not_planned']);
  });
  test('every code the validator can return was reached above', () => {
    for (const code of PROPOSAL_REJECTIONS) assert.ok(reached.has(code), `${code} was never reached by a test`);
  });
});

describe('path helpers', () => {
  test('a file, a directory and a glob are each a way to be inside', () => {
    assert.equal(pathWithinAffected('app/cart/page.tsx', ['app/cart/page.tsx']), true);
    assert.equal(pathWithinAffected('src/ui/a/b.tsx', ['src/ui']), true);
    assert.equal(pathWithinAffected('src/ui/a/b.tsx', ['src/ui/**']), true);
    assert.equal(pathWithinAffected('./src/ui/b.tsx', ['./src/ui']), true);
    assert.equal(pathWithinAffected('src/ui', ['src/ui/b.tsx']), false);
    assert.equal(pathWithinAffected('anything.ts', ['**']), true);
    assert.equal(pathWithinAffected('anything.ts', []), false);
    assert.equal(pathWithinAffected('src/ui/*.tsx', ['src/ui']), false);
  });
  test('forbidden path reasons', () => {
    assert.equal(forbiddenPathReason('a/.env', 'frontend_developer'), 'secrets');
    assert.equal(forbiddenPathReason('supabase/migrations/a.sql', 'database_developer'), null);
    assert.equal(forbiddenPathReason('supabase/migrations/a.sql', 'backend_developer'), 'migrations');
    assert.equal(forbiddenPathReason('src/environment.ts', 'backend_developer'), null);
    assert.equal(forbiddenActionIn('plain planning text'), null);
  });
});

describe('validateExecutionResult', () => {
  const envelope = { taskId: 't-1', affectedPaths: ['src/ui'], requiredEvidence: ['tests', 'build'] };
  const ok = { taskId: 't-1', buildId: 'b-1', expectedBuildId: 'b-1', tests: { ran: 12, failed: 0 }, changedFiles: ['src/ui/a.tsx'], output: 'built 3 files' };
  const seen = new Set<ResultRejection>();
  const codes = (over: Record<string, unknown>) => {
    const v = validateExecutionResult(envelope, { ...ok, ...over });
    if (v.ok) return [];
    for (const c of v.codes) seen.add(c);
    return v.codes;
  };
  test('a clean result is eligible for QA to look at (it is not marked passed by this)', () => {
    assert.deepEqual(validateExecutionResult(envelope, ok), { ok: true });
  });
  test('task_mismatch and build_mismatch', () => {
    assert.deepEqual(codes({ taskId: 't-2' }), ['task_mismatch']);
    assert.deepEqual(codes({ buildId: 'b-2' }), ['build_mismatch']);
    assert.deepEqual(codes({ buildId: null }), ['build_mismatch']);
  });
  test('tests_not_run and tests_failed', () => {
    assert.deepEqual(codes({ tests: { ran: 0, failed: 0 } }), ['tests_not_run']);
    assert.deepEqual(codes({ tests: { ran: 12, failed: 1 } }), ['tests_failed']);
  });
  test('files outside the affected paths are a refusal AND a hidden scope expansion', () => {
    assert.deepEqual(codes({ changedFiles: ['src/ui/a.tsx', 'src/api/pay.ts'] }), ['files_outside_affected_paths', 'scope_expansion']);
  });
  test('a secret or key file is refused; a secret value in the output is refused', () => {
    assert.deepEqual(codes({ changedFiles: ['src/ui/.env'] }), ['forbidden_path']);
    assert.deepEqual(codes({ output: `log ${secret()}` }), ['secret_in_result']);
  });
  test('scope_expansion: a new scope item with every file in bounds', () => {
    assert.deepEqual(codes({ newScope: ['a wishlist screen'] }), ['scope_expansion']);
  });
  test('forbidden_action: the run reports that it deployed', () => {
    assert.deepEqual(codes({ output: 'then deployed to production' }), ['forbidden_action']);
  });
  test('every code was reached', () => {
    for (const c of RESULT_REJECTIONS) assert.ok(seen.has(c), c);
  });
});

describe('the pattern lists are the ones the database holds', () => {
  const sql = read('supabase/migrations/20261103300000_a_specialist_proposes_in_a_record_and_the_database_refuses_what_it_may_not_plan.sql');
  test('forbidden-action patterns appear in the migration (with \\y for \\b)', () => {
    for (const { code, source } of FORBIDDEN_ACTION_PATTERNS) assert.ok(sql.includes(source.replaceAll('\\b', '\\y')), `${code} pattern is in the migration`);
  });
  test('forbidden-path patterns appear in the migration', () => {
    for (const s of [...FORBIDDEN_PATH_PATTERNS.secrets, FORBIDDEN_PATH_PATTERNS.migrations]) assert.ok(sql.includes(s), `${s} is in the migration`);
  });
  test('the door lists the same nine agents, the same severity classes and the same NOT_REQUIRED agents', () => {
    for (const k of DEVELOPMENT_SPECIALIST_KEYS) assert.ok(sql.includes(`'${k}'`), k);
    for (const s of ['critical', 'high', 'medium', 'low', 'info']) assert.ok(sql.includes(`'${s}'`), s);
    assert.ok(sql.includes("not in ('mobile_developer', 'refactor_performance')"));
  });
});
