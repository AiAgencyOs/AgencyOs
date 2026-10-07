/**
 * P1-BLUEPRINT-013 (A07) / P1-MP3-135: compare two versions of a requirement set. Pure: two payloads in, what was added, removed and changed out. The
 * page reads both versions through the RLS-scoped reader; nothing here edits a requirement (history is read-only; a correction is always the NEXT version).
 *
 * Lists of strings are compared as sets after normalising case and whitespace (re-wording only the capitalisation is not a change); scope items are
 * matched by TITLE so a changed detail is "modified", not removed-and-added.
 */
export type RequirementPayloadLike = {
  summary?: string;
  scopeItems?: readonly { title: string; detail?: string }[];
  constraints?: readonly string[];
  openQuestions?: readonly string[];
  assumptions?: readonly string[];
  niceToHaves?: readonly string[];
  exclusions?: readonly string[];
  designReferences?: readonly string[];
  userRoles?: readonly string[];
  platforms?: readonly string[];
  integrations?: readonly string[];
  timelineBudgetNotes?: string;
  objectives?: readonly string[];
  businessRules?: readonly string[];
  nonFunctionalRequirements?: readonly string[];
};

export type SectionChange = {
  key: string;
  label: string;
  added: string[];
  removed: string[];
  modified: { name: string; from: string; to: string }[];
};

export type RequirementComparison = {
  sections: SectionChange[];
  identical: boolean;
  /** True when what is BUILT or PRICED changed: scope items, platforms, integrations, exclusions or objectives. */
  scopeChanged: boolean;
};

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

const LIST_SECTIONS: { key: keyof RequirementPayloadLike; label: string; priced: boolean }[] = [
  { key: 'objectives', label: 'Objectives', priced: true },
  { key: 'constraints', label: 'Constraints', priced: false },
  { key: 'businessRules', label: 'Business rules', priced: false },
  { key: 'nonFunctionalRequirements', label: 'Non-functional requirements', priced: true },
  { key: 'userRoles', label: 'Who will use it', priced: false },
  { key: 'platforms', label: 'Platforms', priced: true },
  { key: 'integrations', label: 'Integrations', priced: true },
  { key: 'assumptions', label: 'Assumptions', priced: false },
  { key: 'niceToHaves', label: 'Nice to have', priced: false },
  { key: 'exclusions', label: 'Excluded', priced: true },
  { key: 'designReferences', label: 'Design references', priced: false },
  { key: 'openQuestions', label: 'Open questions', priced: false },
];

function setDiff(from: readonly string[], to: readonly string[]): { added: string[]; removed: string[] } {
  const f = new Map(from.map((s) => [norm(s), s]));
  const t = new Map(to.map((s) => [norm(s), s]));
  return {
    added: [...t].filter(([k]) => !f.has(k)).map(([, v]) => v),
    removed: [...f].filter(([k]) => !t.has(k)).map(([, v]) => v),
  };
}

export function compareRequirementPayloads(from: RequirementPayloadLike, to: RequirementPayloadLike): RequirementComparison {
  const sections: SectionChange[] = [];
  let scopeChanged = false;

  const fs = (from.summary ?? '').trim();
  const ts = (to.summary ?? '').trim();
  if (norm(fs) !== norm(ts)) sections.push({ key: 'summary', label: 'Summary', added: [], removed: [], modified: [{ name: 'Summary', from: fs, to: ts }] });

  // scope items by title
  const fItems = new Map((from.scopeItems ?? []).map((i) => [norm(i.title), i]));
  const tItems = new Map((to.scopeItems ?? []).map((i) => [norm(i.title), i]));
  const scope: SectionChange = { key: 'scopeItems', label: 'Scope items', added: [], removed: [], modified: [] };
  for (const [k, item] of tItems) {
    const before = fItems.get(k);
    if (!before) scope.added.push(item.title);
    else if (norm(before.detail ?? '') !== norm(item.detail ?? '')) scope.modified.push({ name: item.title, from: before.detail ?? '', to: item.detail ?? '' });
  }
  for (const [k, item] of fItems) if (!tItems.has(k)) scope.removed.push(item.title);
  if (scope.added.length + scope.removed.length + scope.modified.length > 0) {
    sections.push(scope);
    scopeChanged = true;
  }

  for (const s of LIST_SECTIONS) {
    const { added, removed } = setDiff((from[s.key] as readonly string[] | undefined) ?? [], (to[s.key] as readonly string[] | undefined) ?? []);
    if (added.length + removed.length > 0) {
      sections.push({ key: String(s.key), label: s.label, added, removed, modified: [] });
      if (s.priced) scopeChanged = true;
    }
  }

  const fn = (from.timelineBudgetNotes ?? '').trim();
  const tn = (to.timelineBudgetNotes ?? '').trim();
  if (norm(fn) !== norm(tn)) sections.push({ key: 'timelineBudgetNotes', label: 'Timeline and budget notes', added: [], removed: [], modified: [{ name: 'Notes', from: fn, to: tn }] });

  return { sections, identical: sections.length === 0, scopeChanged };
}

/**
 * What the change means for the quotation. A quote is drawn from ONE requirement version; if the newer version changes what is built or priced, the
 * quotation built on the earlier version is out of date and needs a new quote version. Wording never says it "will be" re-priced: that is a person's call.
 */
export function quoteImpact(input: { scopeChanged: boolean; identical: boolean; quotedVersion: number | null; fromVersion: number; toVersion: number }): { level: 'none' | 'review' | 'not_quoted'; message: string } {
  if (input.quotedVersion === null) return { level: 'not_quoted', message: 'No quotation has been drawn from either version.' };
  if (input.identical || !input.scopeChanged) return { level: 'none', message: 'Nothing that is built or priced changed, so the quotation is not affected by this difference.' };
  if (input.quotedVersion >= input.toVersion) return { level: 'none', message: `The quotation was drawn from version ${input.quotedVersion}, which already includes these changes.` };
  return { level: 'review', message: `The quotation was drawn from version ${input.quotedVersion}. Version ${input.toVersion} changes what is built or priced, so the quotation needs review before it is relied on.` };
}
