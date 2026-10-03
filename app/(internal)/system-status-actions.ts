'use server';

import { getProductionReadiness } from '@/lib/admin/production-readiness';
import { readinessSentence } from '@/lib/admin/production-readiness-eval';
import { getAuthContext } from '@/lib/auth/session';
import { isInternalRole } from '@/lib/auth/claims';

/**
 * The header's system-status dot — the shared rule "help/status in header"
 * (bucket F, stream F-A). Fed by the readiness evaluator, the SAME one
 * /production-readiness renders, so the dot and the page never disagree.
 * Read by the browser after paint, like the bell's count: the layout itself
 * makes no database read (see layout.tsx).
 */
export type SystemStatus = { tone: 'danger' | 'warning' | 'success'; text: string; href: string };

export async function readSystemStatusAction(): Promise<SystemStatus | null> {
  const context = await getAuthContext();
  if (!context || !isInternalRole(context.role)) return null;
  try {
    const { summary } = await getProductionReadiness();
    const sentence = readinessSentence(summary);
    return { tone: sentence.tone, text: sentence.text, href: '/production-readiness' };
  } catch (e: unknown) {
    console.error(JSON.stringify({ level: 'error', scope: 'readSystemStatusAction', detail: e instanceof Error ? e.message : String(e) }));
    return { tone: 'danger', text: 'System status could not be read.', href: '/production-readiness' };
  }
}
