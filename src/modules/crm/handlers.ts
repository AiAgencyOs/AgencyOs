import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import {
  approvalDecidedEventSchema,
  announcementFor,
  conversationEscalatedEventSchema,
  escalationAnnouncementFor,
  type ApprovalRequestedEvent,
} from './schema';

/**
 * Job handlers for the crm module — G-110.
 *
 * The same principal boundary `projects/handlers.ts` states: service.ts is
 * session-bound and lets RLS scope every read; a handler runs behind the
 * cron-authenticated runner on the service-role client, which bypasses RLS
 * entirely. So **every query below scopes by organization_id by hand**, and
 * the organization comes from the job row rather than from the event payload,
 * which is the untrusted part.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type HandlerResult =
  | {
      status: 'succeeded';
      /** 'announced' | 'already_announced' | 'no_group'. */
      outcome: string;
      detail: string;
    }
  | {
      status: 'failed';
      /** True when retrying cannot possibly help — the runner parks the job. */
      permanent: boolean;
      detail: string;
    };

type JobEnvelope = {
  eventId?: number;
  eventType?: string;
  subjectType?: string | null;
  subjectId?: string | null;
  event?: unknown;
};

export type AnnounceJob = {
  id: string;
  organization_id: string;
  payload: JobEnvelope | null;
  correlation_id: string | null;
};

/**
 * `approval.requested` → say so in the internal group.
 *
 * ADM-11 and docs/business-os/02-business-rules.md §5.1: the internal group is
 * where the agent brings what needs deciding. Until this existed the group was
 * a channel with nothing flowing through it and the queue lived only on a web
 * page, which is no use to an owner who is not looking at one.
 *
 * Idempotency has the same three layers the unlock handler documents, and the
 * third is again the one that matters because it holds even if the first two
 * are bypassed: `send_outbound_message` takes the caller's idempotency key,
 * and the key here is derived from the **request id** rather than from the job
 * or the event. So a re-dispatched event, a retried job and a second event for
 * the same request all collapse onto one message — which matters more here
 * than almost anywhere, because the failure mode is an owner's phone buzzing
 * repeatedly about one decision.
 *
 * An organization with no internal group is `succeeded`, not `failed`. Not
 * having set one up is an ordinary state, not an error, and retrying would
 * never fix it — the alternative is a queue slowly filling with jobs that can
 * only ever be parked.
 */
/**
 * Where internal announcements land — the channel, whoever it is.
 *
 * G-109 built this as a WhatsApp group; on the first real WABA, Meta
 * answered #131215 — this number is not eligible for Groups APIs — so
 * ADM-95 made the channel a PERSON: the owner's own WhatsApp, linked as an
 * `internal_direct` conversation. Both kinds are looked up here, and the
 * DIRECT one wins while both exist — deliberately, because on this
 * deployment a linked group is a row Meta will refuse to deliver to, and
 * an announcement that reaches a person outranks one that reaches a
 * constraint. The day Groups eligibility arrives, flipping this preference
 * is a one-line decision, made here and nowhere else.
 */
export async function internalChannel(
  admin: Admin,
  organizationId: string,
): Promise<{ channel: { id: string } | null; error: { message: string } | null }> {
  const { data, error } = await admin
    .schema('crm')
    .from('conversations')
    .select('id, kind')
    .eq('organization_id', organizationId)
    .in('kind', ['internal_direct', 'internal_group'])
    .neq('status', 'abandoned');

  if (error) return { channel: null, error };

  const rows = data ?? [];
  const direct = rows.find((r) => r.kind === 'internal_direct');
  return { channel: direct ?? rows[0] ?? null, error: null };
}

export async function handleApprovalRequested(
  admin: Admin,
  job: AnnounceJob,
): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const requestId = envelope.subjectId ?? null;

  if (!requestId) {
    return { status: 'failed', permanent: true, detail: 'approval.requested names no request' };
  }

  // ── the channel, scoped to the job's organization ───────────────────────
  const { channel: group, error: groupError } = await internalChannel(admin, job.organization_id);

  if (groupError) {
    // A read that failed is not a channel that is absent. Retryable, because
    // this is exactly the blip the retry budget exists for (D3, D5, D6).
    return {
      status: 'failed',
      permanent: false,
      detail: `could not read the internal channel: ${groupError.message}`,
    };
  }

  if (!group) {
    return {
      status: 'succeeded',
      outcome: 'no_group',
      detail: 'this organization has no internal channel; nothing was announced',
    };
  }

  /**
   * Who asked — and this is what lets the announcement carry an amount at all.
   *
   * `crm.refuse_unread_price` refuses an agency message that states a price
   * when `author_id` is null, and `announcementFor` renders
   * `event.amountMinor` as currency. So the first quotation ever submitted
   * would have raised its approval, queued this announcement, and had the row
   * **refuse it** — retrying until the job died with the owner never told.
   * Nobody had hit it because nobody had submitted a quotation.
   *
   * The fix is not an exemption. The announcement **does** have a human
   * behind it: the person who submitted the quotation, recorded on the request
   * as `requested_by_id`. Naming them satisfies the guard by being true rather
   * than by carving a hole in it — and it is the same person the audit trail
   * already points at.
   *
   * Read from the request row rather than added to the event, because the row
   * is the authority and an event shape is a second copy to keep in step. Null
   * when an agent raised it, which is exactly when a price should be refused.
   *
   * `payload` rides along on the same read for the same reason. For a
   * quotation it holds the version, the totals and the line items
   * `sales.submit_proposal` recorded, and it is what turns the announcement
   * from *a decision exists* into *here is the decision* (Document 09 §14).
   * It is passed through unparsed — `announcementFor` owns the shape, and an
   * older row without items falls back rather than failing.
   */
  const { data: request, error: requestError } = await admin
    .schema('approvals')
    .from('approval_requests')
    .select(
      'requested_by_type, requested_by_id, payload, reference, subject_type, subject_id, summary, amount_minor, required_role, sla_due_at',
    )
    .eq('id', requestId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  // A read that failed is not a request with nobody behind it. Silently
  // proceeding here would drop the amount, the rendered quotation AND the
  // PDF from the announcement — and report the job succeeded, so nothing
  // would ever retry it back to the full form.
  if (requestError) {
    return {
      status: 'failed',
      permanent: false,
      detail: `could not read the approval request: ${requestError.message}`,
    };
  }

  /**
   * A request that no longer exists cannot be announced, and nothing is wrong.
   * Checked before the row is read FROM rather than after, because every field
   * below now comes out of it.
   */
  if (!request) {
    return {
      status: 'succeeded',
      outcome: 'gone',
      detail: 'the approval request no longer exists; there is nothing to announce',
    };
  }

  /**
   * ── the announcement is built from the ROW, not from the event ───────────
   *
   * G-176, and the same doctrine `dispatchApprovedQuotation` has followed
   * since ADM-96: *the row is the authority; the payload only says which row.*
   *
   * This handler used to parse `envelope.event` and park the job **permanently
   * dead** when the parse failed. A zero-trust audit caught one in the act:
   *
   *     jobs/dead · approval.announce · attempts 1
   *     "malformed approval.requested payload: expected object, received undefined"
   *     parked dead — nothing retries this
   *
   * An `approval.requested` event is insertable over PostgREST by an org owner
   * (the PR #178 lesson), so a payload that does not parse is not evidence that
   * the approval is malformed — it is evidence that the *event* is, and the
   * approval may be perfectly real and waiting. Killing the announcement over
   * it means the owner is never told about a genuine decision, which is the
   * precise failure this gap exists to remove.
   *
   * Every field the announcement needs is on `approval_requests`, written by
   * `request_approval` under its own constraints. Reading them here makes the
   * event's payload advisory: a forged one can now at most hurry along an
   * announcement that was going to happen anyway, and a missing one costs
   * nothing at all.
   */
  const event: ApprovalRequestedEvent = {
    // `reference` is nullable in DDL — `approvals.new_reference()` fills it on
    // insert, and a row predating that would carry none. The em-dash placeholder
    // keeps the sentence readable rather than printing "null" at an owner, and
    // is only ever reachable by a row nothing in this codebase can create.
    reference: request.reference ?? '—',
    subjectType: request.subject_type,
    subjectId: request.subject_id,
    summary: request.summary,
    amountMinor: request.amount_minor,
    requiredRole: request.required_role,
    slaDueAt: request.sla_due_at,
  };

  /**
   * A person, specifically — not merely a non-null id.
   *
   * `approval_requests_requester_shape` requires an id for BOTH 'user' and
   * 'agent'; only 'system' carries none. So `requested_by_id` alone answers
   * "did anybody name themselves", not "is a person behind this" — and an
   * agent-raised request would have sailed through an id-only gate carrying
   * an agent's id into `p_author_id`, which references `core.users`. The
   * price gate's whole point is that a HUMAN stands behind a stated price.
   */
  const author = request.requested_by_type === 'user' ? request.requested_by_id : null;

  // ── the message ─────────────────────────────────────────────────────────
  // Composed ONCE, here, and used for both the row and the wire.
  //
  // The provider call below used to call `announcementFor(event)` again with
  // no arguments, so the two disagreed: the recorded message carried the
  // author's amount and this change's quotation, and the message WhatsApp
  // actually delivered carried neither. The transcript would have shown the
  // owner something they were never sent — which is worse than sending the
  // short form, because it is unfalsifiable from inside AgencyOS.
  // Always the FULL form since ADM-96 (migration 20260824120000): the
  // internal channel is exempt from the authored-price rule, because the
  // amount is exactly what the owner is being asked to decide — a system-
  // submitted quotation announced without its number would hand the owner a
  // question with the question removed. `author` still decides ATTRIBUTION:
  // a human requester's row bears their name; a system submission's bears
  // none, which is the honest record of who acted.
  const body = announcementFor(event, true, request.payload ?? null);

  /**
   * ── the second leg: the quotation as a document (brief §12, G-156) ───────
   *
   * The text above tells the owner everything §14 needs; the PDF is the form
   * they can save, forward and read at leisure — the mandate's "PDF goes to
   * Owner WhatsApp". It runs AFTER the text leg settles, under its own
   * external_ref (`approval:<id>:pdf`), so each leg is idempotent alone: a
   * retry skips whichever half already landed and finishes the other.
   *
   * Only for a quotation, and only when a person is behind the request — the
   * same `authored` gate the amount and the rendered scope sit behind. The
   * PDF states prices, and G-155's rule was that an agent-raised request
   * keeps the priceless form rather than carving a hole in
   * `crm.refuse_unread_price`'s spirit. That guard reads bodies and a
   * document row's body is empty, so this gate is the HANDLER's to hold —
   * the database cannot read a PDF (see G-156; asserting a DB refusal here
   * would be testing a guard that does not own the rule).
   *
   * Failure classes are §27's, decided by what a retry could fix:
   * a transient provider failure fails the job so the retry finishes the
   * PDF; a permanent refusal or a renderer crash records the failure and
   * answers `announced_without_pdf` — the owner has the full text quotation
   * either way, and a job that retries a deterministic crash to death would
   * un-announce nothing and tell nobody.
   */
  const finish = async (textOutcome: 'announced' | 'already_announced'): Promise<HandlerResult> => {
    // Since ADM-96 the PDF is no longer gated on a human requester — the
    // agent's own submission is precisely the case where the owner has ONLY
    // the announcement to decide from, so stripping the document there
    // stripped it exactly when it mattered most.
    if (event.subjectType !== 'proposal' || !event.subjectId) {
      return {
        status: 'succeeded',
        outcome: textOutcome,
        detail:
          textOutcome === 'already_announced'
            ? `${event.reference} was already announced`
            : `${event.reference} announced in the internal group`,
      };
    }

    const pdf = await announceQuotationPdf(admin, job, group.id, requestId, event.subjectId, author);

    // A transient PDF failure fails the JOB: the retry finds the text leg
    // already sent, skips it, and finishes this one. Nothing is lost and
    // nothing is sent twice — both legs carry their own external_ref.
    if (pdf.status === 'failed') return pdf;

    if (pdf.outcome === 'not_attached') {
      return {
        status: 'succeeded',
        outcome: 'announced_without_pdf',
        detail: `${event.reference} announced in the internal group; the PDF was not attached: ${pdf.detail}`,
      };
    }

    // Something landed this run — or, when both legs were already done on an
    // earlier attempt, nothing needed to.
    const nothingNew = pdf.outcome === 'already_sent' && textOutcome === 'already_announced';
    return {
      status: 'succeeded',
      outcome: nothingNew ? 'already_announced' : 'announced',
      detail: nothingNew
        ? `${event.reference} was already announced, quotation PDF included`
        : `${event.reference} announced in the internal group, quotation PDF attached`,
    };
  };

  const { data, error } = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: group.id,
    p_body: body,
    // Keyed on the request, deliberately — see the header.
    p_external_ref: `approval:${requestId}`,
    ...(author ? { p_author_id: author } : {}),
  });

  if (error) {
    return { status: 'failed', permanent: false, detail: `could not record: ${error.message}` };
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: 'created' | 'already_sent' | 'not_found' | 'no_consent';
        message_id: string | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
        delivery: 'pending' | 'sent' | 'failed' | null;
      }
    | undefined;

  if (!queued) {
    return { status: 'failed', permanent: false, detail: 'send_outbound_message answered nothing' };
  }

  if (queued.outcome === 'not_found') {
    // The group was read a moment ago and is gone now. Permanent: a retry
    // reads the same absence.
    return { status: 'failed', permanent: true, detail: 'the internal group no longer exists' };
  }

  // Not reachable today and handled anyway. `internal_group` is exempt from
  // consent by design — ADM-70's trap: this announcement is not a client
  // communication, and suppressing it would silently stop the owner being told
  // what needs deciding.
  //
  // If it ever *is* reached, something has changed about what this
  // conversation is, and that is permanent rather than retryable: a retry
  // reads the same answer, and looping would hide the change.
  if (queued.outcome === 'no_consent') {
    return {
      status: 'failed',
      permanent: true,
      detail:
        'the approval announcement was suppressed for consent, which should be impossible for an internal group — the conversation kind has changed',
    };
  }

  if (queued.outcome === 'already_sent' && queued.delivery === 'sent') {
    // Genuinely already announced. Only a `sent` row earns the short-circuit:
    // a `pending` or `failed` row means the provider was never reached or
    // refused, and returning success there is how a retry once reported an
    // announcement the owner never received. Those fall through and send.
    // Through `finish`, not a bare return — a retry that finds the text
    // landed may be here precisely because the PDF leg has not.
    return finish('already_announced');
  }

  if (!queued.to_phone) {
    // A group with no provider id: linked in this system and never actually
    // created or mapped on WhatsApp's side. Permanent, because retrying does
    // not link a group — somebody has to.
    await admin.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: 'the internal group has no provider id to send to',
    });
    return {
      status: 'failed',
      permanent: true,
      detail: 'the internal group has no provider id to send to',
    };
  }

  const { sendWhatsAppText } = await import('@/lib/whatsapp/send');

  const sent = await sendWhatsAppText({
    phoneNumberId: queued.from_phone_number_id ?? '',
    // The provider's group id, not a phone number — Meta's Groups API takes
    // `recipient_type: 'group'` with the group id in `to`. Both come from
    // send_outbound_message rather than being worked out here, so this handler
    // cannot get the pairing wrong.
    to: queued.to_phone,
    body,
    recipientType: queued.recipient_type ?? 'group',
  });

  const settled = await admin.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id!,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
  });

  if (settled.error) {
    // Reached the provider but could not record the outcome. Retryable so the
    // next run reconciles against the row's own delivery state.
    return { status: 'failed', permanent: false, detail: `could not record delivery: ${settled.error.message}` };
  }

  if (!sent.ok) {
    // A row that was already `sent` is terminal, so mark_outbound_delivery
    // returned false and left it alone — this attempt lost a race to a send
    // that already landed. Report success, not a failure the owner would
    // chase. Otherwise the failure stands, classified: a 4xx-not-429 is
    // permanent, everything else worth another attempt.
    if (settled.data === false) {
      return finish('already_announced');
    }
    return { status: 'failed', permanent: sent.permanent, detail: `provider: ${sent.message}` };
  }

  return finish('announced');
}

/**
 * The quotation, rendered and delivered to the internal group as a document.
 *
 * Everything is read from the rows rather than from the approval payload —
 * the payload carries what the text announcement needs, but the row is the
 * authority and the document deserves the authority: the body naming what is
 * NOT covered, the status the band is rendered from, the client it was
 * prepared for, the organization's own name and clock.
 *
 * Reads are `admin` and every one is scoped to the job's organization — this
 * runs in the job runner, one of the four sanctioned service-role call
 * sites, where hand-scoping is the tenancy boundary.
 */
/** The columns every quotation-document surface reads off `sales.proposals`. */
type QuotationRow = {
  id: string;
  version: number;
  title: string;
  body: string | null;
  status: string;
  currency: string;
  subtotal_minor: number;
  discount_minor: number | null;
  tax_minor: number;
  total_minor: number;
  valid_until: string | null;
  created_at: string;
  opportunity_id: string | null;
  /** The stored judgment sections (G-165); null on legacy quotations. */
  document?: unknown;
};

type QuotationLine = {
  description: string;
  quantity: number | string;
  amount_minor: number;
  features?: unknown;
  /** G-178 — which of the quotation's declared roles this line is for. */
  serves?: unknown;
};

/**
 * One renderer call for every place a quotation becomes a document — the
 * announcement's attachment and the approved-quotation dispatch (ADM-96) —
 * so two surfaces can never disagree about what the PDF says (G-156's
 * double-composition lesson, applied to a document).
 *
 * The failure split follows sendProposal's rule: a failed READ is the
 * database blinking and worth a retry (`unreadable`); a failed RENDER is
 * deterministic — the same rows render the same way — and retrying it to
 * death tells nobody anything (`render`, §27).
 */
async function renderQuotationDocument(
  admin: Admin,
  organizationId: string,
  proposal: QuotationRow,
  items: ReadonlyArray<QuotationLine>,
): Promise<
  | { ok: true; bytes: Uint8Array; filename: string }
  | { ok: false; kind: 'unreadable'; detail: string }
  | { ok: false; kind: 'render'; detail: string }
> {
  const { data: org, error: orgError } = await admin
    .schema('core')
    .from('organizations')
    .select('name, timezone, settings')
    .eq('id', organizationId)
    .maybeSingle();

  if (orgError || !org) {
    return {
      ok: false,
      kind: 'unreadable',
      detail: `could not read the quotation's surroundings: ${orgError?.message ?? 'no organization row'}`,
    };
  }

  // Who the quotation was prepared for, where the chain of rows records one.
  // Absent links leave it null — the renderer omits the block rather than
  // inventing a name (ADM-76).
  let preparedFor: string | null = null;
  if (proposal.opportunity_id) {
    const { data: opportunity } = await admin
      .schema('sales')
      .from('opportunities')
      .select('lead_id')
      .eq('id', proposal.opportunity_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (opportunity?.lead_id) {
      const { data: lead } = await admin
        .schema('crm')
        .from('leads')
        .select('contact_id')
        .eq('id', opportunity.lead_id)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (lead?.contact_id) {
        const { data: contact } = await admin
          .schema('crm')
          .from('contacts')
          .select('full_name, company')
          .eq('id', lead.contact_id)
          .eq('organization_id', organizationId)
          .maybeSingle();
        if (contact) {
          preparedFor = contact.company ? `${contact.full_name} — ${contact.company}` : contact.full_name;
        }
      }
    }
  }

  // Lazy for the usual reason: the renderer reads font files, and most jobs
  // through this module never touch it. The sections come through the sales
  // module's public surface (G-165) — assembled ONCE here for both the
  // owner's copy and the client's, so the two cannot disagree.
  const { renderQuotationPdf, quotationPdfFilename, quotationContactLine } = await import('@/lib/pdf/quotation');
  // From the standards LEAF on purpose: the boundary rule admits it (it is
  // not a schema/queries/actions surface), and the session-bound service —
  // whose sales-side callers use the same function via its re-export — must
  // not ride into a cron handler for one pure function.
  const { quotationSectionsFor } = await import('@/modules/sales/quotation-standards');
  // The scope in words, for the regulated-category backstop (G-167):
  // it reads the quotation's own lines rather than trusting a label.
  // Mapped once and used twice (G-168) — see the note in sales/service.ts.
  const renderItems = items.map((i) => ({
    description: i.description,
    quantity: Number(i.quantity),
    amountMinor: i.amount_minor,
    ...(Array.isArray(i.features) ? { features: i.features as string[] } : {}),
      // G-178 — and the same shape as the features above: absent stays absent,
      // so a line drafted before the column existed draws exactly as it did.
      ...(Array.isArray(i.serves) ? { serves: i.serves as string[] } : {}),
  }));
  const sections = quotationSectionsFor(proposal.total_minor, proposal.tax_minor, proposal.document ?? null, renderItems);

  try {
    const rendered = await renderQuotationPdf({
      organizationName: org.name,
      // G-171 — this is the copy a client forwards, so it is the copy that
      // most needs to say how to reach the agency.
      contactLine: quotationContactLine(org.settings),
      preparedFor,
      title: proposal.title,
      version: proposal.version,
      status: proposal.status,
      body: proposal.body,
      currency: proposal.currency,
      items: renderItems,
      // Every section, by name from the one assembler (G-167). Enumerating
      // them here meant three edits per new section and three chances to
      // forget one — the keys are already exactly the renderer's own.
      ...(sections ?? {}),
      subtotalMinor: proposal.subtotal_minor,
      discountMinor: proposal.discount_minor ?? 0,
      taxMinor: proposal.tax_minor,
      totalMinor: proposal.total_minor,
      validUntil: proposal.valid_until,
      preparedAt: proposal.created_at,
      timeZone: org.timezone ?? 'UTC',
      reference: proposal.id,
    });
    if (rendered.replacedCharacters.length > 0) {
      console.error(
        JSON.stringify({
          level: 'warn',
          scope: 'renderQuotationDocument',
          detail: `characters without glyphs replaced: ${rendered.replacedCharacters.join(' ')}`,
        }),
      );
    }
    return {
      ok: true,
      bytes: rendered.bytes,
      filename: quotationPdfFilename(proposal.title, proposal.version),
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown render failure';
    console.error(JSON.stringify({ level: 'error', scope: 'renderQuotationDocument', detail }));
    return { ok: false, kind: 'render', detail: `the renderer failed: ${detail}` };
  }
}

async function announceQuotationPdf(
  admin: Admin,
  job: AnnounceJob,
  groupId: string,
  requestId: string,
  proposalId: string,
  requestedById: string | null,
): Promise<
  | { status: 'failed'; permanent: boolean; detail: string }
  | { status: 'ok'; outcome: 'sent' | 'already_sent' | 'not_attached'; detail: string }
> {
  const { data: proposal, error: proposalError } = await admin
    .schema('sales')
    .from('proposals')
    .select(
      'id, version, title, body, status, currency, subtotal_minor, discount_minor, tax_minor, total_minor, valid_until, created_at, opportunity_id, document',
    )
    .eq('id', proposalId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  // A read that failed is not a proposal that is absent. Retryable — the
  // text leg is already settled and idempotent, so retrying is free.
  if (proposalError) {
    return { status: 'failed', permanent: false, detail: `could not read the quotation: ${proposalError.message}` };
  }
  if (!proposal) {
    // The subject of a proposal approval should be a proposal; a missing row
    // means something else deleted or re-tenanted it. Permanent for the PDF,
    // not for the announcement — the owner was told, and retrying reads the
    // same absence.
    return { status: 'ok', outcome: 'not_attached', detail: 'the quotation row no longer exists' };
  }

  const { data: items, error: itemsError } = await admin
    .schema('sales')
    .from('proposal_items')
    .select('description, quantity, amount_minor, features, serves')
    .eq('proposal_id', proposal.id)
    .eq('organization_id', job.organization_id)
    .order('position')
    .order('created_at');

  if (itemsError) {
    return {
      status: 'failed',
      permanent: false,
      detail: `could not read the quotation's lines: ${itemsError.message}`,
    };
  }

  const document = await renderQuotationDocument(admin, job.organization_id, proposal, items ?? []);

  if (!document.ok) {
    if (document.kind === 'unreadable') {
      return { status: 'failed', permanent: false, detail: document.detail };
    }
    // §27: "PDF generation fails." A renderer crash is deterministic — the
    // same rows render the same way — so retrying it to death would tell
    // nobody anything. The owner has the full text quotation; say what
    // happened and move on.
    return { status: 'ok', outcome: 'not_attached', detail: document.detail };
  }

  const { bytes, filename } = document;

  const { data, error } = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: groupId,
    p_body: '',
    p_external_ref: `approval:${requestId}:pdf`,
    // Attribution follows the requester: named when a person submitted,
    // absent when the system did (ADM-96). A document row has no body, so the
    // price rule never read it either way — this is purely the honest record.
    ...(requestedById ? { p_author_id: requestedById } : {}),
    p_media_type: 'document',
    p_media_filename: filename,
  });

  if (error) {
    return { status: 'failed', permanent: false, detail: `could not record the document: ${error.message}` };
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: 'created' | 'already_sent' | 'not_found' | 'no_consent' | 'bad_shape';
        message_id: string | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
        delivery: 'pending' | 'sent' | 'failed' | null;
      }
    | undefined;

  if (!queued) {
    return { status: 'failed', permanent: false, detail: 'send_outbound_message answered nothing for the document' };
  }
  if (queued.outcome === 'not_found') {
    return { status: 'failed', permanent: true, detail: 'the internal group no longer exists' };
  }
  if (queued.outcome === 'no_consent' || queued.outcome === 'bad_shape') {
    // Neither is reachable — the group is consent-exempt and this function
    // controls both halves of the shape. Permanent: a retry reads the same
    // answer, and looping would hide the change that made it possible.
    return { status: 'failed', permanent: true, detail: `the document row was refused as ${queued.outcome}` };
  }
  if (queued.outcome === 'already_sent' && queued.delivery === 'sent') {
    return { status: 'ok', outcome: 'already_sent', detail: 'the quotation PDF already reached the group' };
  }
  if (!queued.to_phone) {
    await admin.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: 'the internal group has no provider id to send to',
    });
    return { status: 'failed', permanent: true, detail: 'the internal group has no provider id to send to' };
  }

  const { uploadWhatsAppMedia, sendWhatsAppDocument } = await import('@/lib/whatsapp/send');

  const uploaded = await uploadWhatsAppMedia({
    phoneNumberId: queued.from_phone_number_id ?? '',
    bytes,
    mediaType: 'application/pdf',
    filename,
  });

  const sent = uploaded.ok
    ? await sendWhatsAppDocument({
        phoneNumberId: queued.from_phone_number_id ?? '',
        to: queued.to_phone,
        mediaId: uploaded.mediaId,
        filename,
        recipientType: queued.recipient_type ?? 'group',
      })
    : uploaded;

  const settled = await admin.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id!,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
  });

  if (settled.error) {
    return { status: 'failed', permanent: false, detail: `could not record the document delivery: ${settled.error.message}` };
  }

  if (!sent.ok) {
    if (settled.data === false) {
      // Lost a race to a send that already landed — the terminal `sent` row
      // refused the update, which means the document is on the owner's phone.
      return { status: 'ok', outcome: 'already_sent', detail: 'the quotation PDF already reached the group' };
    }
    if (sent.permanent) {
      // The provider said no to THIS document and a retry sends the same no.
      // The row holds the reason; the announcement stands without it.
      return { status: 'ok', outcome: 'not_attached', detail: `the provider refused it: ${sent.message}` };
    }
    return { status: 'failed', permanent: false, detail: `provider: ${sent.message}` };
  }

  return { status: 'ok', outcome: 'sent', detail: 'quotation PDF delivered to the internal group' };
}


/**
 * Hand a claimed follow-up to the provider — gap G-012, decision ADM-69.
 *
 * The worker claims the attempt and writes the message through
 * `crm.send_outbound_message`, which leaves it `pending`. This is what makes
 * it actually go.
 *
 * ── why this is a job and not an inline call in the worker ────────────────
 *
 * The worker runs inside the cron tick, which has no retry budget, no backoff
 * and no parking. The job runner has all three and already drains other
 * handlers through the same generic loop. Calling the provider inline would
 * mean a transient provider blip silently loses a follow-up, or a second retry
 * subsystem exists for the same problem.
 *
 * ── why the recipient is recomputed rather than carried ───────────────────
 *
 * `send_outbound_message` is called again with the **same** `external_ref`. It
 * answers `already_sent` and hands back the recipient *as it is now* — the
 * same idempotent path the announcer relies on. Carrying the phone number in
 * the event payload would deliver to whatever was true when the attempt was
 * claimed, which is not the same thing after a retry.
 */
export async function deliverFollowUp(admin: Admin, job: AnnounceJob): Promise<HandlerResult> {
  // The dispatcher wraps the emitted event, so the follow-up's own fields are
  // under `event` — the same envelope the announcer reads.
  const payload = (job.payload?.event ?? null) as
    | { conversationId?: string; externalRef?: string; body?: string }
    | null;
  const conversationId = payload?.conversationId;
  const externalRef = payload?.externalRef;

  if (!conversationId || !externalRef) {
    // Permanent: a payload missing its own identity is not something a retry
    // repairs, and looping on it would hide whoever wrote it.
    return { status: 'failed', permanent: true, detail: 'the follow-up job carries no conversation or reference' };
  }

  // The conversation id comes from the event PAYLOAD — the untrusted half.
  // `send_outbound_message` takes no organization and derives the tenant, the
  // sender number and the recipient from the conversation row itself, on the
  // service-role client that bypasses RLS. So a `followup.queued` event forged
  // in one organization (anyone who may write an outbox event — an owner, over
  // PostgREST) naming ANOTHER organization's conversation would send from that
  // tenant's number into that tenant's thread. Scope the conversation to the
  // JOB's organization — the trusted half, set by the dispatcher from the
  // event's own organization_id — and refuse anything not in it. The sibling
  // handlers (handleApprovalRequested, handleInvoicePaid) scope by the job org
  // for exactly this reason; this one did not.
  const { data: convo, error: convoError } = await admin
    .schema('crm')
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (convoError) {
    // A read that failed is not a conversation in the wrong tenant. Retryable.
    return { status: 'failed', permanent: false, detail: `could not read the follow-up conversation: ${convoError.message}` };
  }
  if (!convo) {
    // Absent, or in another organization. Permanent: a retry reads the same
    // answer, and looping would hide whoever pointed a job across the tenant line.
    return { status: 'failed', permanent: true, detail: 'the follow-up conversation is not in this job’s organization' };
  }

  const { data, error } = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: conversationId,
    p_body: payload?.body ?? '',
    p_external_ref: externalRef,
  });

  if (error) {
    return { status: 'failed', permanent: false, detail: `could not resolve the follow-up: ${error.message}` };
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: 'created' | 'already_sent' | 'not_found' | 'no_consent';
        message_id: string | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
        delivery: 'pending' | 'sent' | 'failed' | null;
      }
    | undefined;

  if (!queued) return { status: 'failed', permanent: false, detail: 'send_outbound_message answered nothing' };

  if (queued.outcome === 'not_found') {
    return { status: 'failed', permanent: true, detail: 'the conversation no longer exists' };
  }

  if (queued.outcome === 'no_consent') {
    // Consent was withdrawn between the claim and the delivery. Not a failure
    // and not retryable: the chokepoint is right, and the follow-up should not
    // go. ADM-70's suppression must hold at the last possible moment, not only
    // at the first.
    return { status: 'succeeded', outcome: 'suppressed', detail: 'consent was withdrawn before delivery' };
  }

  if (queued.outcome === 'already_sent' && queued.delivery === 'sent') {
    // The attempt already reached the provider — this job was reaped after the
    // send landed but before the settle, or is a duplicate. Without this branch
    // the handler fell straight through and called the provider AGAIN, and a
    // client was double-messaged on the wire. A `sent` row means stop.
    return { status: 'succeeded', outcome: 'delivered', detail: 'the follow-up was already delivered' };
  }

  if (!queued.to_phone || !queued.message_id) {
    await admin.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: 'no recipient to send to',
    });
    return { status: 'failed', permanent: true, detail: 'no recipient to send to' };
  }

  const { sendWhatsAppText } = await import('@/lib/whatsapp/send');

  const sent = await sendWhatsAppText({
    phoneNumberId: queued.from_phone_number_id ?? '',
    to: queued.to_phone,
    body: payload?.body ?? '',
    recipientType: queued.recipient_type ?? 'individual',
  });

  const settled = await admin.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
  });

  if (settled.error) {
    // The provider was reached but the outcome could not be recorded — the row
    // may be sent-but-unmarked. Retryable so the next run reconciles: the
    // derived external_ref finds the same row, and its delivery state (still
    // pending here) decides whether a resend is needed.
    return { status: 'failed', permanent: false, detail: `could not record delivery: ${settled.error.message}` };
  }

  if (!sent.ok) {
    // The row was already terminal — a concurrent attempt settled it as sent —
    // so this failure is stale and the message did land. Otherwise the failure
    // stands, classified: a bad recipient or malformed request (4xx-not-429)
    // will never send, so `permanent` parks the JOB rather than retrying to the
    // ceiling.
    if (settled.data === false) {
      return { status: 'succeeded', outcome: 'delivered', detail: 'the follow-up was already handed to the provider' };
    }
    // The SEQUENCE is deliberately left unchanged here. Stopping it on a
    // permanent send failure — so a never-delivered attempt cannot advance to a
    // false "client ignored us" escalation — was prototyped and rejected. Two
    // reasons, either fatal: (1) `sent.permanent` is any 4xx-not-429, which
    // lumps a FIXABLE deployment/window/auth fault (an expired token → 401, a
    // plain-text follow-up past WhatsApp's 24-hour window → 400) in with a
    // genuinely bad recipient — so a stop here would terminally kill live
    // sequences across every tenant during a token outage, with no un-stop path;
    // telling those apart needs Meta error-code facts (external-verification-
    // gated, like real sending). (2) Escalation is decided at CLAIM time in the
    // worker (`recordSent`), before this delivery runs, so a stop here cannot
    // prevent the final-attempt escalation anyway. The honest fix — escalate
    // only on delivered-and-unanswered attempts — belongs in the worker and is
    // blocked on those provider facts. See docs/deployment/production-readiness.md
    // (C3 caveat / P7).
    return { status: 'failed', permanent: sent.permanent, detail: `provider: ${sent.message}` };
  }

  return { status: 'succeeded', outcome: 'delivered', detail: 'the follow-up was handed to the provider' };
}

/**
 * `conversation.escalated` → say so in the internal group.
 *
 * Doc 09 §7 and §36. The agent stopping is only half an escalation; this is
 * the half that reaches a person. Written after finding that the first half
 * shipped alone — `agent_paused_at` appeared nowhere outside the migration
 * that created it, so a client was told somebody was coming and nobody was
 * told to come.
 *
 * Everything structural is `handleApprovalRequested`'s, deliberately: the same
 * internal-group lookup, the same three-layer idempotency with the key derived
 * from the **conversation** rather than from the job or the event, the same
 * treatment of an organization with no group as an ordinary state. A second
 * announcer would be a second thing to keep in step.
 */
export async function handleConversationEscalated(
  admin: Admin,
  job: AnnounceJob,
): Promise<HandlerResult> {
  const envelope = job.payload ?? {};

  const parsed = conversationEscalatedEventSchema.safeParse(envelope.event);
  if (!parsed.success) {
    return {
      status: 'failed',
      permanent: true,
      detail: `malformed conversation.escalated payload: ${parsed.error.issues[0]?.message ?? 'unparseable'}`,
    };
  }
  const event = parsed.data;

  const { channel: group, error: groupError } = await internalChannel(admin, job.organization_id);

  if (groupError) {
    return {
      status: 'failed',
      permanent: false,
      detail: `could not read the internal channel: ${groupError.message}`,
    };
  }

  if (!group) {
    return {
      status: 'succeeded',
      outcome: 'no_group',
      detail: 'this organization has no internal channel; nothing was announced',
    };
  }

  /**
   * Who is waiting, scoped by hand to the job's organization.
   *
   * Best-effort: a name that cannot be read gives "an unnamed contact" rather
   * than losing the announcement. The point of the message is that somebody is
   * waiting, and that is true whether or not their name resolves.
   */
  const { data: contact } = await admin
    .schema('crm')
    .from('conversations')
    .select('contacts(full_name, phone)')
    .eq('id', event.conversation_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  const person = (contact?.contacts ?? null) as { full_name: string | null; phone: string | null } | null;
  const who = person
    ? [person.full_name, person.phone].filter(Boolean).join(' · ') || null
    : null;

  // Composed once, used for the row AND the wire — the double-composition
  // that let a transcript disagree with a phone was G-156's lesson, and the
  // announcers stay in step about it.
  const body = escalationAnnouncementFor({ who, reason: event.reason });

  const { data, error } = await admin.schema('crm').rpc('send_outbound_message', {
    p_conversation_id: group.id,
    p_body: body,
    // Keyed on the CONVERSATION, so a redelivered event and a retried job
    // collapse onto one message. A second handover of the same thread cannot
    // happen — `hand_conversation_to_a_person` only ever sets a null column.
    p_external_ref: `escalated:${event.conversation_id}`,
  });

  if (error) {
    return { status: 'failed', permanent: false, detail: `could not record: ${error.message}` };
  }

  const queued = (Array.isArray(data) ? data[0] : data) as
    | {
        outcome: string;
        message_id: string | null;
        to_phone: string | null;
        from_phone_number_id: string | null;
        recipient_type: 'individual' | 'group' | null;
        delivery: 'pending' | 'sent' | 'failed' | null;
      }
    | undefined;

  if (!queued) {
    return { status: 'failed', permanent: false, detail: 'send_outbound_message answered nothing' };
  }

  if (queued.outcome === 'not_found') {
    return { status: 'failed', permanent: true, detail: 'the internal channel no longer exists' };
  }

  if (queued.outcome === 'no_consent') {
    return {
      status: 'failed',
      permanent: true,
      detail:
        'the escalation announcement was suppressed for consent, which should be impossible for an internal channel — the conversation kind has changed',
    };
  }

  if (queued.outcome === 'already_sent' && queued.delivery === 'sent') {
    return {
      status: 'succeeded',
      outcome: 'already_announced',
      detail: 'this conversation was already announced',
    };
  }

  /**
   * ── the wire — G-161, found by the owner on the first live handover ──────
   *
   * This handler recorded the row and answered 'announced' — and never
   * called the provider. Every proof was row-based (flow-01 §P counts the
   * message, the unit tests watch the rpc), so a phone that stayed silent
   * passed everything. The record-without-wire drift the G-156 groundwork
   * flagged as a risk on THIS function, closed the day it finally bit: the
   * agent handed a real client to a person, the row said pending, and the
   * owner's phone said nothing.
   *
   * The block below is handleApprovalRequested's, kept in step deliberately:
   * same resend-on-pending semantics, same race branch, same classification.
   */
  if (!queued.to_phone) {
    await admin.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: 'failed',
      p_error: 'the internal channel has no provider address to send to',
    });
    return {
      status: 'failed',
      permanent: true,
      detail: 'the internal channel has no provider address to send to',
    };
  }

  const { sendWhatsAppText } = await import('@/lib/whatsapp/send');

  const sent = await sendWhatsAppText({
    phoneNumberId: queued.from_phone_number_id ?? '',
    to: queued.to_phone,
    body,
    recipientType: queued.recipient_type ?? 'group',
  });

  const settled = await admin.schema('crm').rpc('mark_outbound_delivery', {
    p_message_id: queued.message_id!,
    p_status: sent.ok ? 'sent' : 'failed',
    ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
  });

  if (settled.error) {
    return { status: 'failed', permanent: false, detail: `could not record delivery: ${settled.error.message}` };
  }

  if (!sent.ok) {
    if (settled.data === false) {
      return { status: 'succeeded', outcome: 'already_announced', detail: 'this conversation was already announced' };
    }
    return { status: 'failed', permanent: sent.permanent, detail: `provider: ${sent.message}` };
  }

  return { status: 'succeeded', outcome: 'announced', detail: 'the internal channel was told' };
}

/**
 * `approval.decided` → carry the decision to the quotation, and when it is
 * an approval, SEND the quotation to the client — ADM-96, G-162.
 *
 * Until this existed, "Approve" ended with an approved row and a person still
 * had to find the Send button — reasonable when a person had typed every
 * price, absurd once the owner's whole job is the decision itself ("mai bs
 * pdf approve changes karo"). This handler is the sentence's second half:
 * approval IS the authorization to send, so the send follows the decision.
 *
 * What crosses to the client is authored with the DECIDER — the human whose
 * approval this executes — which is what lets a price-carrying message pass
 * `crm.refuse_unread_price` on a client conversation honestly: ADM-22's
 * surviving core, a human behind every price a client sees.
 *
 * The idempotency keys are deliberately THE SAME ones `sendProposal` uses —
 * `proposal:<id>:v<n>` and `:pdf` — so the manual Send button and this
 * handler collapse onto one send no matter which runs first, or twice.
 *
 * Failure classes mirror `sendProposal`, which earned them the hard way:
 * the text leg fails the JOB before anything is stamped (the quotation stays
 * `approved`, the retry re-reads the world); a transient document failure
 * fails the job BEFORE the stamp so the retry finishes the PDF; a
 * deterministic render or provider refusal of the document proceeds to the
 * stamp with the reason recorded — an approved quotation must not be
 * stranded forever behind a PDF that will never change its answer (§27).
 */
export async function dispatchApprovedQuotation(
  admin: Admin,
  job: AnnounceJob,
): Promise<HandlerResult> {
  const envelope = job.payload ?? {};
  const requestId = envelope.subjectId ?? null;

  const parsed = approvalDecidedEventSchema.safeParse(envelope.event);
  if (!parsed.success) {
    return {
      status: 'failed',
      permanent: true,
      detail: `malformed approval.decided payload: ${parsed.error.issues[0]?.message ?? 'unparseable'}`,
    };
  }
  if (!requestId) {
    return { status: 'failed', permanent: true, detail: 'approval.decided names no request' };
  }

  /**
   * The ROW is the authority; the payload only says which row.
   *
   * An outbox event is insertable over PostgREST by an org owner (the PR
   * #178 lesson), so a payload's `decision` and `decidedBy` are CLAIMS. Acting
   * on them would let a forged event send a quotation nobody approved — or
   * worse, author the client message as a person who decided nothing. Read
   * from `approval_requests` instead: the state there is reachable only
   * through `decide_approval`, and `decided_by` is the actor it
   * authenticated. A forged event can at most hurry along a decision that
   * genuinely happened.
   */
  const { data: request, error: requestError } = await admin
    .schema('approvals')
    .from('approval_requests')
    .select('state, decided_by, subject_type, subject_id')
    .eq('id', requestId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (requestError) {
    return {
      status: 'failed',
      permanent: false,
      detail: `could not read the approval request: ${requestError.message}`,
    };
  }
  if (!request) {
    return {
      status: 'succeeded',
      outcome: 'gone',
      detail: 'the approval request no longer exists; nothing to dispatch',
    };
  }

  if (request.subject_type !== 'proposal' || !request.subject_id) {
    return {
      status: 'succeeded',
      outcome: 'not_mine',
      detail: `a ${request.subject_type} decision is not a quotation dispatch`,
    };
  }

  const proposalId = request.subject_id;

  if (request.state === 'pending') {
    // An event for a decision the row does not show — either a forged event,
    // or a read racing a rollback. Nothing to carry, nothing to send.
    return {
      status: 'succeeded',
      outcome: 'not_decided',
      detail: 'the request is still pending; there is no decision to carry',
    };
  }

  /**
   * Carry the decision to the proposal FIRST, whatever it was.
   * `sync_proposal_decision` reads the request row itself and is idempotent;
   * normally the UI already ran it, and running it here too means a decide
   * whose caller died between the decide and the carry still converges
   * (G-161's family: the record proved, the consequence assumed).
   */
  const carried = await admin
    .schema('sales')
    .rpc('sync_proposal_decision', { p_proposal_id: proposalId });
  if (carried.error) {
    return {
      status: 'failed',
      permanent: false,
      detail: `could not carry the decision to the quotation: ${carried.error.message}`,
    };
  }

  if (request.state !== 'approved') {
    return {
      status: 'succeeded',
      outcome: 'carried',
      detail: `carried the ${request.state} decision to the quotation; nothing to send`,
    };
  }

  const decidedBy = request.decided_by;
  if (!decidedBy) {
    // Approved with no decider on the row should be unrepresentable
    // (approval_requests_decision_shape) — but a send authored by nobody is
    // exactly what the price rule exists to refuse, so it is never attempted
    // on an assertion's word.
    return {
      status: 'succeeded',
      outcome: 'no_decider',
      detail: 'the approval names no decider; the quotation stays approved for a person to send',
    };
  }

  const { data: proposal, error: proposalError } = await admin
    .schema('sales')
    .from('proposals')
    .select(
      'id, version, title, body, status, currency, subtotal_minor, discount_minor, tax_minor, total_minor, valid_until, created_at, opportunity_id, conversation_id, requirement_version_id, document',
    )
    .eq('id', proposalId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (proposalError) {
    return {
      status: 'failed',
      permanent: false,
      detail: `could not read the quotation: ${proposalError.message}`,
    };
  }
  if (!proposal) {
    return {
      status: 'succeeded',
      outcome: 'gone',
      detail: 'the quotation no longer exists; nothing to send',
    };
  }

  if (proposal.status === 'sent') {
    return {
      status: 'succeeded',
      outcome: 'already_sent',
      detail: `quotation v${proposal.version} already reached the client`,
    };
  }

  if (proposal.status !== 'approved') {
    // Superseded between the decide and this job, or pulled back to draft by
    // a later decision. The world moved; sending would fight it.
    return {
      status: 'succeeded',
      outcome: 'not_sendable',
      detail: `quotation v${proposal.version} is ${proposal.status}; nothing to dispatch`,
    };
  }

  // ── whom to send to ──────────────────────────────────────────────────────
  // The proposal's own conversation when it has one; otherwise the thread the
  // requirements were agreed in — an agent-drafted quotation has no
  // conversation stamped until it is sent, but its requirement version
  // remembers exactly where the client said yes.
  let conversationId = proposal.conversation_id;
  if (!conversationId && proposal.requirement_version_id) {
    const { data: version, error: versionError } = await admin
      .schema('crm')
      .from('requirement_versions')
      .select('conversation_id')
      .eq('id', proposal.requirement_version_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();
    if (versionError) {
      return {
        status: 'failed',
        permanent: false,
        detail: `could not read the requirements' conversation: ${versionError.message}`,
      };
    }
    conversationId = version?.conversation_id ?? null;
  }

  if (!conversationId) {
    return {
      status: 'succeeded',
      outcome: 'no_conversation',
      detail:
        'the quotation names no conversation and its requirements name none; it stays approved for a person to send',
    };
  }

  const { data: items, error: itemsError } = await admin
    .schema('sales')
    .from('proposal_items')
    .select('description, quantity, amount_minor, features, serves')
    .eq('proposal_id', proposal.id)
    .eq('organization_id', job.organization_id)
    .order('position')
    .order('created_at');

  // A read that failed is not a quotation with no lines. Sending "What it
  // covers: (nothing)" with a full total would hand the client an incomplete
  // quotation over a database blink. Refused before anything can leave.
  if (itemsError) {
    return {
      status: 'failed',
      permanent: false,
      detail: `could not read the quotation's lines: ${itemsError.message}`,
    };
  }

  // Through the sales module's public surface (ARCHITECTURE.md §3.2), and
  // lazily like the renderer below it — most jobs through this module never
  // compose a quotation. The SAME composer sendProposal uses, so the manual
  // button and this handler cannot say two different things to one client.
  const { quotationMessage } = await import('@/modules/sales/service');

  const body = quotationMessage({
    title: proposal.title,
    version: proposal.version,
    body: proposal.body,
    currency: proposal.currency,
    items: (items ?? []).map((i) => ({
      description: i.description,
      quantity: Number(i.quantity),
      amountMinor: i.amount_minor,
    })),
    subtotalMinor: proposal.subtotal_minor,
    discountMinor: proposal.discount_minor ?? 0,
    taxMinor: proposal.tax_minor,
    totalMinor: proposal.total_minor,
    validUntil: proposal.valid_until,
    // G-182 — the frozen document, so the composer reads the agent's covering
    // note out of it. Passed raw rather than parsed here: two send doors that
    // each do their own parsing are two chances to do it differently.
    document: proposal.document ?? null,
  });

  // ── the text leg ─────────────────────────────────────────────────────────
  const { data: textData, error: textError } = await admin
    .schema('crm')
    .rpc('send_outbound_message', {
      p_conversation_id: conversationId,
      p_body: body,
      p_external_ref: `proposal:${proposal.id}:v${proposal.version}`,
      // The person whose decision this executes — from the REQUEST ROW, the
      // one place `decide_approval` authenticated them. Their name is what
      // lets a priced message onto a client conversation at all.
      p_author_id: decidedBy,
    });

  if (textError) {
    return { status: 'failed', permanent: false, detail: `could not record: ${textError.message}` };
  }

  type Queued = {
    outcome: 'created' | 'already_sent' | 'not_found' | 'no_consent' | 'bad_shape';
    message_id: string | null;
    to_phone: string | null;
    from_phone_number_id: string | null;
    recipient_type: 'individual' | 'group' | null;
    delivery: 'pending' | 'sent' | 'failed' | null;
  };

  const queued = (Array.isArray(textData) ? textData[0] : textData) as Queued | undefined;

  if (!queued) {
    return { status: 'failed', permanent: false, detail: 'send_outbound_message answered nothing' };
  }
  if (queued.outcome === 'not_found') {
    return { status: 'failed', permanent: true, detail: 'the conversation no longer exists' };
  }
  if (queued.outcome === 'no_consent') {
    // ADM-70 wins, and this is a success of the rule rather than a failure of
    // the job: the quotation stays approved, nothing was sent, and the reason
    // is recorded where a person will read it.
    return {
      status: 'succeeded',
      outcome: 'suppressed_no_consent',
      detail:
        'the client has not consented to WhatsApp, so nothing was sent; the quotation stays approved for a person to handle',
    };
  }

  const textRef = queued.message_id;

  // Skipped entirely when a prior attempt already delivered the text — only a
  // `sent` row earns the short-circuit; a pending or failed one sends again.
  if (!(queued.outcome === 'already_sent' && queued.delivery === 'sent')) {
    if (!queued.to_phone) {
      await admin.schema('crm').rpc('mark_outbound_delivery', {
        p_message_id: queued.message_id!,
        p_status: 'failed',
        p_error: 'the conversation has no phone to send to',
      });
      return {
        status: 'failed',
        permanent: true,
        detail: 'the conversation has no phone to send to',
      };
    }

    const { sendWhatsAppText } = await import('@/lib/whatsapp/send');

    const sent = await sendWhatsAppText({
      phoneNumberId: queued.from_phone_number_id ?? '',
      to: queued.to_phone,
      body,
      recipientType: queued.recipient_type ?? 'individual',
    });

    const settled = await admin.schema('crm').rpc('mark_outbound_delivery', {
      p_message_id: queued.message_id!,
      p_status: sent.ok ? 'sent' : 'failed',
      ...(sent.ok ? { p_provider_ref: sent.providerRef } : { p_error: sent.message }),
    });

    if (settled.error) {
      return {
        status: 'failed',
        permanent: false,
        detail: `could not record delivery: ${settled.error.message}`,
      };
    }

    // A refusal whose row was already settled `sent` lost a race to a send
    // that landed — the text is on the client's phone, so the leg falls
    // through like a success. Any other refusal stamps nothing: the
    // quotation stays `approved` and sendable, by hand or by this retry.
    if (!sent.ok && settled.data !== false) {
      return { status: 'failed', permanent: sent.permanent, detail: `provider: ${sent.message}` };
    }
  }

  // ── the document leg (brief §12, G-156) ──────────────────────────────────
  let pdfDelivered = false;
  let pdfNote: string | null = null;

  const document = await renderQuotationDocument(admin, job.organization_id, proposal, items ?? []);

  if (!document.ok && document.kind === 'unreadable') {
    // Before the stamp on purpose: the retry finds the text already sent,
    // skips it, and finishes the document.
    return { status: 'failed', permanent: false, detail: document.detail };
  }

  if (!document.ok) {
    pdfNote = document.detail;
  } else {
    const { data: docData, error: docError } = await admin
      .schema('crm')
      .rpc('send_outbound_message', {
        p_conversation_id: conversationId,
        p_body: '',
        p_external_ref: `proposal:${proposal.id}:v${proposal.version}:pdf`,
        p_author_id: decidedBy,
        p_media_type: 'document',
        p_media_filename: document.filename,
      });

    if (docError) {
      return {
        status: 'failed',
        permanent: false,
        detail: `could not record the document: ${docError.message}`,
      };
    }

    const doc = (Array.isArray(docData) ? docData[0] : docData) as Queued | undefined;

    if (!doc) {
      return {
        status: 'failed',
        permanent: false,
        detail: 'send_outbound_message answered nothing for the document',
      };
    }

    if (doc.outcome === 'not_found') {
      return { status: 'failed', permanent: true, detail: 'the conversation no longer exists' };
    }
    if (doc.outcome === 'bad_shape') {
      // This function controls both halves of the shape; reaching here is a
      // bug, and looping would hide it.
      return { status: 'failed', permanent: true, detail: 'the document row was refused as bad_shape' };
    }
    if (doc.outcome === 'no_consent') {
      // Withdrawn BETWEEN the legs. ADM-70 wins on purpose; the text already
      // delivered is the honest record of a send interrupted by a withdrawal
      // (sendProposal accepts the same edge, in the same words).
      pdfNote = 'consent was withdrawn between the text and the document';
    } else if (doc.outcome === 'already_sent' && doc.delivery === 'sent') {
      pdfDelivered = true;
    } else if (!doc.to_phone) {
      await admin.schema('crm').rpc('mark_outbound_delivery', {
        p_message_id: doc.message_id!,
        p_status: 'failed',
        p_error: 'the conversation has no phone to send to',
      });
      pdfNote = 'the conversation has no phone to send the document to';
    } else {
      const { uploadWhatsAppMedia, sendWhatsAppDocument } = await import('@/lib/whatsapp/send');

      const uploaded = await uploadWhatsAppMedia({
        phoneNumberId: doc.from_phone_number_id ?? '',
        bytes: document.bytes,
        mediaType: 'application/pdf',
        filename: document.filename,
      });

      const sentDoc = uploaded.ok
        ? await sendWhatsAppDocument({
            phoneNumberId: doc.from_phone_number_id ?? '',
            to: doc.to_phone,
            mediaId: uploaded.mediaId,
            filename: document.filename,
            recipientType: doc.recipient_type ?? 'individual',
          })
        : uploaded;

      const settledDoc = await admin.schema('crm').rpc('mark_outbound_delivery', {
        p_message_id: doc.message_id!,
        p_status: sentDoc.ok ? 'sent' : 'failed',
        ...(sentDoc.ok ? { p_provider_ref: sentDoc.providerRef } : { p_error: sentDoc.message }),
      });

      if (settledDoc.error) {
        return {
          status: 'failed',
          permanent: false,
          detail: `could not record the document delivery: ${settledDoc.error.message}`,
        };
      }

      if (!sentDoc.ok) {
        if (settledDoc.data === false) {
          pdfDelivered = true;
        } else if (sentDoc.permanent) {
          // The provider said no to THIS document and a retry sends the same
          // no. The row holds the reason; the stamp proceeds without it.
          pdfNote = `the provider refused the document: ${sentDoc.message}`;
        } else {
          // Transient, and deliberately BEFORE the stamp: the quotation stays
          // approved, and the retry's text leg short-circuits on already_sent
          // while this one finishes.
          return { status: 'failed', permanent: false, detail: `provider: ${sentDoc.message}` };
        }
      } else {
        pdfDelivered = true;
      }
    }
  }

  // ── the stamp ────────────────────────────────────────────────────────────
  const { data: stampData, error: stampError } = await admin
    .schema('sales')
    .rpc('send_proposal', {
      p_proposal_id: proposal.id,
      p_conversation_id: conversationId,
      ...(textRef ? { p_message_ref: textRef } : {}),
    });

  if (stampError) {
    return {
      status: 'failed',
      permanent: false,
      detail: `sent, but could not stamp the quotation: ${stampError.message}`,
    };
  }

  const stamp = (Array.isArray(stampData) ? stampData[0] : stampData) as
    | { outcome: string; status: string | null; sent_at: string | null }
    | undefined;

  if (!stamp) {
    return { status: 'failed', permanent: false, detail: 'send_proposal answered nothing' };
  }

  if (stamp.outcome === 'not_found') {
    return { status: 'failed', permanent: true, detail: 'the quotation vanished before the stamp' };
  }

  if (stamp.outcome === 'not_approved') {
    // The message went and the stamp refused — the world moved between the
    // legs (a person superseded or re-decided). Said rather than retried:
    // the transcript records what was sent, and a retry reads the same no.
    return {
      status: 'succeeded',
      outcome: 'sent_unstamped',
      detail: `the quotation reached the client but was ${stamp.status ?? 'moved'} before the stamp; the transcript holds the record`,
    };
  }

  const pdfClause = pdfDelivered
    ? 'with its PDF'
    : `without its PDF (${pdfNote ?? 'no document was produced'})`;

  return {
    status: 'succeeded',
    outcome: stamp.outcome === 'already_sent' ? 'already_sent' : 'dispatched',
    detail: `quotation v${proposal.version} sent to the client ${pdfClause}, authored by the approver`,
  };
}
