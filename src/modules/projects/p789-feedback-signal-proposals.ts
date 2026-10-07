import { z } from 'zod';

import { unsafeText, type Verdict } from './phase-eight-proposals';

/**
 * What the Customer Success agent may PROPOSE about client feedback (P7-CS-05): a short signal note (adoption, complaint, praise or mixed) that CITES each
 * feedback row it read. Pure, so the workflow and the tests share one definition. It never opens a ticket, schedules a check-in, contacts the client, prices or
 * promises anything: a person reviews the draft. The database door holds the same rules again. Nothing here has been run against a real model.
 */

export const SIGNALS = ['adoption', 'complaint', 'praise', 'mixed'] as const;

export const feedbackSignalSchema = z
  .object({
    signal: z.enum(SIGNALS),
    summary: z.string().trim().min(20).max(2000),
    citedFeedbackIds: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  })
  .strict();
export type FeedbackSignal = z.infer<typeof feedbackSignalSchema>;

export type FeedbackFacts = {
  projectName: string;
  feedback: { id: string; sentiment: string | null; source: string; body: string }[];
};

export function checkFeedbackSignal(s: FeedbackSignal, facts: FeedbackFacts): Verdict {
  const unsafe = unsafeText(s.summary);
  if (unsafe) return { ok: false, reason: `the note contains a ${unsafe}` };
  const byId = new Map(facts.feedback.map((f) => [f.id, f] as const));
  const cited = [...new Set(s.citedFeedbackIds)];
  for (const id of cited) if (!byId.has(id)) return { ok: false, reason: `it cites feedback ${id}, which is not in the facts` };
  const negative = cited.filter((id) => byId.get(id)!.sentiment === 'negative').length;
  const positive = cited.filter((id) => byId.get(id)!.sentiment === 'positive').length;
  if (s.signal === 'complaint' && negative === 0) return { ok: false, reason: 'a complaint must cite negative feedback' };
  if (s.signal === 'praise' && negative > 0) return { ok: false, reason: 'praise cannot cite negative feedback' };
  if (s.signal === 'mixed' && (negative === 0 || positive === 0)) return { ok: false, reason: 'a mixed signal must cite both positive and negative feedback' };
  return { ok: true };
}

export const feedbackSignalSystemPrompt = [
  'You write a short SIGNAL NOTE about ONE delivered project from the client feedback already recorded. A person reads it. You contact no one and change nothing.',
  'Choose exactly one signal: adoption (how the client is using or adopting the product), complaint (the feedback is negative), praise (positive only) or mixed (both).',
  'Cite, by id, every feedback row you relied on (at least one). Never cite an id that is not in the facts. A complaint must cite negative feedback; praise must cite none.',
  'Do not state a price, a discount, a refund, free work, a date or a guarantee. Never write a secret. Do not invent usage or satisfaction beyond the rows.',
].join(' ');

export function renderFeedbackFacts(f: FeedbackFacts): string {
  return [`Project: ${f.projectName}`, `Feedback: ${f.feedback.length === 0 ? 'none' : f.feedback.map((r) => `${r.id} [${r.sentiment ?? 'no sentiment'}, ${r.source}] ${r.body}`).join(' | ')}`].join('\n');
}

export function feedbackSignalJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['signal', 'summary', 'citedFeedbackIds'],
    properties: {
      signal: { type: 'string', enum: [...SIGNALS] },
      summary: { type: 'string', description: 'What the feedback shows, from the rows only. 20 to 2000 characters. No price, discount, refund or promise.' },
      citedFeedbackIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: 'Ids of the feedback rows from the facts you relied on.' },
    },
  };
}
