import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { clientEnv, serverEnv } from '@/lib/env';

import { alertPayload, isHealthy, signatureOf, type BacklogRow } from './backlog';

/**
 * Telling somebody.
 *
 * Gap G-053. Until this existed the system knew when a job was dead and said
 * so to `console.error`, in a log nobody reads at two in the morning. The
 * knowing was never the missing part.
 *
 * Three rules, all of them about not becoming noise:
 *
 *   The database decides whether to send. `core.claim_alert` compares the
 *   situation's fingerprint and the cooldown in one statement, so two
 *   overlapping cron ticks cannot both send the same message — the
 *   read-decide-write shape, in the one place where a duplicate is a person
 *   being interrupted twice.
 *
 *   An unset webhook is logged, not swallowed. A deployment with no alerting
 *   configured says so once per situation, at error level, rather than
 *   quietly discovering nothing.
 *
 *   A failed alert never fails the tick. The cron's job is to move work; if
 *   the alert endpoint is down, the work still runs and the failure is logged.
 *   The opposite arrangement — a dead webhook stopping the job runner — turns
 *   monitoring into an outage.
 */

const ALERT_KEY = 'operational-backlog';

/** How long a persisting problem waits before it is repeated. */
const COOLDOWN_HOURS = 1;

type Admin = ReturnType<typeof createAdminClient>;

export type AlertOutcome =
  | { sent: false; reason: 'healthy' | 'suppressed' | 'unconfigured' | 'failed' }
  | { sent: true; severity: string };

function log(level: 'error' | 'warn', detail: Record<string, unknown>) {
  console.error(JSON.stringify({ level, scope: 'alertBacklog', ...detail }));
}

/**
 * Read the backlog, and tell somebody if it is worth telling.
 *
 * Called from the cron tick with a service-role client, so the backlog is the
 * whole deployment's rather than one organization's.
 */
export async function alertOnBacklog(admin: Admin): Promise<AlertOutcome> {
  const { data, error } = await admin.schema('core').rpc('operational_backlog');

  if (error) {
    // The monitoring failing is itself worth a line: a silent monitor and a
    // healthy system look identical, which is the failure G-053 is about.
    log('error', { detail: `could not read the backlog: ${error.message}` });
    return { sent: false, reason: 'failed' };
  }

  const backlog = (Array.isArray(data) ? data[0] : data) as BacklogRow | undefined;
  if (!backlog) {
    log('error', { detail: 'the backlog query returned nothing' });
    return { sent: false, reason: 'failed' };
  }

  if (isHealthy(backlog)) return { sent: false, reason: 'healthy' };

  const payload = alertPayload(backlog, clientEnv.NEXT_PUBLIC_APP_URL);

  const { data: claimed, error: claimError } = await admin
    .schema('core')
    .rpc('claim_alert', {
      p_key: ALERT_KEY,
      p_signature: signatureOf(backlog),
      p_cooldown_hours: COOLDOWN_HOURS,
    });

  if (claimError) {
    log('error', { detail: `could not claim the alert: ${claimError.message}`, summary: payload.summary });
    return { sent: false, reason: 'failed' };
  }

  if (claimed !== true) return { sent: false, reason: 'suppressed' };

  // Logged whether or not a webhook exists, so the record of what was wrong
  // does not depend on the delivery succeeding.
  log('error', { severity: payload.severity, summary: payload.summary });

  const url = serverEnv().ALERT_WEBHOOK_URL;
  if (!url) return { sent: false, reason: 'unconfigured' };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      log('error', { detail: `alert endpoint answered ${response.status}`, summary: payload.summary });
      return { sent: false, reason: 'failed' };
    }
  } catch (cause) {
    log('error', {
      detail: `alert endpoint unreachable: ${cause instanceof Error ? cause.message : 'unknown'}`,
      summary: payload.summary,
    });
    return { sent: false, reason: 'failed' };
  }

  return { sent: true, severity: payload.severity };
}
