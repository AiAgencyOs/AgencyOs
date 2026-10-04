import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import type { Json } from '@/lib/db/types';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Embeddings, images and transcription are not chosen between by the router: each is one fixed vendor (the embedding key the
 * Provider Manager holds, the image generator, the transcriber). They still spend money and move data, so they leave the same
 * record a routed run does - which provider and model served, under which routing configuration, and what happened - and they
 * show up in the same routing log and provider usage. `selection_source` says "fixed_capability" so nobody reads it as a choice.
 *
 * Best effort: a decision that cannot be written is logged and never fails the work it describes.
 */
export async function recordCapabilityDecision(
  admin: Admin,
  args: {
    organizationId: string;
    agentKey: string;
    capability: 'embedding' | 'image' | 'transcription';
    providerId: string;
    modelId: string;
    outcome: 'succeeded' | 'failed' | 'blocked';
    jobId?: string | null;
    runId?: string | null;
    detail?: string;
    /** What the call used, if known: tokens, items. Counts only - never content. */
    usage?: Record<string, number>;
  },
): Promise<void> {
  try {
    const settings = await admin.schema('ai').from('routing_settings').select('mode, version').eq('organization_id', args.organizationId).maybeSingle();
    const { error } = await admin.schema('ai').rpc('record_routing_decision', {
      p_organization_id: args.organizationId,
      p_job_id: (args.jobId ?? null) as unknown as string,
      p_run_id: (args.runId ?? null) as unknown as string,
      p_agent_key: args.agentKey,
      p_work_class: args.capability,
      p_category: null as unknown as string,
      p_mode: settings.data?.mode === 'manual' ? 'manual' : 'auto',
      p_config_version: settings.data?.version ?? 1,
      p_plan: { capability: args.capability, fixed: true, usage: args.usage ?? {}, candidates: [], considered: [], warnings: [] } as unknown as Json,
      p_attempts: [{ providerId: args.providerId, model: args.modelId, ok: args.outcome === 'succeeded', error: args.outcome === 'succeeded' ? null : (args.detail ?? null)?.slice(0, 300) ?? null, fallbackOf: null }] as unknown as Json,
      p_outcome: args.outcome,
      p_provider_id: args.providerId,
      p_model_id: args.modelId,
      p_selection_source: 'fixed_capability',
      p_fallback_used: false,
      p_blocked_reason: (args.outcome === 'blocked' ? (args.detail ?? null)?.slice(0, 400) ?? null : null) as unknown as string,
    });
    if (error) console.error(JSON.stringify({ level: 'error', scope: 'recordCapabilityDecision', detail: error.message }));
  } catch (cause) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordCapabilityDecision', detail: cause instanceof Error ? cause.message : String(cause) }));
  }
}
