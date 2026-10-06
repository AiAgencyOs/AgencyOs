import { z } from 'zod';

import { containsSecretValue } from './specialist-drafts';

/**
 * What the nine Phase 6 QA specialists may PROPOSE: pure, so the workflows and their tests share one definition.
 *
 * STUB-PROVEN ONLY. No real model, browser, device, load or security tool has run any of this. These are the schemas a specialist's answer must satisfy
 * and the per-agent rules that refuse an answer before it reaches the database door (`qa.record_specialist_finding`), which refuses the same things again.
 *
 * A specialist run PROPOSES. A proposal is never a result: it never marks a case passed, never approves a plan, a candidate or an exception, and never
 * writes a verified retest. An independent person turns an accepted proposal into a result through `qa.accept_specialist_finding`, which calls the
 * existing `qa.record_case_result`. The P604 Functional Test Agent PDF is not in the repository; the functional profile is built from the agent's
 * registry purpose, the Phase 6 prompt documents and the existing result door, and has not been checked against that PDF.
 */

export const QA_SPECIALIST_AGENTS = [
  'functional_test', 'ui_journey_test', 'api_integration_test', 'database_test', 'security_test', 'performance_test', 'compatibility_test', 'regression_test', 'release_readiness',
] as const;
export type QaSpecialistAgent = (typeof QA_SPECIALIST_AGENTS)[number];

export const PROPOSED_RESULTS = ['pass', 'fail', 'blocked', 'not_tested'] as const;
export const FINDING_KINDS = ['case_result', 'category_observation', 'gate_summary', 'exception_request'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];
export type ProposedResult = (typeof PROPOSED_RESULTS)[number];

/** The job category each agent serves (the scheduler's own mapping) - `release` is the candidate, not a job category. */
export const AGENT_CATEGORIES: Record<QaSpecialistAgent, readonly string[]> = {
  functional_test: ['functional'],
  ui_journey_test: ['ui_e2e'],
  api_integration_test: ['api', 'integration'],
  database_test: ['database'],
  security_test: ['security'],
  performance_test: ['performance'],
  compatibility_test: ['compatibility'],
  regression_test: ['regression'],
  release_readiness: ['release'],
};

/** Categories whose pass/fail is a claim about an ENVIRONMENT (a browser, a device, a load rig): it must name one the plan lists. */
const ENVIRONMENT_CATEGORIES = new Set(['ui_e2e', 'performance', 'compatibility']);

// ═══ the answer's shape ══════════════════════════════════════════════════

const text = (max: number) => z.string().trim().min(1).max(max);

export const proposalSchema = z
  .object({
    kind: z.enum(FINDING_KINDS),
    caseId: z.string().uuid().nullable(),
    result: z.enum(PROPOSED_RESULTS).nullable(),
    reason: text(2000),
    detail: text(4000).nullable(),
    evidenceRefs: z.array(text(300)).max(20),
    environment: text(200).nullable(),
  })
  .strict();

export const qaFindingsSchema = z.object({ findings: z.array(proposalSchema).min(1).max(30) }).strict();
export type QaFindingsAnswer = z.infer<typeof qaFindingsSchema>;
export type ProposedFinding = z.infer<typeof proposalSchema>;

export function qaFindingsJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...FINDING_KINDS] },
            caseId: { type: ['string', 'null'], description: 'The id of a case you were given (case_result only); null otherwise.' },
            result: { type: ['string', 'null'], enum: [...PROPOSED_RESULTS, null], description: 'A PROPOSED result; null for a gate summary or an exception request.' },
            reason: { type: 'string', description: 'Why, in plain words, at most 2000 characters.' },
            detail: { type: ['string', 'null'] },
            evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'Only references from the facts you were given. A pass needs at least one.' },
            environment: { type: ['string', 'null'], description: 'The environment a pass or fail is about, exactly as listed in the plan.' },
          },
          required: ['kind', 'caseId', 'result', 'reason', 'detail', 'evidenceRefs', 'environment'],
          additionalProperties: false,
        },
      },
    },
    required: ['findings'],
    additionalProperties: false,
  };
}

// ═══ what the workflow read, and so what the model may cite ═════════════

export type QaFacts = {
  agent: QaSpecialistAgent;
  category: string;
  commit: string;
  /** 'held' means the job did not run: only blocked / not_tested may be proposed. */
  jobStatus: 'routed' | 'held' | 'candidate';
  environments: string[];
  cases: { id: string; title: string; criterion: string; priority: string; status: string; journey: string | null; steps: string | null; expected: string | null }[];
  /** Existing records a proposed pass may cite: `run:<id>` for a recorded test run of this project. */
  evidence: { ref: string; detail: string }[];
  /** The project's OWN performance targets (`budget:<metric>`). Empty means there is no target to measure against. */
  budgets: { metric: string; target: number; unit: string; lowerIsBetter: boolean }[];
  devices: { name: string; platform: string; status: string; reason: string | null }[];
  integrations: { name: string; kind: string; health: string; isMock: boolean }[];
  /** Escaped defects (`defect:<id>`) and risks (`risk:<area>`) the regression work protects. */
  escaped: { ref: string; title: string }[];
  /** release_readiness: the stored gate rows and readiness result for the candidate. */
  gates: { gate: string; satisfied: boolean; detail: string }[];
  readiness: string | null;
};

export function allowedEvidenceRefs(f: QaFacts): string[] {
  return [
    ...f.evidence.map((e) => e.ref),
    ...f.budgets.map((b) => `budget:${b.metric}`),
    ...f.integrations.map((i) => `integration:${i.name}`),
    ...f.escaped.map((e) => e.ref),
    ...f.gates.map((g) => `gate:${g.gate}`),
    `commit:${f.commit}`,
  ];
}

export function renderQaFacts(f: QaFacts): string {
  const lines: string[] = [
    `Agent: ${f.agent}. Category: ${f.category}. Exact commit under test: ${f.commit}.`,
    f.jobStatus === 'held' ? 'This job is HELD: it did not run. You may only propose blocked or not_tested.' : 'This job is routed.',
    `Environments the plan lists: ${f.environments.length ? f.environments.join(', ') : '(none)'}.`,
    'Cases:',
    ...f.cases.map((c) => `case:${c.id} [${c.priority}, ${c.status}] ${c.title} - criterion: ${c.criterion}${c.steps ? ` - steps: ${c.steps}` : ''}${c.expected ? ` - expected: ${c.expected}` : ''}`),
    'Evidence you may cite:',
    ...allowedEvidenceRefs(f).map((r) => `- ${r}${f.evidence.find((e) => e.ref === r) ? `: ${f.evidence.find((e) => e.ref === r)?.detail}` : ''}`),
  ];
  if (f.budgets.length) lines.push("The project's own performance targets:", ...f.budgets.map((b) => `budget:${b.metric} = ${b.target} ${b.unit} (${b.lowerIsBetter ? 'lower is better' : 'higher is better'})`));
  if (f.devices.length) lines.push('Declared devices:', ...f.devices.map((d) => `${d.name} (${d.platform}) ${d.status}${d.reason ? ` - ${d.reason}` : ''}`));
  if (f.integrations.length) lines.push('Integrations:', ...f.integrations.map((i) => `integration:${i.name} -> ${i.health}${i.isMock ? ' (mock)' : ''}`));
  if (f.escaped.length) lines.push('Escaped defects and risks:', ...f.escaped.map((e) => `${e.ref}: ${e.title}`));
  if (f.gates.length) lines.push('Stored gates:', ...f.gates.map((g) => `gate:${g.gate} -> ${g.satisfied ? 'satisfied' : 'not satisfied'}: ${g.detail}`));
  if (f.readiness) lines.push(`Stored readiness: ${f.readiness}`);
  return lines.join('\n');
}

// ═══ per-agent profiles ══════════════════════════════════════════════════

/** The rules every specialist shares. Prompts are TEXT for a model: the checks below are what actually bind. */
const COMMON_PROMPT = [
  'You PROPOSE QA results for a person to review. You never record a result, never approve anything and never fix anything.',
  'Answer with JSON only. Cite only evidence references and case ids from the facts you were given; never invent one.',
  'A pass needs at least one evidence reference. A pass on a critical case is never yours to propose. When you could not test something say blocked or not_tested and why.',
  'Never write a secret value: name the variable, never its value.',
].join(' ');

export type AgentProfile = {
  agent: QaSpecialistAgent;
  kinds: readonly FindingKind[];
  prompt: string;
};

export const AGENT_PROFILES: Record<QaSpecialistAgent, AgentProfile> = {
  functional_test: {
    agent: 'functional_test',
    kinds: ['case_result', 'category_observation'],
    prompt: `${COMMON_PROMPT} You are the Functional Test agent: verify features, business rules and acceptance criteria against the exact commit. Each case_result is about one functional case and states which acceptance criterion it checked.`,
  },
  ui_journey_test: {
    agent: 'ui_journey_test',
    kinds: ['case_result', 'category_observation'],
    prompt: `${COMMON_PROMPT} You are the UI / E2E Test agent: test the approved UI and the critical journeys. A pass or fail names the browser environment from the plan. A preference is not a defect unless the approved UI supports it.`,
  },
  api_integration_test: {
    agent: 'api_integration_test',
    kinds: ['case_result', 'category_observation'],
    prompt: `${COMMON_PROMPT} You are the API / Integration Test agent. Configured is not verified; a mock success is not a provider verification: never cite an integration that is not verified (or is a mock) as evidence of a pass.`,
  },
  database_test: {
    agent: 'database_test',
    kinds: ['case_result', 'category_observation'],
    prompt: `${COMMON_PROMPT} You are the Database Test agent: schema, constraints, RLS, tenant isolation, migrations. You never run anything destructive against production and never name production as the environment.`,
  },
  security_test: {
    agent: 'security_test',
    kinds: ['case_result', 'category_observation'],
    prompt: `${COMMON_PROMPT} You are the Security Test agent. Name the weakness and the fix in plain words. NEVER include exploit payloads, injection strings, working request sequences or credentials in any field: reference the evidence instead. detail must be null.`,
  },
  performance_test: {
    agent: 'performance_test',
    kinds: ['case_result', 'category_observation'],
    prompt: `${COMMON_PROMPT} You are the Performance Test agent. Measure ONLY against the project's own targets (budget:<metric>) and cite the one you used. Never invent or cite a universal threshold or an industry standard. With no project target, say not_tested.`,
  },
  compatibility_test: {
    agent: 'compatibility_test',
    kinds: ['case_result', 'category_observation'],
    prompt: `${COMMON_PROMPT} You are the Compatibility / Device Test agent. A simulator is not a device and one browser is not all browsers. A target you cannot reach is BLOCKED with the reason, never a pass.`,
  },
  regression_test: {
    agent: 'regression_test',
    kinds: ['case_result', 'category_observation'],
    prompt: `${COMMON_PROMPT} You are the Regression Test agent: protect against escaped defects. Every proposal cites the escaped defect or risk it guards (defect:<id> or risk:<area>). Flaky is not a pass.`,
  },
  release_readiness: {
    agent: 'release_readiness',
    kinds: ['gate_summary', 'exception_request'],
    prompt: `${COMMON_PROMPT} You are the Release / Production Readiness agent. You summarise the stored gates and readiness (gate_summary) and you may REQUEST a time-boxed exception (exception_request) with risk, reason, mitigation and owner in detail. You never approve a candidate, an exception or a deployment, and never say one is approved.`,
  },
};

/** Words that assert something was approved, signed off or released. A release_readiness summary may not carry them. */
const APPROVAL_WORDS = /\b(approve[sd]?|approval granted|signed off|sign[- ]off given|cleared for (release|production)|go[- ]live (is )?(approved|granted)|deploy(ed|ing now)|released to production)\b/i;
/** Universal-threshold language: a performance finding measures against the PROJECT's target, never "what is normal". */
const UNIVERSAL_THRESHOLD = /(industry[- ]standard|best[- ]practice|rule of thumb|generally accepted|google (recommends|says)|web vitals? (threshold|standard)|standard threshold|typical(ly)? (under|below|less than)|universal(ly)? (threshold|standard))/i;
/** Raw exploit shapes: a security finding never carries them, in any field. Mirrors the database door. */
const EXPLOIT_SHAPES = /(<script|union\s+select|\bor\s+1\s*=\s*1|\.\.\/\.\.\/|;\s*drop\s+table|\$\{jndi:|javascript:|onerror\s*=|curl\s+-[a-z]*\s+.*(-d|--data)|' or '|%27%20or)/i;
const FLAKY = /\b(flaky|flakiness|intermittent(ly)?|passed on retry|passed after (a )?retry)\b/i;
const PRODUCTION_ENV = /^(prod|production|live)\b/i;

export type FindingsCheck = { ok: true; findings: ProposedFinding[] } | { ok: false; reason: string };
const refuse = (reason: string): FindingsCheck => ({ ok: false, reason });

const textOf = (p: ProposedFinding) => [p.reason, p.detail ?? '', p.environment ?? '', ...p.evidenceRefs].join('\n');

/**
 * The answer against the facts the workflow read. REFUSED, never repaired: one bad proposal refuses the whole answer, because a model that is wrong
 * about one case is not trusted about the rest. Nothing here records anything.
 */
export function checkQaFindings(agent: QaSpecialistAgent, answer: QaFindingsAnswer, facts: QaFacts): FindingsCheck {
  const profile = AGENT_PROFILES[agent];
  const allowed = new Set(allowedEvidenceRefs(facts));
  const caseById = new Map(facts.cases.map((c) => [c.id, c]));
  const seen = new Set<string>();

  for (const p of answer.findings) {
    const where = p.caseId ? `case ${p.caseId}` : p.kind;
    if (!profile.kinds.includes(p.kind)) return refuse(`${agent} may not propose a ${p.kind}`);
    if (containsSecretValue(textOf(p))) return refuse('a proposal carries a secret value: name the variable, never its value');
    if ((p.kind === 'case_result') !== (p.caseId !== null)) return refuse(`${where}: a case_result names a case and nothing else does`);
    if ((p.kind === 'case_result' || p.kind === 'category_observation') !== (p.result !== null)) return refuse(`${where}: only case results and category observations carry a result`);
    const dup = `${p.kind}:${p.caseId ?? p.reason}`;
    if (seen.has(dup)) return refuse(`${where}: proposed twice`);
    seen.add(dup);

    const c = p.caseId ? caseById.get(p.caseId) : undefined;
    if (p.kind === 'case_result' && !c) return refuse(`${where}: that case was not in the facts for this job`);
    const unseen = p.evidenceRefs.find((r) => !allowed.has(r));
    if (unseen) return refuse(`${where}: it cites evidence that was not in the facts ("${unseen}")`);

    // the shared rules (the database door refuses each again)
    if (p.result === 'pass') {
      if (p.evidenceRefs.length === 0) return refuse(`${where}: a pass needs at least one evidence reference`);
      if (c?.priority === 'critical') return refuse(`${where}: a pass on a critical case is recorded by a person, never proposed`);
    }
    if (facts.jobStatus === 'held' && (p.result === 'pass' || p.result === 'fail')) return refuse(`${where}: the job is held, so it did not run: only blocked or not_tested`);
    if (p.result === 'pass' || p.result === 'fail') {
      const needsEnv = ENVIRONMENT_CATEGORIES.has(facts.category);
      if (needsEnv && !p.environment) return refuse(`${where}: a ${facts.category} result names the environment it ran in`);
      if (p.environment && !facts.environments.includes(p.environment)) return refuse(`${where}: "${p.environment}" is not an environment the plan lists, so no result may be claimed for it`);
    }

    // per agent
    switch (agent) {
      case 'api_integration_test': {
        const weak = p.result === 'pass' ? p.evidenceRefs.filter((r) => r.startsWith('integration:')).find((r) => {
          const i = facts.integrations.find((x) => `integration:${x.name}` === r);
          return !i || i.health !== 'verified' || i.isMock;
        }) : undefined;
        if (weak) return refuse(`${where}: ${weak} is configured, degraded or a mock - that is not a verified integration and cannot support a pass`);
        break;
      }
      case 'database_test':
        if (p.environment && PRODUCTION_ENV.test(p.environment)) return refuse(`${where}: database tests never name production as their environment`);
        break;
      case 'security_test':
        if (p.detail !== null) return refuse(`${where}: a security finding carries no detail field; the evidence it references holds the specifics`);
        if (EXPLOIT_SHAPES.test(textOf(p))) return refuse(`${where}: a security finding names the weakness and the fix, never the exploit`);
        break;
      case 'performance_test': {
        if (UNIVERSAL_THRESHOLD.test(textOf(p))) return refuse(`${where}: performance is measured against the project's own targets, never a universal threshold`);
        if (p.result === 'pass' || p.result === 'fail') {
          if (facts.budgets.length === 0) return refuse(`${where}: the project has no performance target, so no pass or fail can be proposed (not_tested)`);
          if (!p.evidenceRefs.some((r) => r.startsWith('budget:'))) return refuse(`${where}: a performance result cites the project's own target (budget:<metric>)`);
        }
        break;
      }
      case 'compatibility_test': {
        if (p.result === 'pass' || p.result === 'fail') {
          const device = facts.devices.find((d) => d.name === p.environment);
          if (device && device.status !== 'supported') return refuse(`${where}: ${device.name} is ${device.status}; an unavailable target is blocked, never a pass`);
        }
        break;
      }
      case 'regression_test': {
        const targets = [...p.evidenceRefs, ...(p.reason.match(/(defect:[\w-]+|risk:[^\s,;]+)/g) ?? [])].filter((r) => facts.escaped.some((e) => e.ref === r));
        if (targets.length === 0) return refuse(`${where}: a regression proposal targets an escaped defect or risk from the facts (defect:<id> or risk:<area>)`);
        if (p.result === 'pass' && FLAKY.test(textOf(p))) return refuse(`${where}: flaky is not a pass`);
        break;
      }
      case 'release_readiness':
        if (APPROVAL_WORDS.test(textOf(p))) return refuse(`${where}: release_readiness proposes summaries and exception requests; it never approves or releases anything`);
        if (p.kind === 'gate_summary' && !p.evidenceRefs.some((r) => r.startsWith('gate:'))) return refuse(`${where}: a gate summary cites the stored gates it summarises (gate:<name>)`);
        if (p.kind === 'exception_request' && (p.detail === null || !/risk/i.test(p.detail) || !/mitigat/i.test(p.detail))) return refuse(`${where}: an exception request states the risk and the mitigation in detail`);
        break;
      default:
        break;
    }
  }
  return { ok: true, findings: answer.findings };
}

/** The arguments `qa.record_specialist_finding` takes for one proposal (the workflow adds the request, the organization and the agent). */
export function doorArgsFor(p: ProposedFinding, commit: string): Record<string, unknown> {
  return {
    p_kind: p.kind,
    p_case_id: p.caseId,
    p_proposed_result: p.result,
    p_reason: p.reason,
    p_detail: p.detail,
    p_evidence_refs: p.evidenceRefs,
    p_commit_ref: commit,
    p_claimed_environment: p.environment,
  };
}

/** The words a person reads for a door outcome (the actions and the panel share them). */
export const SPECIALIST_OUTCOME_WORDS: Record<string, string> = {
  requested: 'Asked. The specialist\'s proposals will appear below for a person to accept or reject.',
  accepted: 'Accepted.',
  rejected: 'Rejected. A rejection is final.',
  not_authorized: 'You do not have permission to do this.',
  not_found: 'That record was not found.',
  job_cancelled: 'That QA job was cancelled.',
  candidate_not_current: 'That release candidate is no longer current.',
  name_one_subject: 'Name one job or one candidate.',
  self_acceptance: 'You asked for this run, so someone else must decide on what it proposed.',
  already_decided: 'That proposal has already been decided.',
  stale_finding: 'That proposal is about a commit the plan no longer names.',
  refused_by_result_door: 'The result door refused to record it (see the reason below); nothing was decided.',
  reason_required: 'Say why.',
};
