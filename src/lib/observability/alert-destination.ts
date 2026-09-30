import 'server-only';

import { recordAudit } from '@/lib/audit';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { clientEnv } from '@/lib/env';
import { resolveSecret } from '@/lib/secrets/resolve';
import { err, ok, type Result } from '@/lib/result';

/**
 * Test the alert destination — SCR-067 "Alert destination". The destination
 * (`ALERT_WEBHOOK_URL`) is where a dead job or a budget refusal is told to a
 * person; until somebody has fired something at it, "set" does not mean
 * "answers". This posts one clearly labelled test payload (`test: true`,
 * severity info — never mistaken for an incident), reports exactly what the
 * endpoint said, and records the attempt in the audit trail so the readiness
 * page can show when it last happened and whether it answered. The URL itself
 * is never read back or shown.
 */

export const ALERT_TEST_ACTION = 'alert_destination.tested';

export async function testAlertDestination(): Promise<Result<{ status: number }>> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return err('FORBIDDEN', 'Only an owner or ops admin may test the alert destination.');

  if (!context.organizationId) return err('FORBIDDEN', 'No organization on this session.');

  const url = await resolveSecret('ALERT_WEBHOOK_URL');
  if (!url) return err('CONFLICT', 'No alert destination is set: place ALERT_WEBHOOK_URL in the deployment environment or store it under Security › Keys & secrets. Until then a failure is only written to the log.');

  let answered: number | null = null;
  let reason: string | null = null;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'agencyos',
        deployment: clientEnv.NEXT_PUBLIC_APP_URL,
        severity: 'info',
        test: true,
        summary: 'Test alert from AgencyOS — sent by a person from Production Readiness. This is not an incident.',
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    answered = response.status;
    if (!response.ok) reason = `the destination answered ${response.status}`;
  } catch (cause) {
    reason = `the destination did not answer: ${cause instanceof Error ? cause.message : 'unknown error'}`;
  }

  await recordAudit({
    organizationId: context.organizationId,
    action: ALERT_TEST_ACTION,
    subjectType: 'organization',
    subjectId: context.organizationId,
    after: { ok: reason === null, status: answered, ...(reason ? { reason } : {}) },
  });

  return reason === null ? ok({ status: answered ?? 200 }) : err('INTERNAL', `Test not delivered: ${reason}.`);
}

/** When the destination was last tested and whether it answered — from the audit trail, never guessed. */
export async function lastAlertTest(): Promise<{ at: string; ok: boolean; reason: string | null } | null> {
  const { readAuditPage } = await import('@/lib/audit/queries');
  const { entries } = await readAuditPage({ actions: [ALERT_TEST_ACTION], pageSize: 1 });
  const e = entries[0];
  if (!e) return null;
  return { at: e.createdAt, ok: e.after?.ok === true, reason: typeof e.after?.reason === 'string' ? e.after.reason : null };
}
