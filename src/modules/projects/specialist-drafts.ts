import { z } from 'zod';

/**
 * What the Documentation and Test Automation agents may PROPOSE (P514, P10): pure, so the workflows and their tests share one definition.
 *
 * Both agents produce DRAFTS. A documentation draft is a technical document that is never `implemented` and carries no evidence of its own; a test
 * case draft is a proposal that is never a run, a result or a report. Every claim a documentation draft makes must cite a fact the workflow itself
 * read from the database (an integration's health, a document's status, a test suite's last run, the current commit): a model cannot document what
 * it was not shown, and it cannot upgrade a connection that is only configured, degraded or a mock into something that works.
 */

/** A secret VALUE (a named variable is fine). The same patterns as the database guard on technical documents. */
const SECRET_ASSIGNMENT = /(api[_-]?key|secret|token|passwd|password|authorization|bearer)["' ]*[:=]\s*["']?[A-Za-z0-9_\-.]{12,}/i;
const SECRET_SHAPES = /(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/;
export function containsSecretValue(text: string): boolean {
  return SECRET_ASSIGNMENT.test(text) || SECRET_SHAPES.test(text);
}

// ═══ documentation ═══════════════════════════════════════════════════════

/** The kinds an agent may draft. `integration`, `build_run` and `test` are DERIVED from rows by the database and are not the agent's to write. */
export const DOCUMENTATION_DRAFT_KINDS = ['architecture', 'api', 'database', 'handoff', 'known_limitations', 'other'] as const;

export type DocumentationFacts = {
  projectName: string;
  commit: string | null;
  integrations: { name: string; kind: string; health: string; isMock: boolean }[];
  documents: { kind: string; title: string; status: string }[];
  testSuites: { suite: string; passed: number; failed: number }[];
  openDefects: number;
};

/** The evidence references a claim may cite: every one names something in `facts`, so a claim can be checked against what the model was shown. */
export function evidenceRefsOf(facts: DocumentationFacts): string[] {
  return [
    ...(facts.commit ? [`commit:${facts.commit}`] : []),
    ...facts.integrations.map((i) => `integration:${i.name}`),
    ...facts.documents.map((d) => `document:${d.title}`),
    ...facts.testSuites.map((t) => `tests:${t.suite}`),
    'defects:open',
  ];
}

export function renderDocumentationFacts(facts: DocumentationFacts): string {
  return [
    `Project: ${facts.projectName}`,
    `Current build commit: ${facts.commit ?? 'none recorded'}`,
    'Integrations (evidence ref -> health):',
    ...(facts.integrations.length ? facts.integrations.map((i) => `- integration:${i.name} -> ${i.health}${i.isMock ? ' (mock only)' : ''} [${i.kind}]`) : ['- none']),
    'Existing documents (evidence ref -> status):',
    ...(facts.documents.length ? facts.documents.map((d) => `- document:${d.title} -> ${d.status} [${d.kind}]`) : ['- none']),
    'Latest test run per suite:',
    ...(facts.testSuites.length ? facts.testSuites.map((t) => `- tests:${t.suite} -> ${t.passed} passed, ${t.failed} failed`) : ['- none']),
    `defects:open -> ${facts.openDefects} defects not yet verified fixed`,
  ].join('\n');
}

export const documentationDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(DOCUMENTATION_DRAFT_KINDS),
    sections: z
      .array(
        z
          .object({
            heading: z.string().trim().min(1).max(200),
            claims: z
              .array(
                z
                  .object({
                    statement: z.string().trim().min(1).max(800),
                    evidenceRef: z.string().trim().min(1).max(300),
                  })
                  .strict(),
              )
              .min(1)
              .max(30),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

export type DocumentationDraft = z.infer<typeof documentationDraftSchema>;

export function documentationDraftJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short document title, at most 200 characters.' },
      kind: { type: 'string', enum: [...DOCUMENTATION_DRAFT_KINDS] },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            claims: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  statement: { type: 'string', description: 'One thing that EXISTS, in a sentence.' },
                  evidenceRef: { type: 'string', description: 'Exactly one evidence reference from the facts you were given.' },
                },
                required: ['statement', 'evidenceRef'],
                additionalProperties: false,
              },
            },
          },
          required: ['heading', 'claims'],
          additionalProperties: false,
        },
      },
    },
    required: ['title', 'kind', 'sections'],
    additionalProperties: false,
  };
}

/** Words that assert a thing works. Cited against a connection that is not verified (or is a mock), they are a claim the evidence does not support. */
const WORKS = /\b(verified|implemented|working|works|live|operational|complete|completed|done|production[- ]ready|integrated)\b/i;

export type DraftCheck = { ok: true; body: string } | { ok: false; reason: string };

/**
 * The draft against the facts. Refused, never repaired: a claim citing evidence the model was not shown, a claim that a connection which is not
 * verified (or is only a mock) works, or any secret value. What survives is rendered as a body whose every line names its evidence.
 */
export function checkDocumentationDraft(draft: DocumentationDraft, facts: DocumentationFacts): DraftCheck {
  const allowed = new Set(evidenceRefsOf(facts));
  const unhealthy = new Map(facts.integrations.filter((i) => i.health !== 'verified' || i.isMock).map((i) => [`integration:${i.name}`, i.health]));
  const lines: string[] = [];
  for (const section of draft.sections) {
    lines.push(`## ${section.heading}`);
    for (const claim of section.claims) {
      if (!allowed.has(claim.evidenceRef)) return { ok: false, reason: `a claim cites evidence that was not given: ${claim.evidenceRef}` };
      const health = unhealthy.get(claim.evidenceRef);
      if (health !== undefined && WORKS.test(claim.statement)) {
        return { ok: false, reason: `a claim says ${claim.evidenceRef} works but it is ${health}: a connection that is not verified is not documented as working` };
      }
      lines.push(`- ${claim.statement} (evidence: ${claim.evidenceRef})`);
    }
  }
  const body = lines.join('\n');
  if (containsSecretValue(body) || containsSecretValue(draft.title)) return { ok: false, reason: 'the draft carries a secret value: name the variable, never its value' };
  return { ok: true, body };
}

export const DOCUMENTATION_PROMPT = [
  'You draft technical documentation for a software project from FACTS you are given. You document what EXISTS, never what is planned.',
  'Every statement must cite exactly one evidence reference copied from the facts (for example integration:WhatsApp, tests:functional, commit:abc1234, defects:open).',
  'A statement about an integration must not say it works, is live or is verified unless its health in the facts is verified; a configured, degraded, blocked or mock integration is described as exactly that.',
  'Never invent endpoints, tables, files, dates or names that are not in the facts. Never write a secret value: name the variable, never its value.',
  'Choose the kind that fits: architecture, api, database, handoff, known_limitations or other. Your output is a draft that a person reviews.',
].join(' ');

// ═══ test automation ═════════════════════════════════════════════════════

export const TEST_CASE_LAYERS = ['unit', 'component', 'api', 'database', 'integration', 'e2e', 'ui', 'security', 'performance', 'other'] as const;

export const testCaseDraftsSchema = z
  .object({
    cases: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            layer: z.enum(TEST_CASE_LAYERS),
            description: z.string().trim().min(1).max(2000),
            steps: z.array(z.string().trim().min(1).max(300)).max(30),
            expected: z.string().trim().min(1).max(1000),
            coversCriterion: z.string().trim().max(1000).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .refine((v) => new Set(v.cases.map((c) => c.name.toLowerCase())).size === v.cases.length, { message: 'two proposed test cases share a name', path: ['cases'] })
  .refine((v) => !v.cases.some((c) => containsSecretValue([c.name, c.description, c.expected, ...c.steps].join('\n'))), {
    message: 'a proposed test case carries a secret value',
    path: ['cases'],
  });

export type TestCaseDrafts = z.infer<typeof testCaseDraftsSchema>;

export function testCaseDraftsJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      cases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A unique short name, at most 200 characters.' },
            layer: { type: 'string', enum: [...TEST_CASE_LAYERS] },
            description: { type: 'string', description: 'What the test checks and why, at most 2000 characters.' },
            steps: { type: 'array', items: { type: 'string' }, description: 'The steps, at most 30.' },
            expected: { type: 'string', description: 'The observable result that means PASS, at most 1000 characters.' },
            coversCriterion: { type: ['string', 'null'], description: 'The part of the acceptance criteria this case covers, copied from the task.' },
          },
          required: ['name', 'layer', 'description', 'steps', 'expected'],
          additionalProperties: false,
        },
      },
    },
    required: ['cases'],
    additionalProperties: false,
  };
}

export const TEST_CASE_PROMPT = [
  'You propose automated test cases for ONE development task, from its title, description and acceptance criteria.',
  'Every case must check an observable behaviour named by the acceptance criteria; copy the criterion it covers. Propose at most 12 cases and give each a unique name.',
  'Include the failure and boundary behaviour the criteria imply, not only the happy path. Choose the layer that can see the behaviour.',
  'You only PROPOSE: you do not run anything and you never say a test passed, failed or is covered. Never write a secret value into a case.',
].join(' ');

export function renderTaskBrief(task: { title: string; description: string | null; acceptanceCriteria: string | null }, existingNames: readonly string[]): string {
  return [
    `Task: ${task.title}`,
    `Description: ${task.description?.trim() || 'none'}`,
    `Acceptance criteria: ${task.acceptanceCriteria?.trim() || 'none'}`,
    existingNames.length ? `Already proposed (do not repeat): ${existingNames.join('; ')}` : 'Already proposed: nothing',
  ].join('\n');
}
