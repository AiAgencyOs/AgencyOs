import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { BUILD_STAGES, maskSecrets } from './build-runner';

type Admin = ReturnType<typeof createAdminClient>;
type Rpc = { rpc(name: string, args: unknown): PromiseLike<{ data: unknown; error: { message: string } | null }> };

export const LOG_STAGES = [...BUILD_STAGES, 'smoke'] as const;
export type LogStage = (typeof LOG_STAGES)[number];

/**
 * Stores one piece of a build log through the service-role door `projects.append_build_log`. The text is masked here (build-runner maskSecrets) and
 * the database masks it again, so a secret reaches the table only if BOTH layers miss it. A log that cannot be stored is said, never dropped quietly.
 */
export async function appendBuildLog(admin: Admin, runId: string, stage: LogStage, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(LOG_STAGES as readonly string[]).includes(stage)) return { ok: false, reason: 'bad_stage' };
  const masked = maskSecrets(text).slice(0, 50_000);
  if (!masked.trim()) return { ok: false, reason: 'empty' };
  const { data, error } = await (admin.schema('projects') as unknown as Rpc).rpc('append_build_log', { p_build_run_id: runId, p_stage: stage, p_text: masked });
  if (error) return { ok: false, reason: `unreadable: ${error.message}` };
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  return row?.outcome === 'recorded' ? { ok: true } : { ok: false, reason: row?.outcome ?? 'no answer' };
}
