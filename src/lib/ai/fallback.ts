import { isProviderUnavailable } from './failure';
import type { Result } from '@/lib/result';

/**
 * The failure-time half of routing, with no database and no network attached.
 *
 * `orderModelCandidates` decides which model to try FIRST; this decides what
 * happens when it cannot serve the call. The rules are the owner's
 * (2026-10-03):
 *
 *   • only an `unavailable` failure moves on — a refusal, a bad request or
 *     unparseable output stops here, because another model would fail the
 *     same way (see failure.ts);
 *   • `sameVendorOnly` restricts the next candidate to the vendor that just
 *     failed — used for money-bearing work, where switching vendor is a
 *     decision for the owner's list, not the router;
 *   • a candidate is tried once; the list is the owner's order, then the
 *     agent's default, so no model the owner did not list is ever reached;
 *   • `canSwitch` lets a caller pin the model — a tool-using run that has
 *     already exchanged tool results must finish on the model that issued
 *     them.
 *
 * Every attempt is returned, so the caller records each one: a trace that
 * shows only the call that finally worked hides that the first one failed.
 */
export type Candidate = { readonly model: string; readonly providerId: string };

export type AttemptRecord = {
  readonly model: string;
  readonly providerId: string;
  readonly ok: boolean;
  readonly error: string | null;
  /** The model whose failure led here; null for the first attempt. */
  readonly fallbackOf: string | null;
};

export type FallbackOutcome<T> = {
  readonly result: Result<T>;
  readonly attempts: readonly AttemptRecord[];
  readonly final: Candidate | null;
  /** More than one candidate was tried (or was available) and every one was unavailable. */
  readonly exhausted: boolean;
};

export async function runWithFallback<T>(args: {
  candidates: readonly Candidate[];
  sameVendorOnly: boolean;
  canSwitch?: boolean;
  attempt: (candidate: Candidate, info: { index: number; fallbackOf: string | null }) => Promise<Result<T>>;
}): Promise<FallbackOutcome<T>> {
  const attempts: AttemptRecord[] = [];
  const tried = new Set<string>();
  let current: Candidate | undefined = args.candidates[0];
  let fallbackOf: string | null = null;
  let lastResult: Result<T> | null = null;
  let allUnavailable = true;

  while (current) {
    tried.add(current.model);
    const result = await args.attempt(current, { index: attempts.length, fallbackOf });
    attempts.push({
      model: current.model,
      providerId: current.providerId,
      ok: result.ok,
      error: result.ok ? null : result.error.message,
      fallbackOf,
    });
    lastResult = result;

    if (result.ok) return { result, attempts, final: current, exhausted: false };
    if (!isProviderUnavailable(result.error)) allUnavailable = false;
    if (!allUnavailable || args.canSwitch === false) break;

    const failed: Candidate = current;
    const next: Candidate | undefined = args.candidates.find(
      (c) => !tried.has(c.model) && (!args.sameVendorOnly || c.providerId === failed.providerId),
    );
    fallbackOf = failed.model;
    current = next;
  }

  const switchable = args.canSwitch !== false;
  return {
    result: lastResult as Result<T>,
    attempts,
    final: null,
    exhausted: switchable && allUnavailable && attempts.length > 1,
  };
}
