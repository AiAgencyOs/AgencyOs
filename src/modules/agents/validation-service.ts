import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import type { Json } from '@/lib/db/types';
import { err, ok, type Result } from '@/lib/result';

import { validateAgent, type Validation } from './validation-rules';
import { validateAgentConfigurationSchema, type ValidateAgentConfigurationInput } from './validation-schema';

/**
 * SCR-062 — "Validate now", by a person.
 *
 * Reads the live row and its two mirrors under the caller's own RLS, runs the
 * pure checks in ./validation-rules.ts, and records what it found in
 * `ai.agent_validations` (20260929210000). It never writes `ai.agents`: that
 * table is global and not tenant-writable, and the cron tick's stamp stays
 * the tick's. Owner or ops_admin — the tier that reads the Operations
 * screens (`audit.read`) — and the insert policy (`core.is_admin()`) says so
 * again.
 */
export async function validateAgentConfiguration(input: ValidateAgentConfigurationInput): Promise<Result<Validation>> {
  const parsed = validateAgentConfigurationSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid agent key.');

  const context = await requireInternal();
  if (!can(context, 'audit.read')) return err('FORBIDDEN', 'Only an owner or ops admin may validate an agent.');
  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const supabase = await createClient();
  const key = parsed.data.agentKey;

  const [agentRead, handoffRead, verifierRead] = await Promise.all([
    supabase
      .schema('ai')
      .from('agents')
      .select('key, enabled, default_model, max_steps, max_cost_minor, definition_version')
      .eq('key', key)
      .maybeSingle(),
    supabase.schema('ai').from('agent_handoff_targets').select('to_agent').eq('from_agent', key),
    supabase.schema('ai').from('agent_verifiers').select('verifier').eq('producer', key),
  ]);

  if (agentRead.error) {
    console.error(JSON.stringify({ level: 'error', scope: 'validateAgentConfiguration.agent', detail: agentRead.error.message }));
    return err('INTERNAL', 'Could not read the agent row.');
  }
  if (!agentRead.data) return err('NOT_FOUND', 'Agent not found in the registry.');
  if (handoffRead.error) {
    console.error(JSON.stringify({ level: 'error', scope: 'validateAgentConfiguration.handoffs', detail: handoffRead.error.message }));
    return err('INTERNAL', 'Could not read the handoff mirror.');
  }
  if (verifierRead.error) {
    console.error(JSON.stringify({ level: 'error', scope: 'validateAgentConfiguration.verifiers', detail: verifierRead.error.message }));
    return err('INTERNAL', 'Could not read the verifier mirror.');
  }

  const row = agentRead.data;
  const validation = validateAgent(
    {
      key: row.key,
      enabled: row.enabled,
      defaultModel: row.default_model,
      maxSteps: row.max_steps,
      maxCostMinor: row.max_cost_minor,
      definitionVersion: row.definition_version,
    },
    {
      handoffTargets: (handoffRead.data ?? []).map((h) => h.to_agent),
      verifiers: (verifierRead.data ?? []).map((v) => v.verifier),
    },
  );

  const { error } = await supabase.schema('ai').from('agent_validations').insert({
    organization_id: context.organizationId,
    agent_key: key,
    validated_by: context.userId,
    outcome: validation.outcome,
    registry_revision: validation.revision,
    findings: validation.findings as unknown as Json,
  });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'validateAgentConfiguration.record', detail: error.message }));
    return err('INTERNAL', 'The checks ran, but the validation could not be recorded.');
  }

  return ok(validation);
}
