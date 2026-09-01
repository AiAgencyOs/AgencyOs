import 'server-only';

import type { createAdminClient } from '@/lib/db/admin';

import { parseQuotationDocument } from './schema';

/**
 * What the owner's decisions teach the next quotation — G-180.
 *
 * A zero-trust audit's finding, in one line: **nothing in this system learns
 * anything.** `ai.memory_records` had one writer and two readers, all of them
 * per-lead. The pricing delta G-172 records is displayed on a dashboard and
 * read by nobody else. `PRICING_KNOWLEDGE` — the only thing that behaves like
 * learning — updates the way its own docblock says: *"re-run the corpus study,
 * change the numbers here"*, which is a person, an analysis, a pull request
 * and a deploy.
 *
 * So the owner could correct the same mistake on fifty quotations and the
 * fifty-first would make it again.
 *
 * ── the rule that shapes all of this ──────────────────────────────────────
 *
 * **Only an APPROVED quotation teaches anything.** The brief is explicit:
 * unapproved drafts must not become permanent learning. That is not enforced
 * by care here — it is the first thing the handler checks, against the
 * approval request ROW rather than the event payload, because an outbox event
 * is insertable over PostgREST by an org owner and its `decision` is a claim
 * (the PR #178 lesson).
 *
 * ── why no model call ─────────────────────────────────────────────────────
 *
 * Comparing the version the agent drafted with the version the owner approved
 * is arithmetic and a set difference. Asking a model to paraphrase it would
 * turn a fact into an opinion, and the memory table grades exactly that
 * distinction: a row claiming `explicit` must name where it came from, and an
 * agent may never write one. These rows are written with no agent at all and
 * `created_by` set to the person who decided — because that is what they are.
 * A record of a human's decision, checkable by opening the quotation.
 *
 * ── what is deliberately NOT recorded ─────────────────────────────────────
 *
 * No client name, no lead, no conversation. The memory is organization-scoped
 * and describes a SHAPE and a decision about it — surfaces, depth, lane,
 * drafted price, approved price. A future draft is meant to learn how this
 * agency prices, not to be told what a particular client paid.
 */

type Admin = ReturnType<typeof createAdminClient>;

export type HandlerResult =
  | { status: 'succeeded'; outcome: string; detail: string }
  | { status: 'failed'; permanent: boolean; detail: string };

export type LearnJob = {
  id: string;
  organization_id: string;
  payload: { subjectId?: string | null } | null;
  correlation_id: string | null;
};

/** The kind every row this handler writes carries, so recall can ask for them. */
export const PRICING_DECISION = 'pricing_decision';

const money = (minor: number) => `₹${Math.round(minor / 100).toLocaleString('en-IN')}`;

/**
 * Turn one approved quotation into one sentence about how this agency prices.
 *
 * Exported for the reason the assemblers are: the sentence is the product, and
 * asserting it through a database round-trip would test the plumbing instead.
 */
export function decisionFactFor(input: {
  approvedTotalMinor: number;
  draftedTotalMinor: number | null;
  decidedOn: string;
  surfaces: number | null;
  depth: string | null;
  lane: number | null;
  title: string;
}): string {
  const shape = [
    input.surfaces === null ? null : `${input.surfaces} surface(s)`,
    input.depth,
    input.lane === null ? null : `lane ${input.lane}`,
  ]
    .filter(Boolean)
    .join(', ');
  const described = shape ? ` (${shape})` : '';

  // Approved unchanged is a decision too, and the commonest one. A memory that
  // only recorded corrections would teach the agency's mistakes and none of
  // its agreements.
  if (input.draftedTotalMinor === null || input.draftedTotalMinor === input.approvedTotalMinor) {
    return `On ${input.decidedOn} the owner approved ${money(input.approvedTotalMinor)} exactly as drafted${described} — "${input.title}".`;
  }

  const delta = input.approvedTotalMinor - input.draftedTotalMinor;
  const pct = Math.round((Math.abs(delta) / input.draftedTotalMinor) * 100);
  const direction = delta > 0 ? 'raised' : 'reduced';
  return `On ${input.decidedOn} the owner ${direction} a draft of ${money(input.draftedTotalMinor)} to ${money(input.approvedTotalMinor)} — ${pct}% ${delta > 0 ? 'up' : 'down'}${described} — "${input.title}".`;
}

/**
 * `approval.decided` → record what the owner decided about a quotation.
 *
 * Every refusal below is a success rather than a failure, and for one reason:
 * this handler produces a NOTE. There is no state it owes anybody. A job that
 * retried its way to `dead` because a quotation was cancelled would put a red
 * mark on an operations page for something that went entirely correctly.
 */
export async function learnFromDecision(admin: Admin, job: LearnJob): Promise<HandlerResult> {
  const requestId = job.payload?.subjectId ?? null;
  if (!requestId) {
    return { status: 'failed', permanent: true, detail: 'approval.decided names no request' };
  }

  // The ROW is the authority. An outbox event is insertable by an org owner,
  // so a payload claiming `approved` is a claim — and this is the one place
  // where believing it would write a permanent lesson from a draft nobody
  // approved, which is precisely what the brief forbids.
  const { data: request, error: requestError } = await admin
    .schema('approvals')
    .from('approval_requests')
    .select('state, decided_by, decided_at, subject_type, subject_id')
    .eq('id', requestId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (requestError) {
    return { status: 'failed', permanent: false, detail: `could not read the approval request: ${requestError.message}` };
  }
  if (!request) {
    return { status: 'succeeded', outcome: 'gone', detail: 'the approval request no longer exists' };
  }
  if (request.subject_type !== 'proposal' || !request.subject_id) {
    return { status: 'succeeded', outcome: 'not_mine', detail: `a ${request.subject_type} decision teaches nothing about pricing` };
  }
  if (request.state !== 'approved') {
    // Rejected and changes_requested are decisions, and deliberately not
    // lessons. A price the owner sent back is not a price they endorsed, and
    // recording it would teach the agency to repeat what it just corrected.
    return { status: 'succeeded', outcome: 'not_approved', detail: `a ${request.state} decision is not something to learn from` };
  }

  const { data: proposal, error: proposalError } = await admin
    .schema('sales')
    .from('proposals')
    .select('id, version, title, status, total_minor, opportunity_id, document, decided_at')
    .eq('id', request.subject_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (proposalError) {
    return { status: 'failed', permanent: false, detail: `could not read the quotation: ${proposalError.message}` };
  }
  if (!proposal) {
    return { status: 'succeeded', outcome: 'gone', detail: 'the quotation no longer exists' };
  }

  /**
   * The quotation must still be one the owner stands behind.
   *
   * `approved` and `sent` both are. Anything else means the world moved after
   * the decision — superseded by a later version, pulled back to draft — and a
   * lesson drawn from a version that no longer stands is a lesson about
   * nothing.
   */
  if (proposal.status !== 'approved' && proposal.status !== 'sent' && proposal.status !== 'accepted') {
    return {
      status: 'succeeded',
      outcome: 'not_standing',
      detail: `quotation v${proposal.version} is ${proposal.status}; nothing to learn from a version that no longer stands`,
    };
  }

  // Written once per quotation. The event can be re-dispatched, the job
  // retried, and `decide_approval` called again on a settled request; none of
  // them should double the weight of one decision in what the agency believes.
  const { data: already, error: alreadyError } = await admin
    .schema('ai')
    .from('memory_records')
    .select('id')
    .eq('organization_id', job.organization_id)
    .eq('kind', PRICING_DECISION)
    .eq('source_id', proposal.id)
    .maybeSingle();

  if (alreadyError) {
    return { status: 'failed', permanent: false, detail: `could not check what is already recorded: ${alreadyError.message}` };
  }
  if (already) {
    return { status: 'succeeded', outcome: 'already_recorded', detail: `v${proposal.version} was already recorded` };
  }

  /**
   * What the AGENT drafted, before the owner touched it.
   *
   * `document.pricingReference.proposedRupees` is the figure that was in front
   * of the decider (G-172), frozen on this very version — so on a quotation
   * the owner revised, this is what the agent asked for and `total_minor` is
   * what the owner settled on. Reading version 1 of the opportunity instead
   * would be reading a DIFFERENT scope: a revision usually changes the lines
   * as well as the price, and comparing prices across two scopes teaches a
   * relationship that does not exist.
   */
  const document = parseQuotationDocument(proposal.document ?? null);
  const reference = document?.pricingReference ?? null;
  const draftedRupees = typeof reference?.proposedRupees === 'number' ? reference.proposedRupees : null;

  const decidedAt = request.decided_at ?? proposal.decided_at ?? null;
  const decidedOn = typeof decidedAt === 'string' ? decidedAt.slice(0, 10) : 'an unrecorded date';

  const fact = decisionFactFor({
    approvedTotalMinor: proposal.total_minor,
    draftedTotalMinor: draftedRupees === null ? null : draftedRupees * 100,
    decidedOn,
    surfaces: typeof reference?.surfaces === 'number' ? reference.surfaces : null,
    depth: typeof reference?.depth === 'string' ? reference.depth : null,
    lane: typeof reference?.lane === 'number' ? reference.lane : null,
    title: proposal.title,
  });

  const { error: writeError } = await admin.schema('ai').from('memory_records').insert({
    organization_id: job.organization_id,
    // Organization-scoped, and `scope_id` must be null for it —
    // `memory_scope_id_matches_scope` enforces exactly that. The lesson is
    // about how this agency prices, not about the client who happened to pay.
    scope: 'organization',
    scope_id: null,
    kind: PRICING_DECISION,
    fact,
    // `explicit` because a person decided it and the row names where: the
    // quotation itself. An agent may never write this confidence
    // (`memory_agent_cannot_verify`), and no agent wrote this one.
    confidence: 'explicit',
    source_kind: 'sales.proposal',
    source_id: proposal.id,
    authored_by_agent: null,
    created_by: request.decided_by,
  });

  if (writeError) {
    return { status: 'failed', permanent: false, detail: `could not record the decision: ${writeError.message}` };
  }

  return {
    status: 'succeeded',
    outcome: 'recorded',
    detail: `recorded what the owner decided about v${proposal.version}`,
  };
}
