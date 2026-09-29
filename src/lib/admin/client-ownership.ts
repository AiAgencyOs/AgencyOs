import 'server-only';

import { z } from 'zod';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

/**
 * Client tags and relationship owner — SCR-014 (`core.client_accounts.tags`,
 * `.owner_id`, migration 20260929150000). Beside `clients.ts` for the same
 * reason that file exists: `core.client_accounts` has no owning module.
 *
 * `project.write` is the capability, matching `addClientNote` and the
 * "Add client" door: "may add operational detail to a client I can see".
 * RLS's `client_accounts_write` (`core.can_write()`) decides again, and
 * `audit.record_row_change` records the change as `client_account.updated`;
 * the owner change additionally gets a named audit row because who answers
 * for a client is a fact somebody later asks about.
 */

export const MAX_CLIENT_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

/** Lower-cased, trimmed, deduplicated, bounded — the shape the column stores. */
export function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>();
  for (const t of raw) {
    const tag = t.trim().toLowerCase().replace(/\s+/g, ' ');
    if (tag && tag.length <= MAX_TAG_LENGTH) seen.add(tag);
  }
  return [...seen].slice(0, MAX_CLIENT_TAGS);
}

export const setClientTagsSchema = z.object({
  clientAccountId: z.uuid(),
  tags: z.array(z.string().max(MAX_TAG_LENGTH + 20)).max(200),
});

export const setClientOwnerSchema = z.object({
  clientAccountId: z.uuid(),
  ownerId: z.uuid().nullable(),
});

async function loadClient(supabase: Awaited<ReturnType<typeof createClient>>, id: string) {
  const { data, error } = await supabase
    .schema('core')
    .from('client_accounts')
    .select('id, organization_id, tags, owner_id')
    .eq('id', id)
    .maybeSingle();
  if (error) return { client: null, failed: true } as const;
  return { client: data, failed: false } as const;
}

export async function setClientTags(input: z.input<typeof setClientTagsSchema>): Promise<Result<{ tags: string[] }>> {
  const parsed = setClientTagsSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid tags.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to tag clients.');

  const supabase = await createClient();
  const { client, failed } = await loadClient(supabase, parsed.data.clientAccountId);
  if (failed) return err('INTERNAL', 'Could not load the client.');
  if (!client) return err('NOT_FOUND', 'Client not found.');

  const tags = normalizeTags(parsed.data.tags);
  const { data: updated, error } = await supabase
    .schema('core')
    .from('client_accounts')
    .update({ tags })
    .eq('id', client.id)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setClientTags', detail: error.message }));
    return err('INTERNAL', 'Could not save the tags.');
  }
  if (!updated) return err('FORBIDDEN', 'The database refused the change.');

  return ok({ tags });
}

export async function setClientOwner(input: z.input<typeof setClientOwnerSchema>): Promise<Result<{ ownerId: string | null }>> {
  const parsed = setClientOwnerSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid owner.');

  const context = await requireInternal();
  if (!can(context.role, 'project.write')) return err('FORBIDDEN', 'You do not have permission to set a client’s owner.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();

  // The owner must hold an ACTIVE membership: a client owned by somebody
  // who cannot open it is a client nobody answers for.
  if (parsed.data.ownerId) {
    const { data: membership, error } = await supabase
      .schema('core')
      .from('memberships')
      .select('user_id, status')
      .eq('organization_id', context.organizationId)
      .eq('user_id', parsed.data.ownerId)
      .maybeSingle();
    if (error) return err('INTERNAL', 'Could not check that person’s membership.');
    if (!membership) return err('NOT_FOUND', 'That person is not a member of this organization.');
    if (membership.status !== 'active') return err('CONFLICT', 'That person’s membership is not active.');
  }

  const { client, failed } = await loadClient(supabase, parsed.data.clientAccountId);
  if (failed) return err('INTERNAL', 'Could not load the client.');
  if (!client) return err('NOT_FOUND', 'Client not found.');

  const { data: updated, error } = await supabase
    .schema('core')
    .from('client_accounts')
    .update({ owner_id: parsed.data.ownerId })
    .eq('id', client.id)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setClientOwner', detail: error.message }));
    return err('INTERNAL', 'Could not save the owner.');
  }
  if (!updated) return err('FORBIDDEN', 'The database refused the change.');

  await recordAudit({
    organizationId: context.organizationId,
    action: 'client_account.owner_set',
    subjectType: 'client_account',
    subjectId: client.id,
    before: { owner_id: client.owner_id },
    after: { owner_id: parsed.data.ownerId },
  });

  return ok({ ownerId: parsed.data.ownerId });
}
