import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { buildCredentialProblem } from './build-secrets-guard';
import {
  promoteBuildSchema,
  recordEnvironmentCheckSchema,
  type PromoteBuildInput,
  type RecordEnvironmentCheckInput,
} from './environment-readiness-schema';

/**
 * SCR-043 — record a readiness check and promote a build (migration
 * 20261001130000). `project.write`, the capability the environment rows
 * already take; `core.can_manage_delivery()` again inside. Promotion is
 * gated in the database: every readiness check recorded and ok, and no red
 * release gate — the refusal names what is missing.
 */

function log(scope: string, detail: string | undefined) {
  console.error(JSON.stringify({ level: 'error', scope, detail }));
}

export async function recordEnvironmentCheck(input: RecordEnvironmentCheckInput): Promise<Result<{ check: string; ok: boolean }>> {
  const parsed = recordEnvironmentCheckSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid check.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to record a readiness check.');

  // SCR-043: the evidence on an environment check is read by the whole team; no credential goes in it.
  const credential = buildCredentialProblem([
    { label: 'Evidence link', value: parsed.data.evidenceUrl, isLink: true },
    { label: 'Note', value: parsed.data.note },
  ]);
  if (credential) return err('VALIDATION', credential);

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('record_environment_check', {
    p_environment_id: parsed.data.environmentId,
    p_check: parsed.data.check,
    p_ok: parsed.data.ok,
    p_evidence_url: parsed.data.evidenceUrl || undefined,
    p_note: parsed.data.note || undefined,
  });
  if (error) {
    log('recordEnvironmentCheck', error.message);
    return err('INTERNAL', 'Could not record the check.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
  switch (row?.outcome) {
    case 'recorded':
      return ok({ check: parsed.data.check, ok: parsed.data.ok });
    case 'not_found':
      return err('NOT_FOUND', 'Environment not found.');
    case 'bad_check':
      return err('VALIDATION', 'That is not a readiness check.');
    case 'bad_evidence':
      return err('VALIDATION', 'Evidence is a link that starts with https://');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may record a check.');
    default:
      return err('INTERNAL', 'Could not record the check.');
  }
}

export async function promoteBuild(input: PromoteBuildInput): Promise<Result<{ promoted: true }>> {
  const parsed = promoteBuildSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid environment or build.');

  const context = await requireInternal();
  if (!can(context, 'project.write')) return err('FORBIDDEN', 'You do not have permission to promote a build.');

  const supabase = await createClient();
  const { data, error } = await supabase.schema('projects').rpc('promote_build', {
    p_environment_id: parsed.data.environmentId,
    p_deliverable_id: parsed.data.deliverableId,
  });
  if (error) {
    log('promoteBuild', error.message);
    return err('INTERNAL', 'Could not promote the build.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; detail?: string | null } | undefined;
  switch (row?.outcome) {
    case 'promoted':
      return ok({ promoted: true });
    case 'readiness_refused':
      return err('CONFLICT', `Readiness refused the promotion — ${row.detail ?? 'a check is missing'}. Record the checks first.`);
    case 'gates_refused':
      return err('CONFLICT', `A release gate is red — ${row.detail ?? 'see the QA tab'}. Promotion waits for green gates.`);
    case 'already_promoted':
      return err('CONFLICT', 'That build is already the one promoted to this environment.');
    case 'not_a_build':
      return err('VALIDATION', 'Only a build deliverable of this project can be promoted.');
    case 'superseded':
      return err('CONFLICT', 'That build is superseded.');
    case 'not_found':
      return err('NOT_FOUND', 'Environment not found.');
    case 'forbidden':
      return err('FORBIDDEN', 'The database refused: only an owner, ops admin or delivery lead may promote a build.');
    default:
      return err('INTERNAL', 'Could not promote the build.');
  }
}
