import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * SCR-060 — what became of the retries of a failed message.
 *
 * The attempts are the original's own `retry_count`; what this reads is the
 * retry rows themselves (`retry_of` names the original), newest first, so a
 * row can say "last attempt failed — <provider's reason>" or "last attempt
 * sent". Only outbound rows carry a `delivery` key, so a retry's outcome is
 * read the same way the failed-delivery list reads the original's.
 */
export type RetryAttempt = {
  messageId: string;
  at: string;
  delivery: string | null;
  error: string | null;
};

export type RetryHistory = {
  attempts: number;
  last: RetryAttempt | null;
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function readRetryHistory(originalIds: readonly string[]): Promise<Map<string, RetryHistory>> {
  const history = new Map<string, RetryHistory>();
  if (originalIds.length === 0) return history;

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('crm')
    .from('conversation_messages')
    .select('id, retry_of, occurred_at, metadata')
    .in('retry_of', [...originalIds])
    .order('occurred_at', { ascending: false });
  if (error) unreadable('readRetryHistory', error);

  for (const row of data ?? []) {
    if (!row.retry_of) continue;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const entry = history.get(row.retry_of) ?? { attempts: 0, last: null };
    entry.attempts += 1;
    if (!entry.last) {
      entry.last = { messageId: row.id, at: row.occurred_at, delivery: str(meta.delivery), error: str(meta.error) };
    }
    history.set(row.retry_of, entry);
  }
  return history;
}
