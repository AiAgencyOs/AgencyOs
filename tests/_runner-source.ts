import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The job runner's source, as one string, in the order a request travels it.
 *
 * It used to be one file, and the tests that assert *where* a control sits —
 * the autonomy gate before the model call, `failJob` clearing the lock,
 * `logJobParked` naming the dead job — read that file directly.
 *
 * The runner is now three: `route.ts` claims and gates, `agent-run.ts` holds
 * what is the same whichever agent it is, and `workflows.ts` holds what
 * differs. Splitting it was the point — a single hard-coded agent key is what
 * made twelve of ADM-82's thirteen agents unreachable — but the assertions did
 * not change meaning, only address.
 *
 * **Concatenated in dispatch order, and that order is load-bearing.** A test
 * asserting `mayAgentRun(...)` appears before `resolveProvider(...)` is
 * asserting that an agent which may not act never reaches the model. That is
 * still exactly true: the gate is in `route.ts` and the provider is reached
 * from `agent-run.ts`, which runs after it. Reading them in the other order
 * would turn a real invariant into a passing coincidence.
 *
 * The order is the CALL order, not the file order: `route.ts` gates, the
 * workflow runs, and the workflow reaches `agent-run.ts` for the model. A
 * first draft listed `agent-run.ts` second and broke four assertions about
 * work that must happen before the model call — the shared helper holds
 * `generateStructured`, so putting it ahead of the workflows placed the model
 * call before every idempotency check that precedes it.
 */
const FILES = [
  '../app/api/jobs/run/route.ts',
  '../app/api/jobs/run/workflows.ts',
  '../app/api/jobs/run/agent-run.ts',
] as const;

export const RUNNER_SOURCE: string = FILES.map((f) =>
  readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8'),
).join('\n');
