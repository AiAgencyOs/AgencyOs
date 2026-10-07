import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { appendBuildLog } from './build-logs-service';
import { runBuild, type RunPlan } from './build-runner';
import { reportExecutor, type BuildReport } from './github-build';

type Admin = ReturnType<typeof createAdminClient>;
type Rpc = { rpc(name: string, args: unknown): PromiseLike<{ data: unknown; error: { message: string } | null }> };
const first = (data: unknown) => ((Array.isArray(data) ? data[0] : data) ?? {}) as Record<string, unknown>;

export type ReportOutcome =
  | { status: 'recorded'; build: 'succeeded' | 'failed'; detail: string }
  | { status: 'refused'; reason: 'no_open_request' | 'door_refused' | 'unreadable'; detail: string };

/**
 * Accepts a VERIFIED, schema-valid worker report: only for an open build request on that exact deliverable and commit, recorded through the
 * same doors and the same runner decisions as any build (a "success" with a failed required stage or no artifact is still a failure). One
 * attempt per report: a retry is a new request. The organization comes from the request row, never from the report.
 */
export async function recordBuildReport(admin: Admin, report: BuildReport): Promise<ReportOutcome> {
  const rpc = admin.schema('projects') as unknown as Rpc;
  const { data: open, error } = await rpc.rpc('open_build_request_for', { p_deliverable_id: report.deliverableId, p_commit: report.commit });
  if (error) return { status: 'refused', reason: 'unreadable', detail: `the request could not be read: ${error.message}` };
  const request = first(open) as { request_id?: string; environment?: string };
  if (!request.request_id || request.request_id !== report.requestId) {
    return { status: 'refused', reason: 'no_open_request', detail: 'no open build request matches this deliverable, commit and request id' };
  }
  const environment = (['dev', 'review', 'staging', 'client_test'] as const).find((e) => e === request.environment) ?? 'review';

  let doorRefusal: string | null = null;
  let transient = false;
  const secondary: string[] = [];
  const plan: RunPlan = {
    deliverableId: report.deliverableId,
    commit: report.commit,
    environment,
    maxAttempts: 1,
    record: async (a) => {
      const { data, error: e } = await rpc.rpc('record_build_run', {
        p_deliverable_id: report.deliverableId, p_environment: environment, p_status: a.status, p_failure_class: a.failureClass, p_stages: a.stages,
        p_fingerprint: a.fingerprint, p_artifact_sha256: a.artifactSha256, p_retry_of: a.retryOf, p_idempotency_key: `${a.idempotencyKey}:${report.requestId}`,
      });
      if (e) {
        transient = true;
        return { outcome: `error: ${e.message}`, runId: null };
      }
      const row = first(data);
      const runId = (row.run_id as string | undefined) ?? null;
      // the worker's own stage logs are kept, masked in the runner AND again in the database; a log that cannot be stored never blocks the record
      if (row.outcome === 'recorded' && runId) {
        for (const s of report.stages) if (s.log) await appendBuildLog(admin, runId, s.name, s.log);
      }
      return { outcome: String(row.outcome ?? 'no answer'), runId };
    },
    recordSmoke: async (a) => {
      const { data } = await rpc.rpc('record_smoke_check', { p_deliverable_id: report.deliverableId, p_result: a.result, p_checks: a.checks, p_device_target: a.deviceTarget, p_reason: a.reason, p_evidence_url: a.evidenceUrl });
      const outcome = String(first(data).outcome ?? 'no answer');
      if (outcome !== 'recorded') secondary.push(`smoke verdict: ${outcome}`);
    },
    recordArtifact: async (a) => {
      const { data } = await rpc.rpc('record_build_artifact', { p_build_run_id: a.runId, p_artifact_type: a.type, p_storage_ref: a.storageRef, p_platform: a.platform, p_size_bytes: a.sizeBytes, p_distributable: a.distributable, p_limitation: a.limitation });
      const outcome = String(first(data).outcome ?? 'no answer');
      if (outcome !== 'recorded') secondary.push(`artifact record: ${outcome}`);
    },
  };
  const result = await runBuild(reportExecutor(report), plan);
  if (result.status === 'blocked') doorRefusal = result.detail;
  // a transient database error must not consume the request: the worker can send the same report again
  if (transient) return { status: 'refused', reason: 'unreadable', detail: 'the run could not be recorded just now; send the same report again' };
  await rpc.rpc('settle_build_request', { p_request_id: report.requestId, p_status: 'reported', p_detail: doorRefusal ?? `${result.status}: ${report.runUrl}` });
  if (doorRefusal) return { status: 'refused', reason: 'door_refused', detail: doorRefusal };
  return { status: 'recorded', build: result.status === 'succeeded' ? 'succeeded' : 'failed', detail: secondary.length > 0 ? `${result.detail} (not stored: ${secondary.join('; ')})` : result.detail };
}
