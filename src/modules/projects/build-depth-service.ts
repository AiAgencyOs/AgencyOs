import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import {
  buildConfigPayload,
  cancelOutcomeMessage,
  cancelRequestSchema,
  configOutcomeMessage,
  createPackageSchema,
  packageOutcomeMessage,
  setBuildConfigSchema,
  type CancelRequestInput,
  type CreatePackageInput,
  type SetBuildConfigInput,
} from './build-depth-schema';

/**
 * The three person-facing doors of the build pipeline depth (migrations 20261102210000 and 20261102220000): the Admin writes the build config,
 * staff package a ready build for the client, an Admin cancels a build request. `project.sign_off` (owner, ops admin) for the Admin ones,
 * `project.write` for the package; the database re-checks every one and its answer is what is shown.
 */

type Rpc = { rpc(fn: string, args: unknown): PromiseLike<{ data: unknown; error: { message: string } | null }> };
const first = (data: unknown) => ((Array.isArray(data) ? data[0] : data) ?? {}) as { outcome?: string; version?: number | null; package_id?: string | null };

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function setBuildConfig(input: SetBuildConfigInput): Promise<Result<{ version: number }>> {
  const parsed = setBuildConfigSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid configuration.');
  const payload = buildConfigPayload(parsed.data.config, parsed.data.envNames);
  if (!payload.ok) return err('VALIDATION', payload.message);
  const context = await requireInternal();
  if (!can(context, 'project.sign_off')) return err('FORBIDDEN', 'Only an owner or ops admin writes the build configuration.');
  const supabase = await createClient();
  const { data, error } = await (supabase.schema('projects') as unknown as Rpc).rpc('set_build_config', {
    p_project_id: parsed.data.projectId, p_config: payload.payload, p_note: parsed.data.note || null,
  });
  if (error) {
    log('setBuildConfig', error.message);
    return err('INTERNAL', 'Could not save the build configuration.');
  }
  const row = first(data);
  if (row.outcome === 'recorded' && typeof row.version === 'number') return ok({ version: row.version });
  return err(row.outcome === 'unchanged' ? 'CONFLICT' : 'VALIDATION', configOutcomeMessage(row.outcome));
}

export async function createClientBuildPackage(input: CreatePackageInput): Promise<Result<{ packageId: string }>> {
  const parsed = createPackageSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid package.');
  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to package a build for the client.');
  const supabase = await createClient();
  const { data, error } = await (supabase.schema('projects') as unknown as Rpc).rpc('create_client_build_package', {
    p_deliverable_id: parsed.data.deliverableId, p_limitations: parsed.data.limitations, p_testing_instructions: parsed.data.testingInstructions,
  });
  if (error) {
    log('createClientBuildPackage', error.message);
    return err('INTERNAL', 'Could not write the package.');
  }
  const row = first(data);
  if (row.outcome === 'recorded' && row.package_id) return ok({ packageId: row.package_id });
  return err('CONFLICT', packageOutcomeMessage(row.outcome));
}

export async function cancelBuildRequest(input: CancelRequestInput): Promise<Result<{ cancelled: true }>> {
  const parsed = cancelRequestSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid request.');
  const context = await requireInternal();
  if (!can(context, 'project.sign_off')) return err('FORBIDDEN', 'Only an owner or ops admin cancels a build request.');
  const supabase = await createClient();
  const { data, error } = await (supabase.schema('projects') as unknown as Rpc).rpc('cancel_build_request', {
    p_request_id: parsed.data.requestId, p_reason: parsed.data.reason || null,
  });
  if (error) {
    log('cancelBuildRequest', error.message);
    return err('INTERNAL', 'Could not cancel the build request.');
  }
  const row = first(data);
  return row.outcome === 'cancelled' ? ok({ cancelled: true }) : err('CONFLICT', cancelOutcomeMessage(row.outcome));
}
