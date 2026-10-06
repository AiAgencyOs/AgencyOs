import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import type { CheckLogEntry } from './integration-check';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The service-role writer for `runIntegrationCheck`'s `log` callback: one check, one row in `projects.integration_check_log`, with the HTTP status
 * the provider answered and how long it took, through `projects.log_integration_check` (adapter-only, so only this client can write it).
 *
 * Generated database types do not know the door until `db:types` is regenerated, so the client is narrowed to the one structural shape used.
 * A refusal or an error is thrown, not swallowed: the caller (the check) has already recorded the verdict through `record_integration_check`, and a
 * log write that did not land should be visible rather than quietly missing from the error-rate panel.
 */
export function integrationCheckLogWriter(admin: Admin, connectionId: string): (entry: CheckLogEntry) => Promise<void> {
  const projects = admin.schema('projects') as unknown as { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };
  return async (entry) => {
    const { data, error } = await projects.rpc('log_integration_check', {
      p_connection_id: connectionId,
      p_class: entry.checkClass,
      p_http_status: entry.httpStatus,
      p_latency_ms: entry.latencyMs,
    });
    if (error) throw new Error(`log_integration_check did not answer: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined;
    if (row?.outcome !== 'noted') throw new Error(`log_integration_check answered ${row?.outcome ?? 'nothing'}`);
  };
}
