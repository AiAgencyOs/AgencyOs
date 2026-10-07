import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

import { parseCoverage, parseDefinitionOfDone, parseHandoff, type FunctionalTestView } from './functional-test-parse';

/**
 * What staff see of the P604 Functional Test evidence for one Master Test Plan, from the STORED rows: per-requirement scenario coverage, the
 * definition of done, and the structured handoff to Master QA. All three are derived by the database (nothing here computes a verdict), and a failed
 * read is surfaced, never rendered as nothing here. The handoff never declares production readiness.
 */

type Res = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type Loose = { rpc(fn: string, args: Record<string, unknown>): Res };
type Schemaed = { schema(name: string): Loose };

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
