import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * What staff see of the P604 Functional Test evidence for one Master Test Plan, from the STORED rows: per-requirement scenario coverage, the
 * definition of done, and the structured handoff to Master QA. All three are derived by the database (nothing here computes a verdict), and a failed
 * read is surfaced, never rendered as nothing here. The handoff never declares production readiness.
 */

type Row = Record<string, unknown>;
type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = { rpc(fn: string, args: Record<string, unknown>): Res };
type Schemaed = { schema(name: string): Loose };

export type FunctionalCoverageRow = {
  scopeItemId: string;
  title: string;
  directCases: number;
  kindsCovered: string[];
  kindsMissing: string[];
  excludedReason: string | null;
  coverage: 'excluded' | 'uncovered' | 'minimum_met' | 'partial';
};
export type DefinitionOfDoneRow = { item: string; satisfied: boolean; detail: string };
export type FunctionalHandoff = {
  planId: string;
  build: { commit: string; artifactSha256: string | null };
  environments: string[];
  requirements: { included: number; covered: number; excluded: number; uncovered: number };
  totals: { pass: number; fail: number; blocked: number; not_applicable: number; skipped_with_reason: number; not_run: number };
  recommendation: 'not_recommended' | 'blocked' | 'incomplete' | 'functional_pass_recommended';
  declaresProductionReady: false;
  definitionOfDone: DefinitionOfDoneRow[];
  unresolvedBlockers: { caseId: string; title: string; reason: string | null; failureClass: string | null }[];
  knownLimitations: string[];
  note: string;
};
export type FunctionalTestView = { coverage: FunctionalCoverageRow[]; definitionOfDone: DefinitionOfDoneRow[]; handoff: FunctionalHandoff | null };

const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const COVERAGE = new Set(['excluded', 'uncovered', 'minimum_met', 'partial']);
const RECOMMENDATION = new Set(['not_recommended', 'blocked', 'incomplete', 'functional_pass_recommended']);

export function parseCoverage(data: unknown): FunctionalCoverageRow[] {
  return rows(data).map((r) => ({
    scopeItemId: String(r.scope_item_id),
    title: String(r.title),
    directCases: Number(r.direct_cases ?? 0),
    kindsCovered: strs(r.kinds_covered),
    kindsMissing: strs(r.kinds_missing),
    excludedReason: typeof r.excluded_reason === 'string' ? r.excluded_reason : null,
    coverage: (COVERAGE.has(String(r.coverage)) ? r.coverage : 'uncovered') as FunctionalCoverageRow['coverage'],
  }));
}

export function parseDefinitionOfDone(data: unknown): DefinitionOfDoneRow[] {
  return rows(data).map((r) => ({ item: String(r.item), satisfied: r.satisfied === true, detail: String(r.detail ?? '') }));
}

/** The handoff as the database wrote it. An unknown recommendation is read as incomplete, never as a pass. */
export function parseHandoff(data: unknown): FunctionalHandoff | null {
  if (!data || typeof data !== 'object') return null;
  const h = data as Row;
  const build = (h.build ?? {}) as Row;
  const req = (h.requirements ?? {}) as Row;
  const tot = (h.totals ?? {}) as Row;
  const n = (v: unknown) => Number(v ?? 0);
  return {
    planId: String(h.planId),
    build: { commit: String(build.commit ?? ''), artifactSha256: typeof build.artifactSha256 === 'string' ? build.artifactSha256 : null },
    environments: strs(h.environments),
    requirements: { included: n(req.included), covered: n(req.covered), excluded: n(req.excluded), uncovered: n(req.uncovered) },
    totals: { pass: n(tot.pass), fail: n(tot.fail), blocked: n(tot.blocked), not_applicable: n(tot.not_applicable), skipped_with_reason: n(tot.skipped_with_reason), not_run: n(tot.not_run) },
    recommendation: (RECOMMENDATION.has(String(h.recommendation)) ? h.recommendation : 'incomplete') as FunctionalHandoff['recommendation'],
    declaresProductionReady: false,
    definitionOfDone: parseDefinitionOfDone(h.definitionOfDone),
    unresolvedBlockers: rows(h.unresolvedBlockers).map((b) => ({
      caseId: String(b.caseId), title: String(b.title), reason: typeof b.reason === 'string' ? b.reason : null, failureClass: typeof b.failureClass === 'string' ? b.failureClass : null,
    })),
    knownLimitations: strs(h.knownLimitations),
    note: String(h.note ?? ''),
  };
}

export async function loadFunctionalTestView(planId: string): Promise<FunctionalTestView> {
  await requireInternal();
  const qa = ((await createClient()) as unknown as Schemaed).schema('qa');
  const [cov, dod, hand] = await Promise.all([
    qa.rpc('functional_coverage', { p_plan_id: planId }),
    qa.rpc('functional_definition_of_done', { p_plan_id: planId }),
    qa.rpc('functional_handoff', { p_plan_id: planId }),
  ]);
  if (cov.error) unreadable('functional test coverage', cov.error);
  if (dod.error) unreadable('functional test definition of done', dod.error);
  if (hand.error) unreadable('functional test handoff', hand.error);
  return { coverage: parseCoverage(cov.data), definitionOfDone: parseDefinitionOfDone(dod.data), handoff: parseHandoff(hand.data) };
}
