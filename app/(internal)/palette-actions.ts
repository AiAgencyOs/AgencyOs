'use server';

import {
  discardCreateDraft,
  listCreateDrafts,
  listRecentCommands,
  recordCommand,
  saveCreateDraft,
  type CreateDraft,
  type DraftKind,
  type RecentCommand,
} from '@/lib/admin/palette-memory';
import { getAuthContext } from '@/lib/auth/session';
import { isInternalRole } from '@/lib/auth/claims';
import { can } from '@/lib/authz/permissions';
import { err, ok, type Result } from '@/lib/result';
import { listLeadsForTable } from '@/modules/crm/queries';
import { listPipelineOpportunities } from '@/modules/sales/pipeline-queries';
import { isOpenOpportunity, type OpportunityStage } from '@/modules/sales/schema';

/**
 * What the ⌘K palette reads and remembers — SCR-004 (bucket F, stream
 * F-A). The palette is a client component with no server render to hand
 * these down through, so — like `project-create-actions.ts` — the reads are
 * exposed as actions and a failed read is a refusal, never an empty list.
 *
 * The memory doors are personal bookkeeping (`core.recent_commands`,
 * `core.create_drafts`) under own-row RLS; nothing here is audited because
 * nothing here is a decision.
 */

export async function listRecentCommandsAction(): Promise<RecentCommand[]> {
  const context = await getAuthContext();
  if (!context || !isInternalRole(context.role)) return [];
  try {
    return await listRecentCommands();
  } catch {
    return [];
  }
}

export async function recordCommandAction(input: { key: string; label: string; href: string | null }): Promise<void> {
  const context = await getAuthContext();
  if (!context || !isInternalRole(context.role)) return;
  await recordCommand(input);
}

export async function listCreateDraftsAction(): Promise<CreateDraft[]> {
  const context = await getAuthContext();
  if (!context || !isInternalRole(context.role)) return [];
  try {
    return await listCreateDrafts();
  } catch {
    return [];
  }
}

export async function saveCreateDraftAction(kind: DraftKind, draft: Record<string, string>): Promise<Result<{ saved: boolean }>> {
  return saveCreateDraft({ kind, draft });
}

export async function discardCreateDraftAction(kind: DraftKind): Promise<Result<{ saved: false }>> {
  return discardCreateDraft(kind);
}

/** An open deal the quotation form may draft against, named by its lead — the composer's own list, shortened. */
export type OpportunityOption = { opportunityId: string; leadId: string | null; name: string; leadTitle: string; stage: string };

export async function listOpenOpportunityOptionsAction(): Promise<Result<OpportunityOption[]>> {
  const context = await getAuthContext();
  if (!context || !isInternalRole(context.role)) return err('UNAUTHORIZED', 'Sign in again.');
  if (!can(context, 'proposal.draft')) return err('FORBIDDEN', 'You do not have permission to draft quotations.');
  try {
    const rows = await listPipelineOpportunities(200);
    return ok(
      rows
        .filter((o) => isOpenOpportunity(o.stage as OpportunityStage))
        .map((o) => ({ opportunityId: o.id, leadId: o.lead_id, name: o.name, leadTitle: o.lead?.title ?? 'Lead', stage: o.stage })),
    );
  } catch (e: unknown) {
    return err('INTERNAL', e instanceof Error ? e.message : 'Open deals could not be read.');
  }
}

export type LeadOption = { id: string; title: string; status: string };

export async function listLeadOptionsAction(): Promise<Result<LeadOption[]>> {
  const context = await getAuthContext();
  if (!context || !isInternalRole(context.role)) return err('UNAUTHORIZED', 'Sign in again.');
  if (!can(context, 'lead.read')) return err('FORBIDDEN', 'You do not have permission to read leads.');
  try {
    const rows = await listLeadsForTable(300);
    return ok(rows.map((l) => ({ id: l.id, title: l.title, status: l.status })));
  } catch (e: unknown) {
    return err('INTERNAL', e instanceof Error ? e.message : 'Leads could not be read.');
  }
}
