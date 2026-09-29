'use server';

import { readClientNextFollowUp } from '@/lib/admin/client-followups';
import { getClient } from '@/lib/admin/clients';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

/**
 * SCR-014's preview drawer — the same read the client page performs, fetched
 * on demand from the list so opening a preview costs one round trip for one
 * client rather than the whole registry pre-loading everyone's invoices.
 *
 * Gated exactly like `/clients/[clientId]`: session, `project.read`, then
 * RLS on every table `getClient` touches. A refusal comes back as a message
 * the drawer shows verbatim, never as an empty preview.
 */

export type ClientPreview = {
  id: string;
  name: string;
  currency: string;
  outstandingMinor: number;
  pendingInvoices: { id: string; number: string; status: string; totalMinor: number; paidMinor: number }[];
  recentMessages: {
    id: string;
    projectName: string;
    direction: 'inbound' | 'outbound' | null;
    authorType: string;
    body: string | null;
    occurredAt: string;
  }[];
  nextFollowUp: { at: string; source: 'sequence' | 'lead'; leadId: string; leadTitle: string } | null;
};

export type ClientPreviewState =
  | { status: 'ok'; preview: ClientPreview }
  | { status: 'error'; message: string };

const PENDING_INVOICE_STATUSES = new Set(['draft', 'pending_approval', 'issued', 'partially_paid', 'overdue']);

export async function readClientPreviewAction(clientId: string): Promise<ClientPreviewState> {
  const context = await requireInternal('/clients');
  if (!can(context, 'project.read')) {
    return { status: 'error', message: 'You do not have permission to view clients.' };
  }

  try {
    const [client, nextFollowUp] = await Promise.all([getClient(clientId), readClientNextFollowUp(clientId)]);
    if (!client) return { status: 'error', message: 'Client not found.' };

    const recentMessages = client.communication
      .flatMap((thread) => thread.messages.map((m) => ({ ...m, projectName: thread.projectName })))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, 5)
      .map((m) => ({
        id: m.id,
        projectName: m.projectName,
        direction: m.direction,
        authorType: m.authorType,
        body: m.body,
        occurredAt: m.occurredAt,
      }));

    return {
      status: 'ok',
      preview: {
        id: client.id,
        name: client.name,
        currency: client.currency,
        outstandingMinor: client.outstandingMinor,
        pendingInvoices: client.invoices
          .filter((i) => PENDING_INVOICE_STATUSES.has(i.status) && i.totalMinor > i.paidMinor)
          .map((i) => ({ id: i.id, number: i.number, status: i.status, totalMinor: i.totalMinor, paidMinor: i.paidMinor })),
        recentMessages,
        nextFollowUp: nextFollowUp
          ? { at: nextFollowUp.at, source: nextFollowUp.source, leadId: nextFollowUp.leadId, leadTitle: nextFollowUp.leadTitle }
          : null,
      },
    };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'The preview could not be read.' };
  }
}
