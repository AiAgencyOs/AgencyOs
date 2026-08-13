'use server';

import { revalidatePath } from 'next/cache';

import { requeueJob } from '@/lib/observability/requeue';
import type { FormState } from '@/modules/identity/types';

/**
 * Server Action for the operations screen — G-099.
 *
 * Here rather than in `lib/observability/` beside the write it wraps, and the
 * lint rule is what said so: `lib/` may not import `modules/`
 * (ARCHITECTURE.md §3.2), and `FormState` belongs to identity. The boundary is
 * pointing at something real — this file knows the route to revalidate and the
 * shape a React form expects, both of which are facts about the screen rather
 * than about the queue. `requeueJob` knows neither and stays where the reads
 * for this page live.
 *
 * Every refusal is surfaced as written. "That job is queued, so there is
 * nothing to revive" is nearly always a colleague who got there first on a
 * page that has been open a while, and it needs no action at all; "that job is
 * not in this queue" is a link that should not exist. They are not the same
 * news, and flattening both to "something went wrong" would tell the operator
 * to retry the one thing that cannot work.
 */
export async function requeueJobAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await requeueJob(String(formData.get('jobId') ?? ''));

  if (!result.ok) {
    return { status: 'error', message: result.error.message };
  }

  revalidatePath('/operations');

  return {
    status: 'success',
    message:
      result.data.attempts > 0
        ? `Back in the queue, after ${result.data.attempts} failed attempt${result.data.attempts === 1 ? '' : 's'}.`
        : 'Back in the queue.',
  };
}
