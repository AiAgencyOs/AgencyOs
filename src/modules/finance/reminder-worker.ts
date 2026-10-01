import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';
import { verifiedOn } from './verified-basis';

import {
  INVOICE_REMINDER_SITUATION_KEY,
  pickReminderThread,
  reminderMessage,
  type ReminderThreadCandidate,
} from './reminder-schema';

type Admin = ReturnType<typeof createAdminClient>;

/**
 * The past-due reminder sweep — owner decision 2026-09-29 (AGENT_BRIEF_D
 * decision 1: "past-due reminders go AUTOMATICALLY (no approval) within the
 * window and consent rules, with an approved template outside the window").
 *
 * Lives in `modules/finance` rather than beside the other sweeps in `lib/`
 * for the reason the follow-up worker gives: ARCHITECTURE §3.2 forbids
 * `lib/` depending on `modules/`, and this is policy. Run from the same cron
 * tick, right after `runFollowUps`.
 *
 * ── observe, pick, claim, queue ──────────────────────────────────────────
 *
 *   **observe**  `finance.observe_invoice_reminder_candidates`: past-due
 *                invoices in organizations that turned reminders on, with
 *                nothing sent or chased inside the interval.
 *   **pick**     which thread — the client account's own, else the
 *                project's group (`pickReminderThread`). No thread means no
 *                reminder and a row that says so; a bill is never chased on
 *                a lead's sales thread.
 *   **claim**    `finance.claim_invoice_reminder`: the invoice_sends row IS
 *                the claim, re-checked under the invoice lock, audited.
 *   **queue**    `crm.send_outbound_message` under the claim's external_ref
 *                (consent decides here, at the chokepoint), then the
 *                `followup.queued` event so `crm:deliverFollowUp` hands it to
 *                the provider with the runner's retry budget — as text inside
 *                the 24-hour window, as the approved `invoice_reminder`
 *                template outside it, and suppressed (recorded as failed)
 *                when nothing is approved. No second delivery path.
 */
export type ReminderOutcome = {
  observed: number;
  queued: number;
  /** Claimed, but nothing could go: no thread, no consent. The row says why. */
  withheld: number;
  skipped: number;
  failed: boolean;
};

export async function runInvoiceReminders(admin: Admin, limit = 50): Promise<ReminderOutcome> {
  const outcome: ReminderOutcome = { observed: 0, queued: 0, withheld: 0, skipped: 0, failed: false };

  const { data: candidates, error: observeError } = await admin
    .schema('finance')
    .rpc('observe_invoice_reminder_candidates', { p_limit: limit });
  if (observeError) {
    console.error(JSON.stringify({ level: 'error', scope: 'runInvoiceReminders.observe', detail: observeError.message }));
    return { ...outcome, failed: true };
  }

  const rows = candidates ?? [];
  outcome.observed = rows.length;
  if (rows.length === 0) return outcome;

  // The organizations' names and zones, once per tick rather than per invoice.
  const orgIds = [...new Set(rows.map((r) => r.organization_id))];
  const { data: orgs, error: orgError } = await admin.schema('core').from('organizations').select('id, name, timezone').in('id', orgIds);
  if (orgError) {
    console.error(JSON.stringify({ level: 'error', scope: 'runInvoiceReminders.organizations', detail: orgError.message }));
    return { ...outcome, failed: true };
  }
  const orgById = new Map((orgs ?? []).map((o) => [o.id, o]));

  for (const row of rows) {
    const org = orgById.get(row.organization_id);
    if (!org) {
      outcome.skipped += 1;
      continue;
    }

    // ── pick ──────────────────────────────────────────────────────────────
    const { data: threads, error: threadError } = await admin
      .schema('crm')
      .from('conversations')
      .select('id, kind, status, client_account_id, project_id, updated_at')
      .eq('organization_id', row.organization_id)
      .in('kind', ['client_account', 'project_group'])
      .or(
        [
          `client_account_id.eq.${row.client_account_id}`,
          ...(row.project_id ? [`project_id.eq.${row.project_id}`] : []),
        ].join(','),
      );
    if (threadError) {
      console.error(JSON.stringify({ level: 'error', scope: 'runInvoiceReminders.threads', invoice: row.invoice_id, detail: threadError.message }));
      outcome.failed = true;
      continue;
    }
    const thread = pickReminderThread(
      { clientAccountId: row.client_account_id, projectId: row.project_id },
      (threads ?? []).map(
        (t): ReminderThreadCandidate => ({
          conversationId: t.id,
          kind: t.kind,
          status: t.status,
          clientAccountId: t.client_account_id,
          projectId: t.project_id,
          updatedAt: t.updated_at,
        }),
      ),
    );

    // Owner decision 8 (2026-10-01): the balance the client is told is the VERIFIED one. Read before the claim, so a failed read
    // does not use up the interval.
    const { data: verifiedRow, error: verifiedError } = await admin
      .schema('finance')
      .from('invoices')
      .select('verified_minor')
      .eq('id', row.invoice_id)
      .maybeSingle();
    if (verifiedError || !verifiedRow) {
      console.error(JSON.stringify({ level: 'error', scope: 'runInvoiceReminders.verified', invoice: row.invoice_id, detail: verifiedError?.message ?? 'no row' }));
      outcome.failed = true;
      continue;
    }

    // ── claim ─────────────────────────────────────────────────────────────
    // Claimed even with no thread: the row is the record that the sweep
    // looked, and the interval keeps it from looking again tomorrow. Its
    // note says why nothing went, which is what an owner reading the
    // invoice needs to know.
    const { data: claimed, error: claimError } = await admin.schema('finance').rpc('claim_invoice_reminder', {
      p_invoice_id: row.invoice_id,
      p_interval_days: row.interval_days,
      ...(thread ? { p_conversation_id: thread.conversationId } : {}),
    });
    if (claimError) {
      console.error(JSON.stringify({ level: 'error', scope: 'runInvoiceReminders.claim', invoice: row.invoice_id, detail: claimError.message }));
      outcome.failed = true;
      continue;
    }
    const claim = (Array.isArray(claimed) ? claimed[0] : claimed) as
      | { outcome: string; send_id: string | null; external_ref: string | null }
      | undefined;
    if (!claim || claim.outcome !== 'claimed' || !claim.send_id || !claim.external_ref) {
      outcome.skipped += 1;
      continue;
    }

    if (!thread) {
      await admin.schema('finance').rpc('record_invoice_reminder_outcome', {
        p_send_id: claim.send_id,
        p_note: 'Automatic past-due reminder: not sent — this client has no WhatsApp thread of its own and the project has no group.',
      });
      outcome.withheld += 1;
      continue;
    }

    // ── queue ─────────────────────────────────────────────────────────────
    const body = reminderMessage({
      agencyName: org.name,
      invoiceNumber: row.invoice_number,
      currency: row.currency,
      totalMinor: Number(row.total_minor),
      paidMinor: verifiedOn({ total_minor: Number(row.total_minor), verified_minor: Number(verifiedRow.verified_minor) }),
      dueAt: row.due_at,
      timeZone: org.timezone ?? 'UTC',
    });

    const { data: sent, error: sendError } = await admin.schema('crm').rpc('send_outbound_message', {
      p_conversation_id: thread.conversationId,
      p_body: body,
      p_external_ref: claim.external_ref,
    });
    if (sendError) {
      console.error(JSON.stringify({ level: 'error', scope: 'runInvoiceReminders.send', invoice: row.invoice_id, detail: sendError.message }));
      await admin.schema('finance').rpc('record_invoice_reminder_outcome', {
        p_send_id: claim.send_id,
        p_note: `Automatic past-due reminder: not queued — ${sendError.message}`.slice(0, 600),
      });
      outcome.failed = true;
      continue;
    }
    const queued = (Array.isArray(sent) ? sent[0] : sent) as { outcome?: string } | undefined;
    if (queued?.outcome !== 'created' && queued?.outcome !== 'already_sent') {
      const why =
        queued?.outcome === 'no_consent'
          ? 'this contact has no recorded consent to be messaged on WhatsApp'
          : queued?.outcome === 'not_found'
            ? 'the thread no longer exists'
            : `the message was refused (${queued?.outcome ?? 'no answer'})`;
      await admin.schema('finance').rpc('record_invoice_reminder_outcome', {
        p_send_id: claim.send_id,
        p_note: `Automatic past-due reminder: not sent — ${why}.`,
      });
      outcome.withheld += 1;
      continue;
    }

    // Emitted rather than delivered inline, the way the follow-up worker does
    // it: the dispatcher keys the job on the event, the handler carries the
    // window and template rules, and the delivery inherits the runner's
    // retry budget.
    const { error: emitError } = await admin.schema('core').rpc('emit_event', {
      p_organization_id: row.organization_id,
      p_type: 'followup.queued',
      p_subject_type: 'invoice_reminder',
      p_subject_id: claim.send_id,
      p_payload: {
        conversationId: thread.conversationId,
        externalRef: claim.external_ref,
        body,
        situationKey: INVOICE_REMINDER_SITUATION_KEY,
        invoiceId: row.invoice_id,
      },
    });
    if (emitError) {
      console.error(JSON.stringify({ level: 'error', scope: 'runInvoiceReminders.emit', invoice: row.invoice_id, detail: emitError.message }));
      await admin.schema('finance').rpc('record_invoice_reminder_outcome', {
        p_send_id: claim.send_id,
        p_note: `Automatic past-due reminder: queued but not handed to the runner — ${emitError.message}`.slice(0, 600),
      });
      outcome.failed = true;
      continue;
    }

    outcome.queued += 1;
  }

  return outcome;
}
