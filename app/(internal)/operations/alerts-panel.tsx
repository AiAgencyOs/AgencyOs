'use client';

import { useActionState } from 'react';

import type { AlertRow } from '@/lib/observability/alerts';
import { IDLE_STATE } from '@/modules/identity/types';
import { Badge, FormMessage, buttonClass, inputClass } from '@/ui';

import { acknowledgeAlertAction } from './alert-actions';

/**
 * Alerts, and the person who acknowledges them — SCR-067. Every open alert
 * is a row the runner raised (a dead job, a provider over budget); the form
 * on it asks for what was done, because an acknowledgement without a reason
 * is a notification dismissed. Drawn for owner and ops_admin; the door
 * refuses everyone else and the refusal is shown as written.
 */

const TONE = { critical: 'danger', warning: 'warning', info: 'info' } as const;

function AcknowledgeForm({ alertId }: { alertId: string }) {
  const [state, action, pending] = useActionState(acknowledgeAlertAction, IDLE_STATE);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="alertId" value={alertId} />
      <input name="reason" required maxLength={500} placeholder="what was done about it" aria-label="Reason for acknowledging" className={`${inputClass} h-7 w-56 text-xs`} />
      <button type="submit" disabled={pending} className={buttonClass('secondary', 'sm')}>
        {pending ? 'Acknowledging…' : 'Acknowledge'}
      </button>
      <FormMessage status={state.status} message={state.message} className="basis-full text-xs" />
    </form>
  );
}

export type AlertView = AlertRow & { firstSeenLabel: string; lastSeenLabel: string; acknowledgedLabel: string | null };

export function AlertsPanel({ open, acknowledged, canAcknowledge }: { open: AlertView[]; acknowledged: AlertView[]; canAcknowledge: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      {open.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-sm text-muted">No alert is waiting on a person.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {open.map((a) => (
            <li key={a.id} className={`rounded-lg border px-4 py-3 text-sm ${a.severity === 'critical' ? 'border-danger/30' : 'border-line'} bg-surface`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={TONE[a.severity]} dot>
                    {a.severity}
                  </Badge>
                  <Badge tone="neutral">{a.source}</Badge>
                  <span className="font-medium">{a.summary}</span>
                </span>
                <span className="text-xs text-muted">
                  {a.occurrences > 1 ? `seen ${a.occurrences} times · first ${a.firstSeenLabel} · last ${a.lastSeenLabel}` : `raised ${a.firstSeenLabel}`}
                </span>
              </div>
              {canAcknowledge ? (
                <div className="mt-2">
                  <AcknowledgeForm alertId={a.id} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {acknowledged.length > 0 ? (
        <details className="rounded-lg border border-line bg-surface px-4 py-2 text-[13px]">
          <summary className="cursor-pointer text-muted">
            {acknowledged.length} recently acknowledged
          </summary>
          <ul className="mt-2 divide-y divide-line">
            {acknowledged.map((a) => (
              <li key={a.id} className="flex flex-col gap-0.5 py-2">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={TONE[a.severity]}>{a.severity}</Badge>
                  <span>{a.summary}</span>
                </span>
                <span className="text-xs text-muted">
                  acknowledged {a.acknowledgedLabel} by {a.acknowledgedByName ?? 'unknown'} — “{a.acknowledgeReason}”
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
