import { z } from 'zod';

import { decoderSafeSchema } from '@/lib/ai/schema';

import { PLAN_PHASES } from './plan-vocabulary';

/**
 * The Project Planning Agent's output, and the rules that make it safe to write
 * — Phase 2 Planning §4, §5, §7, §9, §18.
 *
 * Pure: no database, no model. The workflow (app/api/jobs/run/workflows.ts)
 * loads the context, asks the model, and hands the answer to
 * `assembleBlueprint`, which is where every rule that is not a prompt lives:
 *
 *   • the model can only name scope items by their number in the list it was
 *     shown, so it cannot invent a deliverable for something nobody agreed to
 *     (Planning §4.1: "no deliverable without an approved source");
 *   • every included scope item must be covered, or the answer is refused and
 *     the model is told which ones it missed;
 *   • finance gates are not the model's at all - they are mapped from the
 *     project's payment plan, so the agent cannot decide money (Planning §5);
 *   • a dependency the CLIENT owes is the project manager's to collect, whatever
 *     the model wrote (Planning §4.4: the agent does not talk to the client);
 *   • development-level content - tables, endpoints, code, framework choices,
 *     task breakdowns - is refused (Planning §5, §18): this agent plans how the
 *     PROJECT moves, never how the PRODUCT is built.
 */

export const BLUEPRINT_PHASES = PLAN_PHASES;

/** Who may own a deliverable in the blueprint. The project roles the repository already has. */
export const BLUEPRINT_OWNER_ROLES = ['project_manager', 'designer', 'developer', 'qa', 'delivery_lead'] as const;

/**
 * Dependency kinds the agent may propose. `finance` is absent on purpose: a
 * finance gate is mapped from the payment plan by code, and `human_approval`
 * stays here because an internal sign-off is a planning fact.
 */
export const AGENT_DEPENDENCY_KINDS = [
  'client_information',
  'client_access',
  'client_asset',
  'client_approval',
  'external_service',
  'internal_output',
  'human_approval',
  'other',
] as const;
const CLIENT_KINDS: readonly string[] = ['client_information', 'client_access', 'client_asset', 'client_approval'];

const text = (max: number) => z.string().trim().min(1).max(max);

export const blueprintDraftSchema = z
  .object({
    objective: text(600),
    deliverables: z
      .array(
        z
          .object({
            scopeItem: z.number().int().min(1),
            name: text(200),
            applicablePhase: z.enum(BLUEPRINT_PHASES),
            ownerRole: z.enum(BLUEPRINT_OWNER_ROLES),
            readinessCriteria: text(400),
            evidenceRequired: text(300),
            ambiguityNote: z.string().trim().max(400).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(60),
    dependencies: z
      .array(
        z
          .object({
            kind: z.enum(AGENT_DEPENDENCY_KINDS),
            description: text(300),
            neededByPhase: z.enum(BLUEPRINT_PHASES),
            ownerRole: z.enum(BLUEPRINT_OWNER_ROLES),
          })
          .strict(),
      )
      .max(30),
    milestones: z
      .array(
        z
          .object({
            name: text(200),
            kind: z.enum(['operational', 'client_approval']),
            phase: z.enum(BLUEPRINT_PHASES),
            gateCriteria: text(300),
          })
          .strict(),
      )
      .max(30),
    notes: z
      .array(
        z
          .object({
            kind: z.enum(['risk', 'assumption']),
            statement: text(400),
            ownerRole: z.enum(BLUEPRINT_OWNER_ROLES).nullable(),
          })
          .strict(),
      )
      .max(30),
    clarifications: z
      .array(
        z
          .object({
            scopeItem: z.number().int().min(1),
            question: text(400),
            impact: text(300),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export type BlueprintDraft = z.infer<typeof blueprintDraftSchema>;

export function blueprintDraftJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(blueprintDraftSchema)) as Record<string, unknown>;
}

// ── development-level content ───────────────────────────────────────────────

/**
 * Phrases that mean somebody is designing the PRODUCT. Deliberately phrases,
 * not single words: a client's mobile app may well need "a payment gateway", and
 * "API keys" is a thing the client owes; what the blueprint must never contain
 * is the design of the system itself. Each pattern is one of Planning §5's
 * must-nots made checkable.
 */
const DEVELOPMENT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/```|<\/?[a-z][a-z0-9-]*>/i, 'code or markup'],
  [/\b(create|design|define|add|write)\s+(a\s+|the\s+)?(database\s+)?(table|schema|migration|index|column|model class|orm)\b/i, 'a database design'],
  [/\b(api|rest|graphql|grpc)\s+(endpoint|route|contract|design|schema)s?\b/i, 'an API design'],
  [/\b(implement|code|program|develop)\s+(the\s+|a\s+)?([\w-]+\s+)?(function|method|class|component|endpoint|algorithm|query)\b/i, 'an implementation task'],
  [/\b(unit|integration|e2e|end-to-end)\s+tests?\s+(for|of|covering)\b/i, 'a test plan'],
  [/\b(sql|ddl|orm|crud)\b/i, 'database terms'],
  [/\b(class diagram|sequence diagram|erd|er diagram|wireframe|mockup|figma frames?)\b/i, 'a design artefact'],
  [/\b(architecture|tech stack|technology stack)\s+(decision|choice|selection|diagram|design)\b/i, 'an architecture decision'],
  [/\b(choose|select|use|adopt)\s+(react|angular|vue|django|laravel|spring|rails|flutter|kotlin|swift|node|postgres|mysql|mongodb|redis|kubernetes|docker)\b/i, 'a technology choice'],
];

/** The reason a piece of blueprint text is development-level, or null when it is not. */
export function findDevelopmentContent(value: string): string | null {
  for (const [pattern, reason] of DEVELOPMENT_PATTERNS) if (pattern.test(value)) return reason;
  return null;
}

function everyText(draft: BlueprintDraft): Array<[string, string]> {
  const out: Array<[string, string]> = [['objective', draft.objective]];
  draft.deliverables.forEach((d, i) => {
    out.push([`deliverables[${i}].name`, d.name], [`deliverables[${i}].readinessCriteria`, d.readinessCriteria], [`deliverables[${i}].evidenceRequired`, d.evidenceRequired]);
    if (d.ambiguityNote) out.push([`deliverables[${i}].ambiguityNote`, d.ambiguityNote]);
  });
  draft.dependencies.forEach((d, i) => out.push([`dependencies[${i}].description`, d.description]));
  draft.milestones.forEach((m, i) => out.push([`milestones[${i}].name`, m.name], [`milestones[${i}].gateCriteria`, m.gateCriteria]));
  draft.notes.forEach((n, i) => out.push([`notes[${i}].statement`, n.statement]));
  draft.clarifications.forEach((c, i) => out.push([`clarifications[${i}].question`, c.question], [`clarifications[${i}].impact`, c.impact]));
  return out;
}

// ── assembling what the door takes ──────────────────────────────────────────

export type ScopeItemRef = { id: string; title: string };
export type PaymentMilestoneRef = { id: string; name: string; position: number };

/**
 * Which phase a payment milestone gates, by its ORDINAL in the plan - M1 is the
 * first priced milestone, M2 the second (ADM-105's 30/20/30/20). Never by the
 * stored position number: the installer numbers from 0 and fixtures from 1.
 */
const FINANCE_GATE_PHASE = ['phase_2', 'phase_4', 'phase_5', 'phase_6'] as const;
export function financeGatePhase(ordinal: number): (typeof PLAN_PHASES)[number] {
  return FINANCE_GATE_PHASE[ordinal - 1] ?? 'phase_7';
}

export type AssembleResult =
  | { ok: true; blueprint: Record<string, unknown>; summary: { deliverables: number; dependencies: number; milestones: number; notes: number; clarifications: number; financeGates: number; addedPhaseMilestones: number } }
  | { ok: false; problems: string[] };

/**
 * The model's draft + the project's own facts → the payload the door writes, or
 * the list of things wrong with the draft (which the workflow gives back to the
 * model once). Nothing is guessed: a problem is reported, not repaired - except
 * the three things that are the same answer every time and are not the model's
 * to decide (finance gates, who owns a client dependency, a milestone for a
 * phase that has work in it).
 */
export function assembleBlueprint(
  draft: BlueprintDraft,
  facts: { includedItems: readonly ScopeItemRef[]; paymentMilestones: readonly PaymentMilestoneRef[] },
): AssembleResult {
  const problems: string[] = [];
  const items = facts.includedItems;

  for (const [where, value] of everyText(draft)) {
    const why = findDevelopmentContent(value);
    if (why) problems.push(`${where} contains ${why}. This blueprint plans how the project is run, not how the product is built — say what must be ready and what evidence shows it, nothing about how it is made.`);
  }

  const covered = new Set<number>();
  draft.deliverables.forEach((d, i) => {
    if (d.scopeItem > items.length) problems.push(`deliverables[${i}].scopeItem ${d.scopeItem} is not in the list (1-${items.length}).`);
    else covered.add(d.scopeItem);
  });
  draft.clarifications.forEach((c, i) => {
    if (c.scopeItem > items.length) problems.push(`clarifications[${i}].scopeItem ${c.scopeItem} is not in the list (1-${items.length}).`);
  });
  const missing = items.map((_, i) => i + 1).filter((n) => !covered.has(n));
  if (missing.length > 0) {
    problems.push(`These scope items have no deliverable: ${missing.map((n) => `${n} (${items[n - 1]!.title})`).join('; ')}. Every included item needs one.`);
  }
  if (problems.length > 0) return { ok: false, problems };

  const deliverables = draft.deliverables.map((d) => ({
    name: d.name,
    scopeItemId: items[d.scopeItem - 1]!.id,
    applicablePhase: d.applicablePhase,
    ownerRole: d.ownerRole,
    readinessCriteria: d.readinessCriteria,
    evidenceRequired: d.evidenceRequired,
    ambiguityNote: d.ambiguityNote,
  }));

  const dependencies = draft.dependencies.map((d) => ({
    kind: d.kind,
    description: d.description,
    neededByPhase: d.neededByPhase,
    // Planning §4.4: what the client owes is collected by the project manager.
    ownerRole: CLIENT_KINDS.includes(d.kind) ? 'project_manager' : d.ownerRole,
  }));

  const milestones: Array<Record<string, unknown>> = draft.milestones.map((m) => ({
    name: m.name, kind: m.kind, phase: m.phase, gateCriteria: m.gateCriteria,
  }));

  // Every phase that carries work needs a place in the sequence (§18).
  const phasesWithWork = [...new Set(deliverables.map((d) => d.applicablePhase))];
  const sequenced = new Set(milestones.map((m) => m.phase));
  let addedPhaseMilestones = 0;
  for (const phase of phasesWithWork) {
    if (sequenced.has(phase)) continue;
    milestones.push({
      name: `${phase.replace('_', ' ')} work ready`,
      kind: 'operational',
      phase,
      gateCriteria: 'Every deliverable planned for this phase meets its readiness criteria, with its evidence on file.',
    });
    addedPhaseMilestones += 1;
  }

  // Finance gates, from the payment plan - never the model's.
  [...facts.paymentMilestones].sort((a, b) => a.position - b.position).forEach((pm, index) => {
    milestones.push({
      name: `${pm.name} verified`,
      kind: 'finance_gate',
      phase: financeGatePhase(index + 1),
      gateCriteria: 'The payment is verified by an Admin. A client message or a screenshot is not verification.',
      paymentMilestoneId: pm.id,
    });
  });

  return {
    ok: true,
    blueprint: {
      objective: draft.objective,
      deliverables,
      dependencies,
      milestones,
      notes: draft.notes.map((n) => ({ kind: n.kind, statement: n.statement, ownerRole: n.ownerRole })),
      clarifications: draft.clarifications.map((c) => ({ scopeItemId: items[c.scopeItem - 1]!.id, question: c.question, impact: c.impact })),
    },
    summary: {
      deliverables: deliverables.length,
      dependencies: dependencies.length,
      milestones: milestones.length,
      notes: draft.notes.length,
      clarifications: draft.clarifications.length,
      financeGates: facts.paymentMilestones.length,
      addedPhaseMilestones,
    },
  };
}

// ── what the model is shown ─────────────────────────────────────────────────

export const BLUEPRINT_PROMPT = [
  'You are the Project Planning Agent. You turn an ACCEPTED project scope into an operational project blueprint:',
  'how the project is organised and moves through its phases — not how the product is built.',
  'Phases: phase_2 onboarding and kickoff, phase_3 design direction, phase_4 prototype and design approval,',
  'phase_5 development, phase_6 QA and release readiness, phase_7 handover and closure.',
  'For EVERY included scope item produce at least one deliverable, naming it by its number in the list.',
  'A deliverable says what must be ready (readinessCriteria) and what evidence shows it (evidenceRequired).',
  'List what the CLIENT will need to provide or approve (information, access, assets, approvals) as dependencies, as early as possible,',
  'and anything external or internal that can block a phase. List the real risks and the assumptions you are making.',
  'If something in the scope is genuinely ambiguous, do NOT guess and do NOT add scope: raise a clarification',
  '(a question a project manager could ask the client, and what it affects).',
  'NEVER: design the database, APIs, screens or architecture; choose technologies; write code or tasks for developers;',
  'state a price, a payment term or a delivery date; promise anything; add a feature that is not in the scope.',
  'Payment gates are added for you from the payment plan — do not create finance milestones.',
  'Plain, short sentences. The client may read these.',
].join(' ');

export function renderPlanningContext(input: {
  projectName: string;
  projectType: string | null;
  scopeVersion: number;
  includedItems: ReadonlyArray<{ title: string; detail: string | null; acceptanceCriteria: string | null }>;
  excludedTitles: readonly string[];
  onboarding: ReadonlyArray<{ label: string; status: string }>;
  paymentMilestones: ReadonlyArray<{ name: string; position: number }>;
}): string {
  const lines: string[] = [];
  lines.push(`PROJECT: ${input.projectName}${input.projectType ? ` (${input.projectType})` : ''}`);
  lines.push(`APPROVED SCOPE, version ${input.scopeVersion}. Included items (use these numbers):`);
  input.includedItems.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.title}${it.detail ? ` — ${it.detail}` : ''}${it.acceptanceCriteria ? ` [accepted when: ${it.acceptanceCriteria}]` : ''}`);
  });
  if (input.excludedTitles.length > 0) {
    lines.push(`EXPLICITLY EXCLUDED (not work, do not plan them): ${input.excludedTitles.join('; ')}`);
  }
  if (input.onboarding.length > 0) {
    lines.push('ONBOARDING STATE (do not list as a dependency what is already received or verified):');
    for (const o of input.onboarding) lines.push(`- ${o.label}: ${o.status}`);
  }
  if (input.paymentMilestones.length > 0) {
    lines.push(`PAYMENT MILESTONES (gates are added automatically): ${[...input.paymentMilestones].sort((a, b) => a.position - b.position).map((m) => m.name).join(', ')}`);
  }
  return lines.join('\n');
}
