import 'server-only';

import { getAuthContext } from '@/lib/auth/session';
import { createClient } from '@/lib/db/server';

/**
 * Appends to audit.audit_log.
 *
 * Platform-level rather than per-module: every module's gated transitions land
 * in the same trail, and lib/ may not depend on modules/ (ARCHITECTURE.md §3.2).
 *
 * Writes go through the RLS-scoped client on purpose. The insert policy allows
 * `actor_type = 'user'` only when `actor_id = auth.uid()`, so a caller cannot
 * attribute an action to somebody else — the database enforces that, not this
 * function. The table has no UPDATE or DELETE policy and a trigger that rejects
 * both, so an entry written here cannot later be rewritten.
 *
 * Failure is logged, never thrown. An audit write that fails should not roll
 * back the business change it describes — the alternative is refusing a valid
 * state transition because its history row would not insert.
 */
export async function recordAudit(entry: {
  organizationId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
}): Promise<void> {
  const context = await getAuthContext();
  if (!context) return;

  const supabase = await createClient();

  const { error } = await supabase
    .schema('audit')
    .from('audit_log')
    .insert({
      organization_id: entry.organizationId,
      actor_type: 'user',
      actor_id: context.userId,
      action: entry.action,
      subject_type: entry.subjectType,
      subject_id: entry.subjectId,
      before: (entry.before ?? null) as never,
      after: (entry.after ?? null) as never,
      correlation_id: entry.correlationId ?? null,
    });

  if (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'recordAudit',
        action: entry.action,
        detail: error.message,
      }),
    );
  }
}
