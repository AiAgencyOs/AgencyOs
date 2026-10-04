import 'server-only';

import { createHash } from 'node:crypto';

import type { createAdminClient } from '@/lib/db/admin';
import { classifyInbound, newTextOf, parseMail } from '@/lib/email/inbound-parse';
import { readUnseen, type ImapConfig, type MailHandler, type ReadResult } from '@/lib/email/imap';
import { resolveSecret } from '@/lib/secrets/resolve';

type Admin = ReturnType<typeof createAdminClient>;
type Lane = 'client' | 'outreach';

/**
 * The mailbox sweep: replies, bounces and unsubscribes that arrive on care@ and info@ become records and actions - through ONE door,
 * `crm.ingest_inbound_email`, which is idempotent per Message-ID, so reading the same mailbox twice (a crashed sweep, two overlapping
 * ticks) changes nothing.
 *
 * Only a message the door accepted is flagged \\Seen; anything that failed stays unread and is tried again next sweep. A lane is read at
 * most every few minutes (claimed in the database, so overlapping ticks log in once) and only when its mailbox is configured. Nothing
 * here sends anything: a prospect who replied is not auto-answered, a client's email is put in their thread for the agents and the
 * people who already read threads.
 */

const MIN_INTERVAL_SECONDS = 180;

export type InboundDeps = {
  read?: (cfg: ImapConfig, handle: MailHandler) => Promise<ReadResult>;
};

export type InboundSummary = { lanes: Array<{ lane: Lane; outcome: 'read' | 'skipped_recent' | 'not_configured' | 'failed'; handled?: number; detail?: string }> };

async function configFor(lane: Lane): Promise<{ cfg: ImapConfig; own: string } | null> {
  const [host, port, user, pass, from] = await Promise.all([
    resolveSecret('IMAP_HOST'),
    resolveSecret('IMAP_PORT'),
    resolveSecret(lane === 'client' ? 'SMTP_USER' : 'SMTP_OUTREACH_USER'),
    resolveSecret(lane === 'client' ? 'SMTP_PASS' : 'SMTP_OUTREACH_PASS'),
    resolveSecret(lane === 'client' ? 'EMAIL_FROM' : 'EMAIL_OUTREACH_FROM'),
  ]);
  if (!host || !user || !pass) return null;
  return { cfg: { host, port: port ? Number(port) : 993, user, pass, secure: true }, own: (from ?? user).toLowerCase().replace(/^.*<|>.*$/g, '') };
}

const idOf = (messageId: string | null, raw: string) => messageId ?? `sha256:${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;

export async function runInboundEmail(admin: Admin, deps: InboundDeps = {}): Promise<InboundSummary> {
  const summary: InboundSummary = { lanes: [] };
  const read = deps.read ?? readUnseen;
  try {
    // One mail configuration serves one organization: the oldest.
    const org = await admin.schema('core').from('organizations').select('id').order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (!org.data) return summary;
    const organizationId = org.data.id;

    for (const lane of ['client', 'outreach'] as const) {
      const conf = await configFor(lane);
      if (!conf) {
        summary.lanes.push({ lane, outcome: 'not_configured' });
        continue;
      }
      const claimed = await admin.schema('crm').rpc('claim_inbound_poll', { p_organization_id: organizationId, p_lane: lane, p_min_interval_seconds: MIN_INTERVAL_SECONDS });
      if (claimed.error || claimed.data !== true) {
        summary.lanes.push({ lane, outcome: 'skipped_recent' });
        continue;
      }

      let handled = 0;
      const result = await read(conf.cfg, async ({ raw }) => {
        const mail = parseMail(raw);
        const classified = classifyInbound(mail, lane);
        // Our own mailbox answering itself (a loop, a forwarding rule) is never a reply from somebody.
        const kind = mail.from === conf.own ? 'auto_reply' : classified.kind;
        const trimmed = newTextOf(mail.text);
        const door = await admin.schema('crm').rpc('ingest_inbound_email', {
          p_organization_id: organizationId,
          p_lane: lane,
          p_message_id: idOf(mail.messageId, raw),
          p_from: mail.from ?? '',
          p_subject: mail.subject,
          p_body: (trimmed || mail.text).slice(0, 8000),
          p_received_at: (mail.date ?? new Date()).toISOString(),
          p_kind: kind,
          p_bounced_email: (classified.bouncedEmail ?? null) as unknown as string,
        });
        if (door.error) {
          console.error(JSON.stringify({ level: 'error', scope: 'runInboundEmail', lane, detail: door.error.message }));
          return false;
        }
        const outcome = (Array.isArray(door.data) ? door.data[0] : door.data)?.outcome;
        // 'unreadable' is a message with no usable sender or id: flagged seen like any other, or it would be re-read forever.
        handled += 1;
        return outcome !== undefined;
      });

      if (result.ok) {
        await admin.schema('crm').rpc('record_inbound_poll', { p_organization_id: organizationId, p_lane: lane, p_ok: true, p_detail: '', p_handled: handled });
        summary.lanes.push({ lane, outcome: 'read', handled });
      } else {
        await admin.schema('crm').rpc('record_inbound_poll', { p_organization_id: organizationId, p_lane: lane, p_ok: false, p_detail: result.reason, p_handled: handled });
        summary.lanes.push({ lane, outcome: 'failed', detail: result.reason });
      }
    }
  } catch (cause) {
    console.error(JSON.stringify({ level: 'error', scope: 'runInboundEmail', detail: cause instanceof Error ? cause.message : String(cause) }));
  }
  return summary;
}
