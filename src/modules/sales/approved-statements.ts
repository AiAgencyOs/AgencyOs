/**
 * The statements the OWNER has approved the agent to say about how the agency
 * works (`approved_trust_facts`, Settings › Communication), one per line.
 *
 * The agent otherwise states nothing about the agency — no years, no payment
 * terms, no guarantees — and defers every such question to a colleague. This
 * is the owner's way of giving it the few things it may say to a client who is
 * nervous about paying or about being left. Empty means the block is absent
 * and behaviour is exactly as before. The model is told to say these in its
 * own words about the concern raised, and to add nothing to them.
 */
export function approvedStatementsBlock(settings: unknown): string {
  const raw = (settings as { approved_trust_facts?: unknown } | null | undefined)?.approved_trust_facts;
  if (typeof raw !== 'string') return '';
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l !== '').slice(0, 12);
  if (lines.length === 0) return '';
  return (
    '\nWhat the agency has APPROVED you to say about how it works. When the client\'s concern is about one of ' +
    'these, say it plainly in your own words; do not add terms, numbers, guarantees or promises beyond what is ' +
    'written, and anything they ask that is not covered here is still for a colleague to confirm:\n' +
    lines.map((l) => `- ${l}`).join('\n') +
    '\n'
  );
}

