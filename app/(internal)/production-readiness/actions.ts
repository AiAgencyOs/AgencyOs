'use server';

import { revalidatePath } from 'next/cache';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { testAlertDestination } from '@/lib/observability/alert-destination';
import type { FormState } from '@/modules/identity/types';

import { verifyAiProviderAction, verifyCalendarAction, verifyFigmaAction, verifyWhatsAppAction } from '../settings/actions';

import type { VerificationResult, VerificationState } from './verification-state';

/**
 * SCR-067 "Run verification" — every live check the panel can run, one click,
 * one report. Each is the SAME door its own page uses (Meta, the AI provider,
 * Google Calendar, Figma); a check that has nothing configured is reported as
 * skipped with its own reason, never as passed. The database and scheduler
 * need no action: the page reads them live.
 */
export async function runVerificationAction(_prev: VerificationState, _formData: FormData): Promise<VerificationState> {
  const context = await requireInternal();
  if (!can(context, 'organization.settings')) return { status: 'error', message: 'Only an owner or ops admin may run verification.' };

  const idle: FormState = { status: 'idle' };
  const empty = new FormData();
  const checks: { name: string; run: () => Promise<FormState> }[] = [
    { name: 'WhatsApp / Meta', run: () => verifyWhatsAppAction(idle, empty) },
    { name: 'AI provider', run: () => verifyAiProviderAction(idle, empty) },
    { name: 'Google Calendar', run: () => verifyCalendarAction(idle, empty) },
    { name: 'Figma', run: () => verifyFigmaAction(idle, empty) },
  ];

  const results: VerificationResult[] = [];
  for (const check of checks) {
    const outcome = await check.run();
    const message = outcome.message ?? '';
    const skipped = outcome.status !== 'success' && /not configured|no .* (is )?configured|nothing to verify|nothing to check|no design reference|No Figma token/i.test(message);
    results.push({ name: check.name, status: outcome.status === 'success' ? 'ok' : skipped ? 'skipped' : 'failed', message });
  }

  revalidatePath('/production-readiness');
  revalidatePath('/integrations');
  const answered = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  return {
    status: failed > 0 ? 'error' : 'success',
    message: `${answered} answered, ${failed} failed, ${results.length - answered - failed} skipped (nothing configured to check).`,
    results,
  };
}

/** SCR-067 "Alert destination" — fire one labelled test at the destination and record that it happened. */
export async function testAlertDestinationAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const result = await testAlertDestination();
  if (!result.ok) return { status: 'error', message: result.error.message };
  revalidatePath('/production-readiness');
  return { status: 'success', message: `Delivered — the destination answered ${result.data.status}. The test is in the audit log.` };
}
