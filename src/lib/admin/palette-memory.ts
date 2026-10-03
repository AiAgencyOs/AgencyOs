import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { err, ok, unreadable, type Result } from '@/lib/result';

/**
 * What the ⌘K palette remembers — SCR-004 (bucket F, stream F-A; migration
 * 20261001100000 §1–2).
 *
 *   • Recent commands (`core.recent_commands`): the last twenty entries a
 *     person selected — a page, a create, a record. Bumped on reuse, pruned
 *     past twenty by the writer. Personal bookkeeping, not audited.
 *   • Create drafts (`core.create_drafts`): one unfinished Quick Create form
 *     per kind per person, as the form's own fields. Saved when the dialog
 *     closes with something typed, restored when that form opens again,
 *     deleted when the record is created.
 *
 * Both are the person's own under RLS (`*_own` policies); the readers
 * refuse rather than return an empty list on a failed read.
 */

export const RECENT_COMMAND_LIMIT = 20;

export type RecentCommand = { key: string; label: string; href: string | null; lastUsedAt: string; useCount: number };

export async function listRecentCommands(): Promise<RecentCommand[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .from('recent_commands')
    .select('command_key, label, href, last_used_at, use_count')
    .order('last_used_at', { ascending: false })
    .limit(RECENT_COMMAND_LIMIT);
  if (error) unreadable('listRecentCommands', error);
  return (data ?? []).map((r) => ({ key: r.command_key, label: r.label, href: r.href, lastUsedAt: r.last_used_at, useCount: r.use_count }));
}

export const recordCommandSchema = z.object({
  key: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  href: z.string().trim().max(500).nullable().default(null),
});

export async function recordCommand(input: z.input<typeof recordCommandSchema>): Promise<Result<{ recorded: true }>> {
  const parsed = recordCommandSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Nothing to record.');
  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');
  const supabase = await createClient();

  const { data: existing, error: readError } = await supabase
    .schema('core')
    .from('recent_commands')
    .select('id, use_count')
    .eq('user_id', context.userId)
    .eq('command_key', parsed.data.key)
    .maybeSingle();
  if (readError) return err('INTERNAL', 'Could not read recent commands.');

  if (existing) {
    const { error } = await supabase
      .schema('core')
      .from('recent_commands')
      .update({ use_count: existing.use_count + 1, last_used_at: new Date().toISOString(), label: parsed.data.label, href: parsed.data.href })
      .eq('id', existing.id);
    if (error) return err('INTERNAL', 'Could not record the command.');
  } else {
    const { error } = await supabase.schema('core').from('recent_commands').insert({
      organization_id: context.organizationId,
      user_id: context.userId,
      command_key: parsed.data.key,
      label: parsed.data.label,
      href: parsed.data.href,
    });
    if (error) return err('INTERNAL', 'Could not record the command.');
  }

  const { data: all, error: pruneRead } = await supabase
    .schema('core')
    .from('recent_commands')
    .select('id')
    .eq('user_id', context.userId)
    .order('last_used_at', { ascending: false });
  if (!pruneRead && all && all.length > RECENT_COMMAND_LIMIT) {
    const stale = all.slice(RECENT_COMMAND_LIMIT).map((r) => r.id);
    const { error } = await supabase.schema('core').from('recent_commands').delete().in('id', stale);
    if (error) console.error(JSON.stringify({ level: 'error', scope: 'recordCommand.prune', detail: error.message }));
  }
  return ok({ recorded: true });
}

export const DRAFT_KINDS = ['lead', 'client', 'project', 'invoice', 'task', 'quotation', 'meeting', 'change_request'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export type CreateDraft = { kind: DraftKind; draft: Record<string, string>; updatedAt: string };

/** Every draft the person has — one per kind at most. */
export async function listCreateDrafts(): Promise<CreateDraft[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').from('create_drafts').select('kind, draft, updated_at');
  if (error) unreadable('listCreateDrafts', error);
  return (data ?? [])
    .filter((r): r is typeof r & { kind: DraftKind } => (DRAFT_KINDS as readonly string[]).includes(r.kind))
    .map((r) => ({ kind: r.kind, draft: stringFields(r.draft), updatedAt: r.updated_at }));
}

/** Only string fields survive: a draft is form text, never a structure the form did not type. */
function stringFields(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export const saveDraftSchema = z.object({
  kind: z.enum(DRAFT_KINDS),
  draft: z.record(z.string().max(60), z.string().max(4000)).refine((d) => Object.keys(d).length <= 40, 'Too many fields.'),
});

/** Upserts the person's draft for a kind; an all-empty draft deletes it instead. */
export async function saveCreateDraft(input: z.input<typeof saveDraftSchema>): Promise<Result<{ saved: boolean }>> {
  const parsed = saveDraftSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid draft.');
  const context = await requireInternal();
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');
  const supabase = await createClient();

  const meaningful = Object.values(parsed.data.draft).some((v) => v.trim().length > 0);
  if (!meaningful) {
    const cleared = await discardCreateDraft(parsed.data.kind);
    return cleared.ok ? ok({ saved: false }) : cleared;
  }

  const { error } = await supabase.schema('core').from('create_drafts').upsert(
    { organization_id: context.organizationId, user_id: context.userId, kind: parsed.data.kind, draft: parsed.data.draft },
    { onConflict: 'organization_id,user_id,kind' },
  );
  if (error) return err('INTERNAL', 'The draft could not be saved.');
  return ok({ saved: true });
}

export async function discardCreateDraft(kind: DraftKind): Promise<Result<{ saved: false }>> {
  if (!(DRAFT_KINDS as readonly string[]).includes(kind)) return err('VALIDATION', 'Unknown draft.');
  const context = await requireInternal();
  const supabase = await createClient();
  const { error } = await supabase.schema('core').from('create_drafts').delete().eq('user_id', context.userId).eq('kind', kind);
  if (error) return err('INTERNAL', 'The draft could not be discarded.');
  return ok({ saved: false });
}
