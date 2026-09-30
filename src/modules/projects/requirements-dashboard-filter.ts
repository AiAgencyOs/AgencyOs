/**
 * The Requirements dashboard's project table — search, filter and page, as
 * pure functions over the rows `readRequirementsOverview` returns (SCR-028's
 * "search/filtering where list size can grow"). No I/O.
 */

export type RequirementProjectRow = {
  projectId: string;
  projectName: string;
  scopeVersion: number | null;
  scopeStatus: string | null;
  openChangeRequests: number;
  openClarifications: number;
};

export const SCOPE_FILTERS = ['all', 'frozen', 'draft', 'none'] as const;
export type ScopeFilter = (typeof SCOPE_FILTERS)[number];
export const OPEN_FILTERS = ['all', 'questions', 'changes'] as const;
export type OpenFilter = (typeof OPEN_FILTERS)[number];

export const SCOPE_FILTER_LABEL: Record<ScopeFilter, string> = { all: 'Any scope', frozen: 'Frozen', draft: 'Draft', none: 'No scope' };
export const OPEN_FILTER_LABEL: Record<OpenFilter, string> = { all: 'Everything', questions: 'Open questions', changes: 'Open change requests' };

export const PAGE_SIZE = 20;

export function parseScopeFilter(v: string | undefined): ScopeFilter {
  return (SCOPE_FILTERS as readonly string[]).includes(v ?? '') ? (v as ScopeFilter) : 'all';
}
export function parseOpenFilter(v: string | undefined): OpenFilter {
  return (OPEN_FILTERS as readonly string[]).includes(v ?? '') ? (v as OpenFilter) : 'all';
}

export function filterRequirementProjects(rows: readonly RequirementProjectRow[], input: { q: string; scope: ScopeFilter; open: OpenFilter }): RequirementProjectRow[] {
  const needle = input.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (needle !== '' && !r.projectName.toLowerCase().includes(needle)) return false;
    if (input.scope === 'none' && r.scopeVersion !== null) return false;
    if (input.scope === 'draft' && r.scopeStatus !== 'draft') return false;
    if (input.scope === 'frozen' && !(r.scopeVersion !== null && r.scopeStatus !== 'draft')) return false;
    if (input.open === 'questions' && r.openClarifications === 0) return false;
    if (input.open === 'changes' && r.openChangeRequests === 0) return false;
    return true;
  });
}

export function pageOf<T>(rows: readonly T[], page: number, size = PAGE_SIZE): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages };
}
