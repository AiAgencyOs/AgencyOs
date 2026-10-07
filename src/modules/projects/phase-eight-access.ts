import 'server-only';

import { createClient } from '@/lib/db/server';
import { unreadable } from '@/lib/result';

/**
 * The check a Phase 8 page runs BEFORE it renders a project (E2E-13). `projects.guard_phase_eight_project` answers `allowed` when the caller's organization (or,
 * for a client, the client's own portal) owns the project, and otherwise records a denial in the CALLER's organization and answers `denied`. It answers the same
 * way for a project that does not exist and one in another tenant. A failed call is refused, never read as "allowed".
 */
export type PhaseEightSurface = 'project_workspace' | 'support_tickets' | 'customer_360' | 'communication_ledger' | 'value_report' | 'opportunity' | 'check_in' | 'feedback' | 'knowledge_base' | 'other';

export async function guardPhaseEightProject(projectId: string, surface: PhaseEightSurface): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('guard_phase_eight_project' as never, { p_project_id: projectId, p_surface: surface } as never);
  if (error) unreadable('guardPhaseEightProject', error);
  const row = ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string };
  return row.outcome === 'allowed';
}
