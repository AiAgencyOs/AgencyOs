'use server';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { readLeadScore } from '@/modules/crm/lead-score-queries';
import { readLeadScoreOverride } from '@/modules/crm/lead-score-override-queries';
import { getLatestConversation, getLeadFacts, getLeadHeader, getLeadPipeline, listMessages } from '@/modules/crm/queries';
import { getOpportunityForLead } from '@/modules/sales/queries';

/**
 * SCR-006's preview drawer — the Lead 360's own readers, fetched on demand
 * from the list so opening a preview costs one round trip for one lead.
 * Gated exactly like `/leads/[leadId]`: session, `lead.read`, then RLS on
 * every table. A refusal comes back as a message the drawer shows verbatim.
 */
export type LeadPreview = {
  id: string;
  title: string;
  status: string;
  source: string;
  contact: { name: string | null; phone: string | null; email: string | null; company: string | null };
  assignedEmail: string | null;
  nextFollowUpAt: string | null;
  deal: { name: string; stage: string; valueMinor: number; currency: string } | null;
  score: { computed: number | null; override: number | null; overrideReason: string | null };
  lastMessages: { id: string; body: string; occurredAt: string; incoming: boolean }[];
  tags: string[];
};

export type LeadPreviewState = { status: 'ok'; preview: LeadPreview } | { status: 'error'; message: string };

export async function readLeadPreviewAction(leadId: string): Promise<LeadPreviewState> {
  const context = await requireInternal('/leads');
  if (!can(context, 'lead.read')) return { status: 'error', message: 'You do not have permission to view leads.' };

  try {
    const [lead, facts, pipeline, opportunity, score, override, conversation] = await Promise.all([
      getLeadHeader(leadId),
      getLeadFacts(leadId),
      getLeadPipeline(leadId),
      getOpportunityForLead(leadId),
      readLeadScore(leadId),
      readLeadScoreOverride(leadId),
      getLatestConversation(leadId),
    ]);
    if (!lead) return { status: 'error', message: 'Lead not found.' };
    const messages = conversation ? await listMessages(conversation.id) : [];
    return {
      status: 'ok',
      preview: {
        id: lead.id,
        title: lead.title,
        status: lead.status,
        source: lead.source,
        contact: { name: facts?.contactName ?? null, phone: facts?.contactPhone ?? null, email: facts?.contactEmail ?? null, company: facts?.contactCompany ?? null },
        assignedEmail: facts?.assignedEmail ?? null,
        nextFollowUpAt: pipeline?.next_follow_up_at ?? null,
        deal: opportunity ? { name: opportunity.name, stage: opportunity.stage, valueMinor: opportunity.value_minor, currency: opportunity.currency } : null,
        score: { computed: score?.score ?? null, override: override?.score ?? null, overrideReason: override?.reason ?? null },
        lastMessages: messages.slice(-4).map((m) => ({
          id: m.id,
          body: m.body,
          occurredAt: m.occurred_at,
          incoming: m.direction === 'inbound' || (m.direction === null && m.author_type === 'client'),
        })),
        tags: facts?.tags ?? [],
      },
    };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'The preview could not be read.' };
  }
}
