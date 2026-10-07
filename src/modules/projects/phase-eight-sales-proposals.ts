import { z } from 'zod';

import { unsafeText, type Verdict } from './phase-eight-proposals';

/**
 * What the post-launch Sales agent may PROPOSE: a DISCOVERY BRIEF for an opportunity a person has already qualified (SAL-TST-002: discovery reuses the Customer 360
 * context). Pure, so the workflow and the tests share one definition. The agent writes a summary and the questions to ask, and CITES the ticket and check-in records
 * it used. It never quotes, prices, discounts, negotiates, accepts, opens a deal or contacts anybody: those stay in the existing sales doors, and the database door
 * refuses text that names a price. Nothing here has been run against a real model.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

export const discoveryBriefSchema = z
  .object({
    summary: z.string().trim().min(20).max(2000),
    questions: z.array(z.string().trim().min(10).max(300)).min(1).max(10),
    citedTicketIds: z.array(text(64)).max(15),
    citedCheckInIds: z.array(text(64)).max(10),
  })
  .strict();
export type DiscoveryBrief = z.infer<typeof discoveryBriefSchema>;

export type DiscoveryFacts = {
  projectName: string;
  healthStatus: string | null;
  opportunity: { kind: string; need: string; urgency: string };
  tickets: { id: string; title: string; classification: string | null; status: string }[];
  checkIns: { id: string; kind: string; outcome: string | null }[];
};

export function checkDiscoveryBrief(b: DiscoveryBrief, facts: DiscoveryFacts): Verdict {
  const unsafeIn = [b.summary, ...b.questions].map(unsafeText).find((u) => u !== null);
  if (unsafeIn) return { ok: false, reason: `the brief contains a ${unsafeIn}` };
  const ticketIds = new Set(facts.tickets.map((t) => t.id));
  const checkInIds = new Set(facts.checkIns.map((c) => c.id));
  for (const id of b.citedTicketIds) if (!ticketIds.has(id)) return { ok: false, reason: `it cites ticket ${id}, which is not in the facts` };
  for (const id of b.citedCheckInIds) if (!checkInIds.has(id)) return { ok: false, reason: `it cites check-in ${id}, which is not in the facts` };
  if (b.citedTicketIds.length + b.citedCheckInIds.length === 0) return { ok: false, reason: 'it cites no record from the customer context' };
  return { ok: true };
}

export const discoverySystemPrompt = [
  'You prepare a DISCOVERY BRIEF for ONE post-launch opportunity that a person has already qualified. You do not contact anyone, open a deal or send anything.',
  'Write a short summary of what the client appears to need and 1 to 10 open questions a salesperson should ask to understand it. Use only the recorded facts.',
  'Cite, by id, the tickets and check-ins from the facts that you relied on (at least one). Never cite an id that is not in the facts.',
  'Do not quote, state or hint at a price, an amount, a discount or a rate. Do not promise a date, a refund or free work. Never write a secret.',
  'Do not invent satisfaction, usage or a problem. If the facts are thin, ask questions rather than asserting.',
].join(' ');

export function renderDiscoveryFacts(f: DiscoveryFacts): string {
  return [
    `Project: ${f.projectName}`,
    `Derived health: ${f.healthStatus ?? 'unknown'}`,
    `Opportunity (${f.opportunity.kind}, urgency ${f.opportunity.urgency}): ${f.opportunity.need}`,
    `Tickets: ${f.tickets.length === 0 ? 'none' : f.tickets.map((t) => `${t.id} [${t.classification ?? 'unclassified'}, ${t.status}] ${t.title}`).join('; ')}`,
    `Completed check-ins: ${f.checkIns.length === 0 ? 'none' : f.checkIns.map((c) => `${c.id} ${c.kind}: ${c.outcome ?? 'no outcome'}`).join('; ')}`,
  ].join('\n');
}

export function discoveryJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'questions', 'citedTicketIds', 'citedCheckInIds'],
    properties: {
      summary: { type: 'string', description: 'What the client appears to need, from the facts. 20 to 2000 characters. No price.' },
      questions: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', description: 'An open question for discovery. 10 to 300 characters. No price.' } },
      citedTicketIds: { type: 'array', maxItems: 15, items: { type: 'string' }, description: 'Ids of tickets from the facts you relied on.' },
      citedCheckInIds: { type: 'array', maxItems: 10, items: { type: 'string' }, description: 'Ids of check-ins from the facts you relied on.' },
    },
  };
}
