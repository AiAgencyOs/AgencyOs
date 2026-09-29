/**
 * The decisions, actions and open questions inside an analysis note —
 * SCR-060's "extracted" panel on the meeting page.
 *
 * The analysis handler files ONE row: a `summary` evidence item whose body
 * is `renderAnalysisSummary(...)` (meeting-analysis.ts) — the structured
 * `MeetingAnalysis` is not stored as JSON anywhere a page may read it. So
 * this reads the sections back out of the note the renderer wrote, by the
 * headings the renderer owns. Pure, so the round trip is testable without
 * a database; a body that is not an analysis note yields nothing rather
 * than a guess.
 */
export type AnalysisSections = {
  /** "Agency committed to" + "Client committed to" — the decisions taken. */
  decisions: { who: 'agency' | 'client'; text: string }[];
  /** "Next action" and the agreed follow-up, if any. */
  actions: string[];
  /** "Unresolved", "Needs clarification" and "Questions the client raised". */
  openQuestions: string[];
};

const BULLET = /^•\s*/;

function section(body: string, title: string): string[] {
  const start = body.indexOf(`\n${title}\n`);
  if (start === -1) return [];
  const rest = body.slice(start + title.length + 2);
  const items: string[] = [];
  for (const line of rest.split('\n')) {
    if (!BULLET.test(line)) break;
    items.push(line.replace(BULLET, '').trim());
  }
  return items;
}

export function isAnalysisNote(body: string | null | undefined): boolean {
  return typeof body === 'string' && body.startsWith('AI analysis — PROPOSED');
}

export function parseAnalysisSections(body: string): AnalysisSections {
  const decisions = [
    ...section(body, 'Agency committed to').map((text) => ({ who: 'agency' as const, text })),
    ...section(body, 'Client committed to').map((text) => ({ who: 'client' as const, text })),
  ];

  const actions: string[] = [];
  const next = body.match(/\n\nNext action: (.+)/);
  if (next?.[1]) actions.push(next[1].trim());
  const agreed = body.match(/\n\nAgreed follow-up: (.+)/);
  if (agreed?.[1]) actions.push(`Agreed follow-up: ${agreed[1].trim()}`);

  const openQuestions = [
    ...section(body, 'Unresolved'),
    ...section(body, 'Needs clarification'),
    ...section(body, 'Questions the client raised'),
  ];

  return { decisions, actions, openQuestions };
}
