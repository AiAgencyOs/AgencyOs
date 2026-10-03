'use server';

import { revalidatePath } from 'next/cache';

import type { Result } from '@/lib/result';

import type { BulkLeadActionInput, BulkLeadOutcome } from './bulk-schema';
import { bulkLeadAction as run } from './bulk-service';

/**
 * The leads list's bulk door — SCR-006. RPC-style: the caller renders one
 * line per lead, each in the door's own words, so a `FormState` with a
 * single message would have hidden nineteen of twenty answers.
 */
export async function bulkLeadAction(input: BulkLeadActionInput): Promise<Result<BulkLeadOutcome[]>> {
  const result = await run(input);
  if (result.ok) {
    revalidatePath('/leads');
    for (const o of result.data) if (o.ok) revalidatePath(`/leads/${o.leadId}`);
  }
  return result;
}
