'use client';

import { useActionState } from 'react';

import { sendTemplateMessageAction } from '@/modules/crm/template-send-actions';
import { IDLE_STATE } from '@/modules/identity/types';
import { FormMessage, buttonClass, selectClass } from '@/ui';

/**
 * The composer's template picker — owner decision 2026-09-29 (reverses the
 * earlier decline). Only Meta-approved, active templates are listed; the
 * variables are filled server-side from recorded facts, so nothing typed
 * here reaches the client. Collapsed by default: the free-text composer
 * below is the usual door, and this is for when the 24-hour window has
 * shut and only an approved template will be carried.
 */
export function SendTemplateForm({
  conversationId,
  leadId,
  proposalId,
  templates,
  windowShut,
}: {
  conversationId: string;
  leadId: string;
  proposalId: string | null;
  templates: { id: string; label: string; parameters: string[] }[];
  windowShut: boolean;
}) {
  const [state, action, pending] = useActionState(sendTemplateMessageAction, IDLE_STATE);

  if (templates.length === 0) {
    return (
      <p className="mb-2 px-1 text-xs text-muted">
        {windowShut
          ? 'The 24-hour window has shut and no approved template is registered, so only the client writing first can reopen this thread. Register one under Settings › Communication.'
          : 'No approved WhatsApp template is registered under Settings › Communication.'}
      </p>
    );
  }

  return (
    <details className="group mb-2 rounded-lg border border-[var(--wa-divider)] bg-surface/60" open={windowShut}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] font-medium text-muted transition-colors hover:text-foreground">
        <span className="text-base leading-none transition-transform group-open:rotate-45">+</span>
        Send an approved template{windowShut ? ' — the window has shut, so this is what WhatsApp will carry' : ''}
      </summary>

      <form action={action} className="flex flex-col gap-2 border-t border-[var(--wa-divider)] p-3">
        <input type="hidden" name="conversationId" value={conversationId} />
        <input type="hidden" name="leadId" value={leadId} />
        {proposalId ? <input type="hidden" name="proposalId" value={proposalId} /> : null}

        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="template-id">
            Template
          </label>
          <select id="template-id" name="templateId" required defaultValue="" className={`${selectClass} w-auto min-w-64`}>
            <option value="" disabled>
              Choose an approved template…
            </option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {t.parameters.length > 0 ? ` · fills ${t.parameters.join(', ')}` : ''}
              </option>
            ))}
          </select>
          <button type="submit" disabled={pending} className={buttonClass('whatsapp', 'sm')}>
            {pending ? 'Sending…' : 'Send template'}
          </button>
        </div>
        <p className="text-xs text-muted">
          The words are the ones Meta approved; the variables are filled from what AgencyOS has recorded about this contact and deal. A template whose fact is missing is refused, not sent with a blank.
        </p>
        <FormMessage status={state.status} message={state.message} />
      </form>
    </details>
  );
}
