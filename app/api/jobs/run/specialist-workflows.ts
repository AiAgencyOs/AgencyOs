import type { Json } from '@/lib/db/types';
import {
  DOCUMENTATION_PROMPT,
  TEST_CASE_PROMPT,
  checkDocumentationDraft,
  documentationDraftJsonSchema,
  documentationDraftSchema,
  renderDocumentationFacts,
  renderTaskBrief,
  testCaseDraftsJsonSchema,
  testCaseDraftsSchema,
  type DocumentationFacts,
} from '@/modules/projects/specialist-drafts';

import { callModel, failJob, finishRun, openRun, settledSucceeded, succeedRun, type AgentContext } from './agent-run';
import type { AgentWorkflow } from './workflows';

/**
 * Phase 5 specialist workflows: the Documentation agent (P514) and the Test Automation agent (P10).
 *
 * UNPROVEN AGAINST A REAL MODEL. They are proven against a stand-in model and a stand-in database (tests/specialist-workflows.test.ts); no real
 * model has run them. What is proved is the order, the refusals and where they write.
 *
 * Both only DRAFT. Each reads its input rows for the JOB's organization (the payload names which row, never which tenant), asks the model for JSON,
 * validates it strictly before anything is written, and writes through ONE service-only door:
 *   - documentation: `record_documentation_draft` - a technical document that is always partial, never implemented, never an overwrite;
 *   - test automation: `record_test_case_draft` - a proposed case in `test_case_drafts`. It never ingests a report and never creates a run or a
 *     result, so a proposal cannot count as evidence of anything.
 * Neither is subscribed to an event: nothing in the event catalog says "a task is ready to be tested" or "documents are due" in a form that would
 * not also fire for work these agents were not asked to do, so an Admin asks for each (specialist-actions.ts).
 */

type Row = Record<string, unknown>;
type Answer = { data: Row[] | null; error: { message: string } | null };
type Query = PromiseLike<Answer> & {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  in(column: string, values: unknown[]): Query;
  is(column: string, value: null): Query;
  order(column: string, options?: { ascending: boolean }): Query;
  limit(n: number): Query;
  maybeSingle(): PromiseLike<{ data: Row | null; error: { message: string } | null }>;
};
type Loose = { schema(name: string): { from(table: string): Query; rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> } };
const loose = (ctx: AgentContext): Loose => ctx.admin as unknown as Loose;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const door = (data: unknown): string => String(((Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined)?.outcome ?? 'no answer');

async function settle(ctx: AgentContext): Promise<void> {
  await ctx.admin.schema('core').from('jobs').update(settledSucceeded).eq('id', ctx.job.id);
}

// ═══ documentation ═══════════════════════════════════════════════════════

const DOCUMENTATION_DRAFT: AgentWorkflow = {
  jobKind: 'documentation.draft',
  agentKey: 'documentation',
  workClass: 'draft',
  systemPrompt: DOCUMENTATION_PROMPT,
  schemaName: 'DocumentationDraft',
  jsonSchema: documentationDraftJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const projectId = str(job.payload?.projectId) ?? str(job.payload?.subjectId);
    if (!projectId) {
      await failJob(admin, job, 'job payload has no projectId');
      return { status: 'failed', reason: 'bad payload' };
    }
    const db = loose(ctx).schema('projects');
    const qa = loose(ctx).schema('qa');
    const org = job.organization_id;

    // every read is for THIS job's organization; a failed read fails the job rather than documenting from a partial picture
    const project = await db.from('projects').select('id, name').eq('id', projectId).eq('organization_id', org).is('deleted_at', null).maybeSingle();
    if (project.error) {
      await failJob(admin, job, `could not read the project: ${project.error.message}`);
      return { status: 'failed', reason: project.error.message };
    }
    if (!project.data) {
      await settle(ctx);
      return { status: 'succeeded', outcome: 'gone', reason: 'the project no longer exists' };
    }
    const [integrations, documents, runs, defects, builds] = await Promise.all([
      db.from('integration_connections').select('name, kind, health, is_mock').eq('project_id', projectId).eq('organization_id', org),
      db.from('technical_documents').select('kind, title, status').eq('project_id', projectId).eq('organization_id', org),
      qa.from('test_runs').select('suite, passed, failed, executed_at').eq('project_id', projectId).eq('organization_id', org).order('executed_at', { ascending: false }).limit(50),
      qa.from('defects').select('id').eq('project_id', projectId).eq('organization_id', org).in('status', ['open', 'fixed', 'needs_evidence', 'not_reproduced']),
      db.from('deliverables').select('id, version').eq('project_id', projectId).eq('organization_id', org).eq('kind', 'build').order('version', { ascending: false }).limit(5),
    ]);
    const failed = [integrations, documents, runs, defects, builds].find((r) => r.error);
    if (failed?.error) {
      await failJob(admin, job, `could not read the project's records: ${failed.error.message}`);
      return { status: 'failed', reason: failed.error.message };
    }
    // the newest build that is not superseded names the commit the documents describe
    let commit: string | null = null;
    for (const b of builds.data ?? []) {
      const id = str(b.id);
      if (!id) continue;
      const detail = await db.from('deliverable_details').select('commit_ref').eq('deliverable_id', id).eq('organization_id', org).maybeSingle();
      if (detail.error) {
        await failJob(admin, job, `could not read the build's commit: ${detail.error.message}`);
        return { status: 'failed', reason: detail.error.message };
      }
      commit = str(detail.data?.commit_ref);
      break;
    }
    const latest = new Map<string, { suite: string; passed: number; failed: number }>();
    for (const r of runs.data ?? []) {
      const suite = str(r.suite);
      if (suite && !latest.has(suite)) latest.set(suite, { suite, passed: Number(r.passed ?? 0), failed: Number(r.failed ?? 0) });
    }
    const facts: DocumentationFacts = {
      projectName: str(project.data.name) ?? 'project',
      commit,
      integrations: (integrations.data ?? []).map((i) => ({ name: String(i.name), kind: String(i.kind), health: String(i.health), isMock: i.is_mock === true })),
      documents: (documents.data ?? []).map((d) => ({ kind: String(d.kind), title: String(d.title), status: String(d.status) })),
      testSuites: [...latest.values()],
      openDefects: (defects.data ?? []).length,
    };

    const runId = await openRun(ctx, { type: 'projects.documentation', id: projectId, input: { projectId } as unknown as Json });
    const call = await callModel(ctx, this, [{ role: 'user', content: renderDocumentationFacts(facts) }], runId);
    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failJob(admin, job, call.detail);
      return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
    }

    // strict, before anything is written: the shape, then every claim against the facts it was given
    const parsed = documentationDraftSchema.safeParse(call.json);
    const checked = parsed.success ? checkDocumentationDraft(parsed.data, facts) : null;
    if (!parsed.success || (checked && !checked.ok)) {
      const detail = `the model's answer was refused: ${!parsed.success ? (parsed.error.issues[0]?.message ?? 'unparseable') : checked && !checked.ok ? checked.reason : 'unchecked'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }
    if (!checked || !checked.ok) return { status: 'failed', reason: 'unchecked', runId };

    const { data, error } = await db.rpc('record_documentation_draft', { p_project_id: projectId, p_kind: parsed.data.kind, p_title: parsed.data.title, p_body: checked.body });
    if (error) {
      await finishRun(admin, runId, 'failed', error.message, call.stepCount);
      await failJob(admin, job, `the door did not answer: ${error.message}`);
      return { status: 'failed', reason: error.message, runId };
    }
    const outcome = door(data);
    // 'exists' is a good answer: a document with this title is already there and is not overwritten
    if (outcome !== 'recorded' && outcome !== 'exists') {
      await finishRun(admin, runId, 'failed', `the door answered ${outcome}`, call.stepCount);
      await failJob(admin, job, `the door answered ${outcome}`);
      return { status: 'failed', reason: `the door answered ${outcome}`, runId };
    }
    await succeedRun(admin, runId, parsed.data as unknown as Json, call.usage, call.stepCount);
    await settle(ctx);
    return { status: 'succeeded', reason: outcome, runId, title: parsed.data.title };
  },
};

// ═══ test automation ═════════════════════════════════════════════════════

const TEST_AUTOMATION_PROPOSE: AgentWorkflow = {
  jobKind: 'test_automation.propose_cases',
  agentKey: 'test_automation',
  workClass: 'draft',
  systemPrompt: TEST_CASE_PROMPT,
  schemaName: 'TestCaseDrafts',
  jsonSchema: testCaseDraftsJsonSchema,

  async run(ctx) {
    const { admin, job } = ctx;
    const taskId = str(job.payload?.taskId) ?? str(job.payload?.subjectId);
    if (!taskId) {
      await failJob(admin, job, 'job payload has no taskId');
      return { status: 'failed', reason: 'bad payload' };
    }
    const db = loose(ctx).schema('projects');
    const org = job.organization_id;

    const task = await db.from('tasks').select('id, project_id, title, description, acceptance_criteria, status').eq('id', taskId).eq('organization_id', org).maybeSingle();
    if (task.error) {
      await failJob(admin, job, `could not read the task: ${task.error.message}`);
      return { status: 'failed', reason: task.error.message };
    }
    if (!task.data || task.data.status === 'cancelled') {
      await settle(ctx);
      return { status: 'succeeded', outcome: 'gone', reason: 'the task no longer exists or was cancelled' };
    }
    const existing = await db.from('test_case_drafts').select('name').eq('task_id', taskId).eq('organization_id', org);
    if (existing.error) {
      await failJob(admin, job, `could not read the existing drafts: ${existing.error.message}`);
      return { status: 'failed', reason: existing.error.message };
    }
    const projectId = str(task.data.project_id) ?? '';
    const brief = renderTaskBrief(
      { title: String(task.data.title ?? ''), description: str(task.data.description), acceptanceCriteria: str(task.data.acceptance_criteria) },
      (existing.data ?? []).map((d) => String(d.name)),
    );

    const runId = await openRun(ctx, { type: 'projects.test_cases', id: taskId, input: { taskId, projectId } as unknown as Json });
    const call = await callModel(ctx, this, [{ role: 'user', content: brief }], runId);
    if (!call.ok) {
      await finishRun(admin, runId, 'failed', call.detail, call.stepCount);
      await failJob(admin, job, call.detail);
      return { status: 'failed', reason: call.kind === 'no_provider' ? 'AI_PROVIDER_NOT_CONFIGURED' : 'provider error', detail: call.detail, runId };
    }

    const parsed = testCaseDraftsSchema.safeParse(call.json);
    if (!parsed.success) {
      const detail = `the model's answer was refused: ${parsed.error.issues[0]?.message ?? 'unparseable'}`;
      await finishRun(admin, runId, 'failed', detail, call.stepCount, call.usage);
      await failJob(admin, job, detail);
      return { status: 'failed', reason: detail, runId };
    }

    let recorded = 0;
    let already = 0;
    for (const c of parsed.data.cases) {
      const { data, error } = await db.rpc('record_test_case_draft', {
        p_task_id: taskId,
        p_name: c.name,
        p_layer: c.layer,
        p_description: c.description,
        p_steps: c.steps as unknown as Json,
        p_expected: c.expected,
        p_covers: c.coversCriterion ?? null,
        p_run_id: runId,
      });
      if (error) {
        await finishRun(admin, runId, 'failed', error.message, call.stepCount);
        await failJob(admin, job, `the door did not answer: ${error.message}`);
        return { status: 'failed', reason: error.message, runId };
      }
      const outcome = door(data);
      if (outcome === 'recorded') recorded += 1;
      else if (outcome === 'already_drafted') already += 1;
      else {
        await finishRun(admin, runId, 'failed', `the door answered ${outcome}`, call.stepCount);
        await failJob(admin, job, `the door answered ${outcome}`);
        return { status: 'failed', reason: `the door answered ${outcome}`, runId };
      }
    }
    await succeedRun(admin, runId, parsed.data as unknown as Json, call.usage, call.stepCount);
    await settle(ctx);
    return { status: 'succeeded', reason: 'drafted', runId, recorded, alreadyDrafted: already };
  },
};

export const SPECIALIST_WORKFLOWS: readonly AgentWorkflow[] = [DOCUMENTATION_DRAFT, TEST_AUTOMATION_PROPOSE];
