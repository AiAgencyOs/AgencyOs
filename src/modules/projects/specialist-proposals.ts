import { z } from 'zod';

import { containsSecretValue } from './specialist-drafts';

/**
 * What the nine remaining development specialists may PROPOSE (Phase 5 PDFs 04-09, 11-13): pure, so the workflows, the panel and the tests share one
 * definition. The same rules are held again in the database (`projects.record_specialist_proposal`); tests/development-specialist-workflows.test.ts holds
 * the pattern lists here equal to the ones in that migration.
 *
 * A specialist run can only PROPOSE: a plan with the files it would touch (each inside the task's own affected paths), the tests it would write, the
 * risks, and the evidence a result would have to carry. It never writes code into a repository, never records a test result and never approves
 * anything. Nothing in this module has been run against a real model.
 */

export const DEVELOPMENT_SPECIALIST_KEYS = [
  'frontend_developer',
  'backend_developer',
  'database_developer',
  'mobile_developer',
  'integration',
  'devops_build',
  'security_review',
  'bug_fix',
  'refactor_performance',
] as const;
export type DevelopmentSpecialistKey = (typeof DEVELOPMENT_SPECIALIST_KEYS)[number];
export const developmentSpecialistJobKind = (agentKey: string): string => `development.${agentKey}.propose`;
export const isDevelopmentSpecialist = (key: string): key is DevelopmentSpecialistKey => (DEVELOPMENT_SPECIALIST_KEYS as readonly string[]).includes(key);

export const EVIDENCE_KINDS = ['typecheck', 'lint', 'tests', 'build', 'live', 'record'] as const;
export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

// ═══ the pure rules (mirrored in the migration) ══════════════════════════════════════════════════════════════════════════════════════════════

/** Paths no specialist plans to touch (secrets, .env, key material); migrations are the database developer's alone. Held equal to the migration by a test. */
export const FORBIDDEN_PATH_PATTERNS = {
  secrets: ['(^|/)\\.env[^/]*$', '(^|/)secrets?(/|\\.|$)', '\\.(pem|key|p12|pfx)$', '(^|/)id_(rsa|ed25519)'],
  migrations: '(^|/)supabase/migrations(/|$)',
} as const;

/** The envelope's forbidden actions as patterns over the plan text. `\b` here is `\y` in the migration. Held equal by a test. */
export const FORBIDDEN_ACTION_PATTERNS: readonly { code: string; source: string }[] = [
  { code: 'deploy', source: '\\b(deploy|deploys|deploying|deployed|release|releasing|publish|publishing|push|pushing)\\b[^.\\n]{0,40}\\b(prod|production|live|app ?store|play ?store)\\b' },
  { code: 'merge', source: '\\bmerg\\w*\\b[^.\\n]{0,40}\\b(main|master|production|protected|release)\\b' },
  { code: 'self_approval', source: '\\b(self[- ]?(approv|verif)\\w*|(approv|verif)\\w*\\b[^.\\n]{0,20}\\b(own|my|its own))' },
  { code: 'scope', source: '\\b(chang\\w*|expand\\w*|widen\\w*|extend\\w*)\\b[^.\\n]{0,20}\\b(scope|baseline)\\b' },
  { code: 'payment', source: '\\b(verif\\w*|confirm\\w*)\\b[^.\\n]{0,20}\\bpayments?\\b|\\b(issu\\w*|process\\w*)\\b[^.\\n]{0,10}\\brefunds?\\b' },
];

const ACTION_RES = FORBIDDEN_ACTION_PATTERNS.map((p) => ({ code: p.code, re: new RegExp(p.source, 'i') }));
const SECRET_PATH_RES = FORBIDDEN_PATH_PATTERNS.secrets.map((s) => new RegExp(s));
const MIGRATION_PATH_RE = new RegExp(FORBIDDEN_PATH_PATTERNS.migrations);

/** The first forbidden action in a text, or null. A secret VALUE counts as one. */
export function forbiddenActionIn(text: string): string | null {
  for (const { code, re } of ACTION_RES) if (re.test(text)) return code;
  return containsSecretValue(text) ? 'secret' : null;
}

const normalise = (p: string): string => p.trim().replaceAll('\\', '/').replace(/^(\.\/)+/, '');

export function forbiddenPathReason(file: string, agent: string): 'secrets' | 'migrations' | null {
  const f = normalise(file).toLowerCase();
  if (SECRET_PATH_RES.some((re) => re.test(f))) return 'secrets';
  if (MIGRATION_PATH_RE.test(f) && agent !== 'database_developer') return 'migrations';
  return null;
}

/** Is a planned file inside one of the task's affected paths? A file, a directory or a glob (cut at its first wildcard segment); never `..`, never absolute. */
export function pathWithinAffected(file: string, affected: readonly string[]): boolean {
  const f = normalise(file);
  if (f === '' || f.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(f) || /[*?]/.test(f)) return false;
  for (const raw of affected) {
    const a = normalise(raw);
    const kept: string[] = [];
    for (const seg of a.split('/')) {
      if (/[*?[{]/.test(seg)) break;
      if (seg === '' || seg === '.') continue;
      kept.push(seg);
    }
    const base = kept.join('/');
    if (base === '') {
      if (a !== '' && /[*?[{]/.test(a)) return true;
      continue;
    }
    if (f === base || f.startsWith(`${base}/`)) return true;
  }
  return false;
}

// ═══ the proposal ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const line = (max: number) => z.string().trim().min(1).max(max);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const proposalSchema = z
  .object({
    outcome: z.enum(['proposal', 'not_required']),
    summary: line(4000),
    plannedFiles: z.array(line(300)).max(40),
    plannedTests: z.array(line(300)).max(40),
    risks: z.array(line(500)).max(40),
    evidencePlan: z.array(z.enum(EVIDENCE_KINDS)).max(12),
    // per-agent fields: which of them an agent may carry is its PROFILE's decision, not the schema's
    defectId: uuid.nullish(),
    rootCause: line(1000).nullish(),
    findings: z
      .array(z.object({ severity: z.enum(FINDING_SEVERITIES), path: line(300), description: line(1000) }).strict())
      .max(50)
      .nullish(),
    migrations: z.array(line(300)).max(10).nullish(),
    measurement: z.object({ metric: line(200), baseline: line(200), target: line(200) }).strict().nullish(),
    target: line(200).nullish(),
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;

export function proposalJsonSchema(): Record<string, unknown> {
  const strs = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
  return {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['proposal', 'not_required'], description: 'not_required only when the task genuinely does not apply (mobile or refactor only).' },
      summary: { type: 'string', description: 'The plan in a few sentences, at most 4000 characters.' },
      plannedFiles: strs('Repository paths you would touch: each inside the task\'s affected paths. Empty for a review or a not_required answer.'),
      plannedTests: strs('Tests you would write or run.'),
      risks: strs('What could go wrong.'),
      evidencePlan: { type: 'array', items: { type: 'string', enum: [...EVIDENCE_KINDS] }, description: 'Every evidence kind the task requires.' },
      defectId: { type: ['string', 'null'], description: 'bug_fix only: the id of the defect linked to this task.' },
      rootCause: { type: ['string', 'null'], description: 'bug_fix only: the suspected root cause.' },
      findings: {
        type: ['array', 'null'],
        description: 'security_review only.',
        items: {
          type: 'object',
          properties: { severity: { type: 'string', enum: [...FINDING_SEVERITIES] }, path: { type: 'string' }, description: { type: 'string' } },
          required: ['severity', 'path', 'description'],
          additionalProperties: false,
        },
      },
      migrations: { type: ['array', 'null'], items: { type: 'string' }, description: 'database_developer only: migration files you would add; each is also in plannedFiles.' },
      measurement: {
        type: ['object', 'null'],
        description: 'refactor_performance only.',
        properties: { metric: { type: 'string' }, baseline: { type: 'string' }, target: { type: 'string' } },
        required: ['metric', 'baseline', 'target'],
        additionalProperties: false,
      },
      target: { type: ['string', 'null'], description: 'mobile_developer only: the mobile target (for example Flutter, Android, iOS).' },
    },
    required: ['outcome', 'summary', 'plannedFiles', 'plannedTests', 'risks', 'evidencePlan'],
    additionalProperties: false,
  };
}

// ═══ per-agent profiles ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export type SpecialistProfile = {
  /** The detail fields (beyond the common ones) this agent has a reason to carry. */
  detailKeys: readonly ('defectId' | 'rootCause' | 'findings' | 'migrations' | 'measurement' | 'target')[];
  mayPlanMigrations: boolean;
  /** A review proposes findings and never edits a file. */
  mayPlanFiles: boolean;
  mayBeNotRequired: boolean;
  requiresDefect: boolean;
  requiresFindings: boolean;
  guidance: string;
};

const common = (what: string) => `${what} You only PROPOSE: you write no code, run nothing, record no test result and approve nothing. Every planned file must be inside the task's affected paths. Plan every evidence kind the task requires. Never write a secret value. Never plan to deploy, merge to a protected branch, approve or verify your own work, change the scope or verify a payment, and do not mention such actions at all.`;

export const SPECIALIST_PROFILES: Record<DevelopmentSpecialistKey, SpecialistProfile> = {
  frontend_developer: {
    detailKeys: [], mayPlanMigrations: false, mayPlanFiles: true, mayBeNotRequired: false, requiresDefect: false, requiresFindings: false,
    guidance: common('You plan the frontend work for ONE task against the exact approved UI version and prototype: screens, states, forms and accessibility. No silent redesign.'),
  },
  backend_developer: {
    detailKeys: [], mayPlanMigrations: false, mayPlanFiles: true, mayBeNotRequired: false, requiresDefect: false, requiresFindings: false,
    guidance: common('You plan the backend and API work for ONE task: business logic, validation and server actions that trace to the acceptance criteria. Never redefine scope. Schema changes are the database developer\'s.'),
  },
  database_developer: {
    detailKeys: ['migrations'], mayPlanMigrations: true, mayPlanFiles: true, mayBeNotRequired: false, requiresDefect: false, requiresFindings: false,
    guidance: common('You plan schema, constraint, RLS and migration work for ONE task. You may plan NEW migration files (list them in migrations and in plannedFiles). Never rewrite migration history, never weaken RLS to make a feature work.'),
  },
  mobile_developer: {
    detailKeys: ['target'], mayPlanMigrations: false, mayPlanFiles: true, mayBeNotRequired: true, requiresDefect: false, requiresFindings: false,
    guidance: common('You plan the approved mobile UI work for ONE task. If the project has no mobile target, answer outcome not_required with the reason in the summary and no files or tests: never invent mobile work and never claim a device test.'),
  },
  integration: {
    detailKeys: [], mayPlanMigrations: false, mayPlanFiles: true, mayBeNotRequired: false, requiresDefect: false, requiresFindings: false,
    guidance: common('You plan the connection to an approved external service through the canonical adapter for ONE task. Configured is not verified, and a mock success is not a real integration: plan a live check, never claim one.'),
  },
  devops_build: {
    detailKeys: [], mayPlanMigrations: false, mayPlanFiles: true, mayBeNotRequired: false, requiresDefect: false, requiresFindings: false,
    guidance: common('You plan build-system work for ONE task: environment checks, builds and artifacts with source traceability. Phase 5 builds and tests only: never any production deployment.'),
  },
  security_review: {
    detailKeys: ['findings'], mayPlanMigrations: false, mayPlanFiles: false, mayBeNotRequired: false, requiresDefect: false, requiresFindings: true,
    guidance: common('You review ONE task\'s planned change for auth, RLS, tenancy, secrets and injection problems. You propose FINDINGS only, each with a severity (critical, high, medium, low, info), a path and a description. You never edit: plannedFiles stays empty. A review by you is not verification: QA decides.'),
  },
  bug_fix: {
    detailKeys: ['defectId', 'rootCause'], mayPlanMigrations: false, mayPlanFiles: true, mayBeNotRequired: false, requiresDefect: true, requiresFindings: false,
    guidance: common('You plan the minimal fix for ONE defect linked to the task: set defectId to a defect id you were given and state the suspected root cause. You never close a defect: QA verifies.'),
  },
  refactor_performance: {
    detailKeys: ['measurement'], mayPlanMigrations: false, mayPlanFiles: true, mayBeNotRequired: true, requiresDefect: false, requiresFindings: false,
    guidance: common('You plan approved technical-debt or measured-performance work for ONE task: a baseline measurement first, a before-and-after comparison, and no functional change. If there is no approved debt or measured problem, answer not_required.'),
  },
};

// ═══ validating a proposal ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const PROPOSAL_REJECTIONS = [
  'wrong_agent',
  'outside_affected_paths',
  'forbidden_path',
  'forbidden_action',
  'missing_evidence',
  'empty_plan',
  'defect_required',
  'findings_required',
  'review_must_not_edit',
  'not_required_not_allowed',
  'not_required_has_a_plan',
  'fabricated_work',
  'detail_not_allowed',
  'migration_not_planned',
] as const;
export type ProposalRejection = (typeof PROPOSAL_REJECTIONS)[number];

export type ProposalContext = {
  agentKey: string;
  /** From the TASK row. */
  affectedPaths: readonly string[];
  /** The task's `required_capability`. */
  requiredCapability: string | null;
  /** From the envelope on the routed handoff. */
  requiredEvidence: readonly string[];
  /** Defects linked to this task (a bug fix cites one). */
  linkedDefectIds: readonly string[];
  /** The project records this agent NOT_REQUIRED: a proposal of real work then is fabricated. */
  recordedNotRequired: boolean;
};

export type ProposalVerdict = { ok: true } | { ok: false; codes: ProposalRejection[]; messages: string[] };

const PROPOSAL_FIELDS_TEXT = (p: Proposal): string => [p.summary, ...p.plannedFiles, ...p.plannedTests, ...p.risks, p.rootCause ?? '', p.target ?? '', ...(p.migrations ?? []), JSON.stringify(p.findings ?? []), JSON.stringify(p.measurement ?? {})].join('\n');

/** The proposal against the profile, the task and the envelope. Refused, never repaired. Every refusal is returned (the Admin reads all of them). */
export function validateProposal(p: Proposal, ctx: ProposalContext): ProposalVerdict {
  const codes: ProposalRejection[] = [];
  const messages: string[] = [];
  const reject = (code: ProposalRejection, message: string) => {
    if (!codes.includes(code)) codes.push(code);
    messages.push(message);
  };
  if (!isDevelopmentSpecialist(ctx.agentKey) || ctx.requiredCapability !== ctx.agentKey) {
    reject('wrong_agent', `the task is assigned to ${ctx.requiredCapability ?? 'no specialist'}, not ${ctx.agentKey}`);
    return { ok: false, codes, messages };
  }
  const profile = SPECIALIST_PROFILES[ctx.agentKey];
  const action = forbiddenActionIn(PROPOSAL_FIELDS_TEXT(p));
  if (action) reject('forbidden_action', `the proposal plans or mentions a forbidden action (${action})`);

  const detail: Record<string, unknown> = { defectId: p.defectId, rootCause: p.rootCause, findings: p.findings, migrations: p.migrations, measurement: p.measurement, target: p.target };
  for (const [key, value] of Object.entries(detail)) {
    if (value !== null && value !== undefined && !profile.detailKeys.includes(key as never)) reject('detail_not_allowed', `${ctx.agentKey} does not carry ${key}`);
  }

  if (p.outcome === 'not_required') {
    if (!profile.mayBeNotRequired) reject('not_required_not_allowed', `${ctx.agentKey} cannot decide its own task is not required: planning decides that`);
    if (p.plannedFiles.length > 0 || p.plannedTests.length > 0) reject('not_required_has_a_plan', 'a NOT_REQUIRED answer carries no files and no tests');
    return codes.length ? { ok: false, codes, messages } : { ok: true };
  }

  if (ctx.recordedNotRequired) reject('fabricated_work', `${ctx.agentKey} is recorded NOT_REQUIRED on this project: a plan for real work is fabricated`);
  if (p.plannedFiles.length === 0 && profile.mayPlanFiles) reject('empty_plan', 'the proposal plans no file');
  if (!profile.mayPlanFiles && p.plannedFiles.length > 0) reject('review_must_not_edit', `${ctx.agentKey} proposes findings and never edits a file`);
  for (const file of p.plannedFiles) {
    const why = forbiddenPathReason(file, ctx.agentKey);
    if (why) reject('forbidden_path', `${file} touches ${why}`);
    else if (!pathWithinAffected(file, ctx.affectedPaths)) reject('outside_affected_paths', `${file} is outside the task's affected paths`);
  }
  const missing = ctx.requiredEvidence.filter((e) => !(p.evidencePlan as readonly string[]).includes(e));
  if (ctx.requiredEvidence.length === 0 || missing.length > 0) {
    reject('missing_evidence', ctx.requiredEvidence.length === 0 ? 'the envelope names no required evidence' : `the plan leaves out required evidence: ${missing.join(', ')}`);
  }
  if (profile.requiresDefect && (!p.defectId || !ctx.linkedDefectIds.includes(p.defectId))) reject('defect_required', 'a bug fix must cite a defect linked to this task');
  if (profile.requiresFindings && (!p.findings || p.findings.length === 0)) reject('findings_required', 'a security review proposes at least one finding');
  if (profile.mayPlanMigrations && p.migrations) {
    for (const m of p.migrations) if (!p.plannedFiles.includes(m)) reject('migration_not_planned', `${m} is named as a migration but is not a planned file`);
  }
  return codes.length ? { ok: false, codes, messages } : { ok: true };
}

// ═══ validating an execution result (a later stage: what a specialist reports it DID) ═══════════════════════════════════════════════════════

export type ExecutionEnvelopeFacts = { taskId: string; affectedPaths: readonly string[]; requiredEvidence: readonly string[] };
export type ExecutionResult = {
  taskId: string;
  buildId: string | null;
  /** The build the run was given; when set the result must be for exactly that build. */
  expectedBuildId?: string | null;
  tests: { ran: number; failed: number };
  changedFiles: readonly string[];
  /** Free text the run produced (logs, a summary): scanned for secrets. */
  output?: string;
  /** Requirements, features or screens the run added that the task did not name. */
  newScope?: readonly string[];
};

export const RESULT_REJECTIONS = ['task_mismatch', 'build_mismatch', 'tests_not_run', 'tests_failed', 'files_outside_affected_paths', 'forbidden_path', 'secret_in_result', 'scope_expansion', 'forbidden_action'] as const;
export type ResultRejection = (typeof RESULT_REJECTIONS)[number];
export type ResultVerdict = { ok: true } | { ok: false; codes: ResultRejection[] };

/**
 * A reported result against the envelope. It is a claim, not evidence: this decides only whether the claim is eligible to be looked at by QA.
 * It never marks anything passed. Hidden scope expansion is any file outside the affected paths or any new scope item.
 */
export function validateExecutionResult(envelope: ExecutionEnvelopeFacts, result: ExecutionResult): ResultVerdict {
  const codes: ResultRejection[] = [];
  const add = (c: ResultRejection) => {
    if (!codes.includes(c)) codes.push(c);
  };
  if (result.taskId !== envelope.taskId) add('task_mismatch');
  if (result.expectedBuildId && result.buildId !== result.expectedBuildId) add('build_mismatch');
  if (envelope.requiredEvidence.includes('tests')) {
    if (!(result.tests.ran > 0)) add('tests_not_run');
  }
  if (result.tests.failed > 0) add('tests_failed');
  for (const f of result.changedFiles) {
    if (forbiddenPathReason(f, 'result')) add('forbidden_path');
    else if (!pathWithinAffected(f, envelope.affectedPaths)) add('files_outside_affected_paths');
  }
  const text = [result.output ?? '', ...result.changedFiles].join('\n');
  if (containsSecretValue(text)) add('secret_in_result');
  if (forbiddenActionIn(result.output ?? '') && !codes.includes('secret_in_result')) add('forbidden_action');
  if ((result.newScope ?? []).length > 0 || codes.includes('files_outside_affected_paths')) add('scope_expansion');
  return codes.length ? { ok: false, codes } : { ok: true };
}

// ═══ the model's brief ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export function proposalSystemPrompt(agentKey: DevelopmentSpecialistKey): string {
  return SPECIALIST_PROFILES[agentKey].guidance;
}

export function renderProposalBrief(input: {
  title: string;
  description: string | null;
  acceptanceCriteria: string;
  affectedPaths: readonly string[];
  requiredEvidence: readonly string[];
  riskClass: string | null;
  linkedDefects: readonly { id: string; title: string }[];
  recordedNotRequired: boolean;
}): string {
  return [
    `Task: ${input.title}`,
    `Description: ${input.description?.trim() || 'none'}`,
    `Acceptance criteria: ${input.acceptanceCriteria.trim() || 'none'}`,
    `Risk class: ${input.riskClass ?? 'unknown'}`,
    `Affected paths (every planned file must be inside one): ${input.affectedPaths.length ? input.affectedPaths.join(', ') : 'none'}`,
    `Required evidence (plan every one): ${input.requiredEvidence.join(', ') || 'none'}`,
    input.linkedDefects.length ? `Linked defects: ${input.linkedDefects.map((d) => `${d.id} (${d.title})`).join('; ')}` : 'Linked defects: none',
    input.recordedNotRequired ? 'This project records you as NOT_REQUIRED: answer outcome not_required.' : 'This project requires you.',
  ].join('\n');
}

/** The arguments the database door takes for a validated proposal (`p_detail` carries only the keys the profile allows). */
export function doorDetail(p: Proposal): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  if (p.defectId) detail.defectId = p.defectId;
  if (p.rootCause) detail.rootCause = p.rootCause;
  if (p.findings) detail.findings = p.findings;
  if (p.migrations) detail.migrations = p.migrations;
  if (p.measurement) detail.measurement = p.measurement;
  if (p.target) detail.target = p.target;
  return detail;
}
