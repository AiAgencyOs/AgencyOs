import { z } from 'zod';

import { LEAD_STATUSES } from './schema';

/**
 * A campaign's audience — SCR-059, owner decision 2026-09-30.
 *
 * The filter is the Leads list's own (`app/(internal)/leads/page.tsx`:
 * status, source, owner, service, created window) plus the two the plan
 * names (a tag, a last-activity window). It is stored on the campaign AS
 * TYPED and applied by one pure function, `expandAudience`, at preview and
 * again at approval — so the number the approver read is the number of rows
 * written, not a second query's opinion.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const campaignAudienceSchema = z.object({
  status: z.preprocess(blank, z.enum(LEAD_STATUSES).optional()),
  source: z.preprocess(blank, z.string().trim().max(80).optional()),
  /** A user id, or 'unassigned'. */
  owner: z.preprocess(blank, z.union([z.literal('unassigned'), z.uuid()]).optional()),
  service: z.preprocess(blank, z.string().trim().max(80).optional()),
  tag: z.preprocess(blank, z.string().trim().max(80).optional()),
  /** Active (updated) within this many days. */
  lastActivityDays: z.preprocess(blank, z.coerce.number().int().min(1).max(3650).optional()),
  createdFrom: z.preprocess(blank, z.string().regex(DATE, 'Use a date like 2026-09-30.').optional()),
  createdTo: z.preprocess(blank, z.string().regex(DATE, 'Use a date like 2026-09-30.').optional()),
  /** SCR-059 (bucket F): the leads behind one project — through the opportunity the project was won from. */
  projectId: z.preprocess(blank, z.uuid().optional()),
});
export type CampaignAudience = z.infer<typeof campaignAudienceSchema>;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, 'Give the campaign a name.').max(120, 'Keep the name under 120 characters.'),
  templateId: z.uuid('Choose an approved template.'),
  audience: campaignAudienceSchema,
  /** SCR-059 (bucket F): an ISO moment before which the worker sends nothing. Blank means as soon as approved. */
  scheduledFor: z.preprocess(blank, z.string().trim().max(40).optional()),
});
/** As the form hands it over: strings, before zod coerces and narrows them. */
export type CreateCampaignInput = z.input<typeof createCampaignSchema>;

export const approveCampaignSchema = z.object({ campaignId: z.uuid() });

export const cancelCampaignSchema = z.object({
  campaignId: z.uuid(),
  reason: z.string().trim().min(1, 'Say why the campaign is withdrawn.').max(600, 'Keep the reason under 600 characters.'),
});
export type CancelCampaignInput = z.infer<typeof cancelCampaignSchema>;

/** One lead as the expansion sees it. */
export type AudienceCandidate = {
  leadId: string;
  status: string;
  source: string;
  assignedTo: string | null;
  service: string | null;
  tags: readonly string[];
  createdAt: string;
  updatedAt: string;
  conversationId: string | null;
  /** The projects this lead is behind (via sales.opportunities → projects.projects). Absent in older callers. */
  projectIds?: readonly string[];
};

export type AudienceRecipient = { leadId: string; conversationId: string | null };

/**
 * The expansion — pure and deterministic. Same rows, same filter, same
 * answer, in a stable order (oldest lead first, id as the tie-break), so a
 * preview and an approval a minute apart disagree only when the leads did.
 *
 * `now` is a parameter for the same reason: a last-activity window is a
 * question about a moment, and the caller names it.
 */
export function expandAudience(
  candidates: readonly AudienceCandidate[],
  filter: CampaignAudience,
  now: Date,
): AudienceRecipient[] {
  const service = filter.service?.toLowerCase();
  const tag = filter.tag?.toLowerCase();
  const activeSince = filter.lastActivityDays !== undefined ? now.getTime() - filter.lastActivityDays * 86_400_000 : undefined;
  const createdFrom = filter.createdFrom ? `${filter.createdFrom}T00:00:00` : undefined;
  const createdTo = filter.createdTo ? `${filter.createdTo}T23:59:59.999Z` : undefined;

  return candidates
    .filter(
      (c) =>
        (!filter.status || c.status === filter.status) &&
        (!filter.source || c.source === filter.source) &&
        (!filter.owner || (filter.owner === 'unassigned' ? c.assignedTo === null : c.assignedTo === filter.owner)) &&
        (!service || (c.service ?? '').toLowerCase() === service) &&
        (!tag || c.tags.some((t) => t.toLowerCase() === tag)) &&
        (activeSince === undefined || new Date(c.updatedAt).getTime() >= activeSince) &&
        (!createdFrom || c.createdAt >= createdFrom) &&
        (!createdTo || c.createdAt <= createdTo) &&
        (!filter.projectId || (c.projectIds ?? []).includes(filter.projectId)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.leadId.localeCompare(b.leadId))
    .map((c) => ({ leadId: c.leadId, conversationId: c.conversationId }));
}

/** The filter as a human reads it on the list — "status qualified · source whatsapp". */
export function describeAudience(filter: CampaignAudience): string {
  const parts = [
    filter.status ? `status ${filter.status}` : '',
    filter.source ? `source ${filter.source}` : '',
    filter.owner ? (filter.owner === 'unassigned' ? 'unassigned' : 'one owner') : '',
    filter.service ? `service ${filter.service}` : '',
    filter.tag ? `tag ${filter.tag}` : '',
    filter.lastActivityDays !== undefined ? `active in the last ${filter.lastActivityDays}d` : '',
    filter.createdFrom ? `created from ${filter.createdFrom}` : '',
    filter.createdTo ? `created to ${filter.createdTo}` : '',
    filter.projectId ? 'one project' : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'every lead';
}
