/**
 * The WON handoff packet, as a screen may say it — Master Plan V3 §13.4's
 * nine rows, rendered from `sales.won_handoff_packet` (G-232).
 *
 * Pure and executed. The packet is a projection over recorded facts with
 * every null stripped, so every key is optional here; what a key's absence
 * means is decided in one place, and the closed list of `unresolved` names is
 * checked against the migration by a test, so a name the database can write
 * is never one this file cannot say.
 *
 * Read-only by design: Blueprint §8 places the handoff as "Converted +
 * handoff link" with the action "Read/audit", `handoffs_write` is admin-only,
 * and nothing consumes the row while Phase 2 is not activated — which is
 * §13.4 field 8, and the banner says so.
 */

export type HandoffPacket = {
  handoff_id?: string;
  status?: string;
  recorded_at?: string;
  correlation_id?: string;
  opportunity?: { id?: string; name?: string; stage?: string; won_at?: string; owner_id?: string };
  project?: { id?: string; name?: string; status?: string; budget_minor?: number; currency?: string };
  project_deleted?: boolean;
  client?: { client_account_id?: string; lead_id?: string; contact_id?: string; language?: string; whatsapp_consent?: string };
  requirements?: { requirement_version_id?: string; status?: string }[];
  commercial?: { kind?: string; proposal_id?: string; version?: number; total_minor?: number; currency?: string; sent_at?: string; sent_message_ref?: string }[];
  decisions?: {
    kind?: string;
    approval_id?: string; state?: string; decided_at?: string; decided_by?: string; approved_by_name?: string; approved_by_role?: string;
    proposal_id?: string; responded_by_contact_id?: string; has_note?: boolean;
  }[];
  constraints?: {
    kind?: string;
    requires_payment_evidence?: string; verdict_at_handoff?: string;
    evidence?: { kind?: string; approval_id?: string; payment_id?: string; invoice_id?: string; amount_minor?: number; decided_at?: string; captured_at?: string };
    objection_ids?: string[];
  }[];
  context?: { conversation_id?: string; summary_through_seq?: number };
  unresolved?: string[];
};

/** The closed vocabulary `sales.record_won_handoff` can write — one sentence each (ADM-72: absence is visible). */
export const UNRESOLVED_SENTENCES: Record<string, string> = {
  accepted_quotation: 'No accepted quotation was found on this deal — the win was recorded without the version the client agreed to.',
  requirement_version: 'The accepted quotation was priced against no recorded requirement version.',
  requirement_version_not_accepted: 'The requirement version the quotation was priced against was never accepted by a person.',
  approval: 'No approval decision was found for the accepted quotation.',
  acceptance_actor: 'The acceptance names nobody — it was recorded without the contact who gave it.',
  contact: 'The lead has no contact, so nobody is named as the client.',
  conversation_summary: 'The conversation has no summary, so nothing says what was discussed.',
  payment_evidence: 'This organization requires payment evidence before a win, and none was found at the handoff.',
  project_proposal_differs: 'The project was raised from a different quotation version than the one the packet carries.',
  project_rebound: 'The project first bound to this handoff was deleted; the packet now follows the one raised after it.',
};

export type PacketSection = {
  key: string;
  title: string;
  lines: string[];
  absences: string[];
  links: { label: string; href: string }[];
};

export type Readiness = { title: string; tone: 'info' | 'warning' | 'danger' | 'success'; text: string };

/**
 * The banner. `queued` is the designed state — READY, NOT ACTIVATED — and
 * every other status is said as itself. Review caught the first draft
 * titling every packet 'Ready' whatever the row held.
 */
export function readiness(p: HandoffPacket): Readiness {
  const status = p.status ?? 'unknown';
  if (status === 'queued') {
    return { title: 'Ready — not activated', tone: 'info', text: 'The packet waits at queued with no receiver: the Project Manager agent is disabled (BLK-002), and that is the design.' };
  }
  if (status === 'completed' || status === 'accepted') return { title: `Handoff ${status}`, tone: 'success', text: `The handoff row is ${status}.` };
  if (status === 'rejected' || status === 'failed' || status === 'cancelled' || status === 'dead') return { title: `Handoff ${status}`, tone: 'danger', text: `The handoff row is ${status}; nothing here is ready.` };
  return { title: `Handoff ${status}`, tone: 'warning', text: `The handoff row is ${status}.` };
}

/** What the packet cannot carry because nothing records it — said in row 5 of every packet. */
export const ACCEPTANCE_EVIDENCE_NOT_RECORDED =
  'Acceptance evidence — the channel and the message reference — is not recorded: record_proposal_response does not capture it.';

const money = (minor: number | undefined, currency: string | undefined) =>
  minor === undefined ? undefined : `${currency ?? ''} ${(minor / 100).toLocaleString('en-IN')}`.trim();

/** §13.4's nine rows, each with what the packet knows and what it names as missing. */
export function packetSections(p: HandoffPacket): PacketSection[] {
  const unresolved = new Set(p.unresolved ?? []);
  const absent = (...keys: string[]) => keys.filter((k) => unresolved.has(k)).map((k) => UNRESOLVED_SENTENCES[k] ?? k);
  const approval = (p.decisions ?? []).find((d) => d.kind === 'approval');
  const acceptance = (p.decisions ?? []).find((d) => d.kind === 'acceptance');
  const gate = (p.constraints ?? []).find((c) => c.kind === 'payment_gate');
  const trust = (p.constraints ?? []).find((c) => c.kind === 'trust_concerns');
  const quote = (p.commercial ?? [])[0];

  return [
    {
      key: 'client', title: '1 · Lead and client',
      lines: [
        p.opportunity?.name ? `Deal: ${p.opportunity.name}` : 'Deal: unnamed',
        p.client?.contact_id ? `Contact ${p.client.contact_id.slice(0, 8)}${p.client.language ? ` · writes in ${p.client.language}` : ''}` : '',
        p.client?.whatsapp_consent ? `WhatsApp consent: ${p.client.whatsapp_consent}` : 'WhatsApp consent: none recorded',
        p.opportunity?.owner_id ? `Deal owner (sales): ${p.opportunity.owner_id.slice(0, 8)}` : 'No deal owner recorded',
      ].filter(Boolean),
      absences: absent('contact'),
      links: p.client?.lead_id ? [{ label: 'Open lead', href: `/leads/${p.client.lead_id}` }] : [],
    },
    {
      key: 'requirements', title: '2 · Requirements',
      lines: (p.requirements ?? []).map((r) => `Version ${r.requirement_version_id?.slice(0, 8) ?? '?'} — ${r.status ?? 'status unknown'}`),
      absences: absent('requirement_version', 'requirement_version_not_accepted'),
      links: [],
    },
    {
      key: 'commercial', title: '3 · Commercial baseline',
      lines: quote
        ? [`Quotation v${quote.version ?? '?'} — ${money(quote.total_minor, quote.currency) ?? 'no total'}${quote.sent_at ? `, sent ${quote.sent_at}` : ''}${quote.sent_message_ref ? ` (${quote.sent_message_ref})` : ''}`]
        : [],
      absences: absent('accepted_quotation', 'project_proposal_differs'),
      links: quote?.proposal_id ? [{ label: 'Quotation PDF', href: `/api/quotations/${quote.proposal_id}/pdf` }] : [],
    },
    {
      key: 'approval', title: '4 · Approval',
      lines: approval
        ? [`${approval.state ?? 'decided'}${approval.approved_by_name ? ` by ${approval.approved_by_name}` : approval.decided_by ? ` by ${approval.decided_by.slice(0, 8)}` : ''}${approval.approved_by_role ? ` (${approval.approved_by_role})` : ''}${approval.decided_at ? ` at ${approval.decided_at}` : ''}`]
        : [],
      absences: absent('approval'),
      links: [],
    },
    {
      key: 'acceptance', title: '5 · Acceptance',
      lines: [
        ...(acceptance
          ? [`Accepted${acceptance.decided_at ? ` at ${acceptance.decided_at}` : ''}${acceptance.responded_by_contact_id ? ` by contact ${acceptance.responded_by_contact_id.slice(0, 8)}` : ' — nobody named'}${acceptance.has_note ? ', with a note' : ''}`]
          : []),
        // §13.4 asks for actor, timestamp AND evidence. The third is not a
        // packet absence the row can name — record_proposal_response records
        // no channel or message reference — so it is said here, always.
        ACCEPTANCE_EVIDENCE_NOT_RECORDED,
      ],
      absences: absent('acceptance_actor'),
      links: [],
    },
    {
      key: 'payment', title: '6 · Payment or exception',
      lines: gate
        ? [
            `Payment evidence before a win: ${gate.requires_payment_evidence ?? 'off'}`,
            gate.evidence?.kind === 'payment_exception' ? `Satisfied by an approved exception ${gate.evidence.approval_id?.slice(0, 8) ?? ''}${gate.evidence.decided_at ? ` at ${gate.evidence.decided_at}` : ''}` : '',
            gate.evidence?.kind === 'captured_payment' ? `Satisfied by a captured payment ${gate.evidence.payment_id?.slice(0, 8) ?? ''}${gate.evidence.amount_minor !== undefined ? ` of ${money(gate.evidence.amount_minor, quote?.currency)}` : ''}` : '',
            gate.verdict_at_handoff ? `Gate verdict at the handoff: ${gate.verdict_at_handoff}` : '',
          ].filter(Boolean)
        : [],
      absences: absent('payment_evidence'),
      links: [],
    },
    {
      key: 'workflow', title: '7 · Workflow trace',
      lines: [
        p.recorded_at ? `Handoff recorded ${p.recorded_at}` : 'Handoff moment not recorded',
        p.opportunity?.won_at ? `Won ${p.opportunity.won_at}` : 'Win moment not recorded',
        p.project?.name ? `Project: ${p.project.name} (${p.project.status ?? 'status unknown'})` : p.project_deleted ? 'The project bound to this handoff was deleted — conversion will rebind to the next one' : 'No project yet — conversion has not run',
      ],
      absences: absent('project_rebound'),
      links: p.project?.id ? [{ label: 'Open project', href: `/projects/${p.project.id}` }] : [],
    },
    {
      key: 'next', title: '8 · Next-phase packet',
      lines: [`${readiness(p).title}. ${readiness(p).text}`],
      absences: [],
      links: [],
    },
    {
      key: 'audit', title: '9 · Audit',
      lines: [
        p.correlation_id ? `Correlation ${p.correlation_id} — the handoff row, its event and its audit rows share it` : 'No correlation id',
        trust?.objection_ids?.length ? `${trust.objection_ids.length} trust concern${trust.objection_ids.length === 1 ? '' : 's'} recorded on the lead, by reference` : 'No trust concerns recorded',
        p.context?.conversation_id ? `Thread ${p.context.conversation_id.slice(0, 8)}${p.context.summary_through_seq !== undefined ? `, summarised through message ${p.context.summary_through_seq}` : ''}` : 'No conversation on the lead',
      ],
      absences: absent('conversation_summary'),
      links: p.correlation_id ? [{ label: 'Audit log — handoff actions, every deal', href: `/audit?action=opportunity.hand` }] : [],
    },
  ];
}

/** Every unresolved name once, as a sentence — including one this file does not know, said as itself. */
export function unresolvedSentences(p: HandoffPacket): string[] {
  return [...new Set(p.unresolved ?? [])].map((k) => UNRESOLVED_SENTENCES[k] ?? `Unresolved: ${k}`);
}
