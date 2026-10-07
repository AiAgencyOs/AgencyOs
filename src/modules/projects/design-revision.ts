import { z } from 'zod';

import { decoderSafeSchema } from '@/lib/ai/schema';

/**
 * P3-UID-015 / P3-PM-014. The Phase 3 designer's ANSWER to a revision round.
 *
 * `projects.open_design_revision` (client origin) and `projects.open_internal_design_revision` (Admin EDIT / internal changes_required) record WHAT WAS
 * ASKED. This module is the other half: read the open revision, show the designer the earlier direction and the words that asked for the change, validate
 * what comes back and write it through `projects.deliver_design_revision`, which creates a NEW version and restarts every gate.
 *
 * The model call is injected (`ask`), so the order of events, the refusals and the writes are provable against a stand-in without a funded model.
 * It draws nothing and claims nothing in Figma: a revised direction arrives with `figma_node_id` null, exactly as the first one did.
 */

export const designRevisionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    directionSummary: z.string().trim().min(20).max(2000),
    metadata: z.record(z.string(), z.string().trim().max(300)).optional(),
  })
  .strict();

export type DesignRevisionAnswer = z.infer<typeof designRevisionSchema>;

export function designRevisionJsonSchema(): Record<string, unknown> {
  return decoderSafeSchema(z.toJSONSchema(designRevisionSchema)) as Record<string, unknown>;
}

export const DESIGN_REVISION_PROMPT = [
  'You revise ONE visual direction for a product, and nothing else.',
  'You are given the direction as it stands and the exact words of the person who asked for a change.',
  'Change what they asked to change and keep everything they did not mention.',
  'Return the direction under a short name and a summary a non-designer can judge.',
  'Do not add screens, features or functionality, do not widen the scope, and do not claim any of this exists in Figma.',
  'You are not choosing or approving: a person reviews the revised direction first, then an Admin, and only then the client.',
].join(' ');

type Row = Record<string, unknown>;
type Answer<T> = PromiseLike<{ data: T; error: { message: string } | null }>;
type Query = Answer<Row[] | null> & {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  order(column: string, options?: { ascending: boolean }): Query;
  limit(n: number): Query;
  maybeSingle(): Answer<Row | null>;
};
export type RevisionAdmin = {
  schema(name: string): { from(table: string): Query; rpc(fn: string, args: Record<string, unknown>): Answer<unknown> };
};

export type ReviseOutcome =
  | { status: 'delivered'; themeOptionId: string }
  | { status: 'already_delivered'; themeOptionId: string | null }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const firstOutcome = (data: unknown): { outcome?: string; revision_id?: string | null; theme_option_id?: string | null } | undefined =>
  (Array.isArray(data) ? data[0] : data) as { outcome?: string; revision_id?: string | null; theme_option_id?: string | null } | undefined;

/**
 * An Admin EDIT or an internal changes_required arrives as an event about a THEME OPTION; a client revision arrives as an event about the revision. Either
 * way the open revision is found (internal ones are opened here, through the door) before any model is asked, and a replay finds the same one.
 */
export async function resolveRevisionId(
  admin: RevisionAdmin,
  input: { organizationId: string; eventType: string; subjectId: string },
): Promise<{ revisionId: string } | { skip: string }> {
  const projects = admin.schema('projects');
  if (input.eventType === 'project.design_revision_opened') {
    const { data, error } = await projects.from('design_revisions').select('id, origin, status').eq('id', input.subjectId).eq('organization_id', input.organizationId).maybeSingle();
    if (error) return { skip: `could not read the revision: ${error.message}` };
    if (!data) return { skip: 'the revision no longer exists' };
    // internal/admin rounds are opened and answered in one job (below); only a client round is answered from its own event
    if (data.origin !== 'client_revision') return { skip: `a ${String(data.origin)} round is answered from the event that opened it` };
    return { revisionId: String(data.id) };
  }
  if (input.eventType === 'project.admin_design_edit_requested' || input.eventType === 'project.internal_design_changes_required') {
    const { data: opt, error: optErr } = await projects.from('theme_options').select('id').eq('id', input.subjectId).eq('organization_id', input.organizationId).maybeSingle();
    if (optErr) return { skip: `could not read the option: ${optErr.message}` };
    if (!opt) return { skip: 'the option no longer exists' };
    const { data, error } = await projects.rpc('open_internal_design_revision', { p_theme_option_id: input.subjectId });
    if (error) return { skip: `could not open the revision: ${error.message}` };
    const row = firstOutcome(data);
    if ((row?.outcome === 'opened' || row?.outcome === 'exists') && row.revision_id) return { revisionId: row.revision_id };
    return { skip: `no revision to answer (${row?.outcome ?? 'no answer'})` };
  }
  return { skip: `${input.eventType} is not a revision event` };
}

export async function reviseDesignDirection(
  admin: RevisionAdmin,
  input: { organizationId: string; revisionId: string },
  ask: (userPrompt: string, subject: { projectId: string }) => Promise<{ ok: true; json: unknown } | { ok: false; detail: string }>,
): Promise<ReviseOutcome> {
  const projects = admin.schema('projects');
  const { data: rev, error: revErr } = await projects
    .from('design_revisions')
    .select('id, project_id, status, origin, requested_changes, from_theme_option_id, to_theme_option_id')
    .eq('id', input.revisionId)
    .eq('organization_id', input.organizationId)
    .maybeSingle();
  if (revErr) return { status: 'failed', reason: `could not read the revision: ${revErr.message}` };
  if (!rev) return { status: 'skipped', reason: 'the revision no longer exists' };
  if (rev.status === 'delivered') return { status: 'already_delivered', themeOptionId: asString(rev.to_theme_option_id) };
  if (rev.status !== 'open' && rev.status !== 'in_progress') return { status: 'skipped', reason: `the revision is ${String(rev.status)}` };

  const { data: from, error: fromErr } = await projects
    .from('theme_options')
    .select('id, name, direction_summary, direction_metadata, version, client_status')
    .eq('id', String(rev.from_theme_option_id))
    .eq('organization_id', input.organizationId)
    .maybeSingle();
  if (fromErr) return { status: 'failed', reason: `could not read the earlier direction: ${fromErr.message}` };
  if (!from) return { status: 'skipped', reason: 'the earlier direction no longer exists' };
  if (from.client_status === 'locked') return { status: 'skipped', reason: 'the direction is locked' };

  const dimensions =
    from.direction_metadata && Object.keys(from.direction_metadata as object).length > 0 ? [`Its dimensions: ${JSON.stringify(from.direction_metadata)}`] : [];
  const prompt = [
    `The direction as it stands (version ${String(from.version)}): ${String(from.name)}`,
    String(from.direction_summary),
    ...dimensions,
    '',
    `What was asked to change (${String(rev.origin)}):`,
    String(rev.requested_changes),
  ].join('\n');

  const answer = await ask(prompt, { projectId: String(rev.project_id) });
  if (!answer.ok) return { status: 'failed', reason: answer.detail };
  const validated = designRevisionSchema.safeParse(answer.json);
  if (!validated.success) return { status: 'failed', reason: `the revision did not match its schema: ${validated.error.issues[0]?.message ?? 'unparseable'}` };

  const { data: delivered, error: deliverErr } = await projects.rpc('deliver_design_revision', {
    p_revision_id: input.revisionId,
    p_name: validated.data.name,
    p_direction_summary: validated.data.directionSummary,
    p_metadata: (validated.data.metadata ?? {}) as unknown,
  });
  if (deliverErr) return { status: 'failed', reason: `deliver_design_revision: ${deliverErr.message}` };
  const row = firstOutcome(delivered);
  if (row?.outcome === 'delivered' && row.theme_option_id) return { status: 'delivered', themeOptionId: row.theme_option_id };
  if (row?.outcome === 'already_delivered') return { status: 'already_delivered', themeOptionId: row.theme_option_id ?? null };
  // phase_stopped / option_locked / cancelled are the door holding a rule the model must not talk its way past
  return { status: 'skipped', reason: `the door answered ${row?.outcome ?? 'nothing'}` };
}
