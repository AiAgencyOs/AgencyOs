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

/** The kind every row the revision learner writes carries. */
export const REVISION_DECISION = 'revision_decision';

/**
 * What the owner CHANGED, as a sentence — G-185.
 *
 * The audit's LM-B, stated as it found it: *"owner edits are not captured as
 * structured deltas."* G-180 records the price relationship between what the
 * agent drafted and what the owner approved. It does not record **what the
 * owner did to the quotation**, and that is the part a next draft could act
 * on: an owner who adds an admin panel to every second quotation is telling
 * the agency something no price alone says.
 *
 * ── arithmetic and a set difference, again, and for the same reason ───────
 *
 * No model call. Which lines appeared, which disappeared, whether the timeline
 * moved and by how much are facts about two rows, and asking a model to
 * paraphrase them would turn each one into an opinion. `explicit` confidence
 * requires a source, and the source is the pair of quotations.
 *
 * ── what is deliberately NOT in it ───────────────────────────────────────
 *
 * No client, no lead, no conversation, and no note text. The owner's note is
 * their words to the agent about one deal; a permanent organization-scoped
 * memory quoting it would carry a particular client's circumstances into every
 * future draft. What generalises is the SHAPE of the correction, so that is
 * all this keeps.
 */
export function revisionFactFor(input: {
  decidedOn: string;
  title: string;
  added: readonly string[];
  removed: readonly string[];
  beforeMinor: number;
  afterMinor: number;
  timelineBefore: { min: number; max: number } | null;
  timelineAfter: { min: number; max: number } | null;
  exclusionsAdded: number;
}): string {
  const changes: string[] = [];

  /**
   * Capped at three, and each name capped at forty characters.
   *
   * A memory listing eleven line names is a paragraph the next prompt pays for
   * and no reader finishes; three is enough to see the pattern. The per-name
   * cap is for the same reason — a real line reads *"Customer app: signup,
   * browse restaurants, order, track delivery"*, and three of those is not a
   * sentence anybody learns from.
   */
  const short = (line: string) => (line.length <= 40 ? line : `${line.slice(0, 39).trimEnd()}…`);
  const name = (list: readonly string[]) =>
    list.length <= 3
      ? list.map((l) => `“${short(l)}”`).join(', ')
      : `${list.slice(0, 3).map((l) => `“${short(l)}”`).join(', ')} and ${list.length - 3} more`;

  if (input.added.length > 0) changes.push(`added ${name(input.added)}`);
  if (input.removed.length > 0) changes.push(`dropped ${name(input.removed)}`);

  const weeks = (t: { min: number; max: number } | null) => (t ? `${t.min}–${t.max} weeks` : null);
  const before = weeks(input.timelineBefore);
  const after = weeks(input.timelineAfter);
  if (after && before !== after) {
    changes.push(before ? `moved the timeline from ${before} to ${after}` : `set the timeline to ${after}`);
  }

  if (input.exclusionsAdded > 0) {
    changes.push(`added ${input.exclusionsAdded} exclusion${input.exclusionsAdded === 1 ? '' : 's'}`);
  }

  if (input.afterMinor !== input.beforeMinor) {
    const direction = input.afterMinor > input.beforeMinor ? 'raised' : 'reduced';
    changes.push(`${direction} the price from ${money(input.beforeMinor)} to ${money(input.afterMinor)}`);
  }

  // Sent back and returned identical is itself a decision: the owner asked for
  // something the redraft did not do, or asked for wording rather than scope.
  // Recording only the changed ones would teach that every note produces a
  // change, which is the opposite of what this is for.
  const what = changes.length > 0 ? changes.join(', ') : 'approved it unchanged';
  return `On ${input.decidedOn}, after sending a quotation back, the owner ${what} — “${input.title}”.`;
}

/**
 * `approval.decided` → record what the owner changed between two versions.
 *
 * Every refusal is a success, for the reason `learnFromDecision` states: this
 * handler produces a NOTE and owes nobody any state.
 */
export async function learnFromRevision(admin: Admin, job: LearnJob): Promise<HandlerResult> {
  const requestId = job.payload?.subjectId ?? null;
  if (!requestId) {
    return { status: 'failed', permanent: true, detail: 'approval.decided names no request' };
  }

  // The ROW, not the payload. Identical to `learnFromDecision`'s reasoning and
  // deliberately repeated rather than shared: an outbox event is insertable by
  // an org owner, and this handler writes something permanent.
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
    return { status: 'succeeded', outcome: 'not_mine', detail: `a ${request.subject_type} decision changes no quotation` };
  }
  if (request.state !== 'approved') {
    return { status: 'succeeded', outcome: 'not_approved', detail: `a ${request.state} decision is not something to learn from` };
  }

  const { data: approved, error: approvedError } = await admin
    .schema('sales')
    .from('proposals')
    .select('id, version, title, status, total_minor, opportunity_id, document, decided_at')
    .eq('id', request.subject_id)
    .eq('organization_id', job.organization_id)
    .maybeSingle();

  if (approvedError) {
    return { status: 'failed', permanent: false, detail: `could not read the quotation: ${approvedError.message}` };
  }
  if (!approved) {
    return { status: 'succeeded', outcome: 'gone', detail: 'the quotation no longer exists' };
  }
  if (approved.status !== 'approved' && approved.status !== 'sent' && approved.status !== 'accepted') {
    return {
      status: 'succeeded',
      outcome: 'not_standing',
      detail: `quotation v${approved.version} is ${approved.status}; nothing to learn from a version that no longer stands`,
    };
  }
  if (approved.version < 2) {
    return { status: 'succeeded', outcome: 'not_a_revision', detail: 'v1 revises nothing' };
  }

  const { data: previous, error: previousError } = await admin
    .schema('sales')
    .from('proposals')
    .select('id, version, total_minor, document')
    .eq('organization_id', job.organization_id)
    .eq('opportunity_id', approved.opportunity_id)
    .eq('version', approved.version - 1)
    .maybeSingle();

  if (previousError) {
    return { status: 'failed', permanent: false, detail: `could not read the previous version: ${previousError.message}` };
  }
  if (!previous) {
    return { status: 'succeeded', outcome: 'no_predecessor', detail: `v${approved.version - 1} is gone; there is nothing to compare` };
  }

  /**
   * The owner has to have SENT IT BACK, and the previous version's own
   * approval request is what says so.
   *
   * Without this the handler would record a delta every time a second version
   * exists for any reason — a client's change request (G-163), a price
   * objection redraft (G-183), an expired quotation redone. Those are the
   * CLIENT changing their mind, and filing them as the owner's corrections
   * would teach the agency to pre-empt requests its own owner never made.
   *
   * ── read by SUBJECT, not through proposals.approval_request_id ──────────
   *
   * The obvious read is the column, and the column is empty in exactly this
   * case: `sync_proposal_decision` returns a `changes_requested` proposal to
   * `draft` and clears its `approval_request_id` in the same statement. So the
   * version the owner sent back is precisely the version whose column is null,
   * and the first draft of this handler answered `not_sent_back` to every
   * genuine correction. The live verifier is what said so.
   *
   * The request rows themselves are not cleared, and `decide_approval` is the
   * only thing that can write `changes_requested` into one.
   */
  const { data: sentBack, error: sentBackError } = await admin
    .schema('approvals')
    .from('approval_requests')
    .select('id')
    .eq('organization_id', job.organization_id)
    .eq('subject_type', 'proposal')
    .eq('subject_id', previous.id)
    .eq('state', 'changes_requested')
    .limit(1);

  if (sentBackError) {
    return {
      status: 'failed',
      permanent: false,
      detail: `could not read the previous decision: ${sentBackError.message}`,
    };
  }
  if ((sentBack ?? []).length === 0) {
    return {
      status: 'succeeded',
      outcome: 'not_sent_back',
      detail: `v${previous.version} was never sent back; a second version can exist for many reasons`,
    };
  }

  // Written once per quotation, like the pricing lesson beside it.
  const { data: already, error: alreadyError } = await admin
    .schema('ai')
    .from('memory_records')
    .select('id')
    .eq('organization_id', job.organization_id)
    .eq('kind', REVISION_DECISION)
    .eq('source_id', approved.id)
    .maybeSingle();

  if (alreadyError) {
    return { status: 'failed', permanent: false, detail: `could not check what is already recorded: ${alreadyError.message}` };
  }
  if (already) {
    return { status: 'succeeded', outcome: 'already_recorded', detail: `v${approved.version} was already recorded` };
  }

  const lines = async (proposalId: string) => {
    const { data, error } = await admin
      .schema('sales')
      .from('proposal_items')
      .select('description')
      .eq('proposal_id', proposalId);
    return { names: (data ?? []).map((r) => String(r.description)), error };
  };

  const before = await lines(previous.id);
  const after = await lines(approved.id);
  if (before.error || after.error) {
    // G-054: a read that failed is not a quotation with no lines. Recording
    // "dropped everything" because a query errored would be a lie the agency
    // then learns from.
    return {
      status: 'failed',
      permanent: false,
      detail: `could not read the lines: ${(before.error ?? after.error)?.message}`,
    };
  }

  /**
   * Matched on the description, exactly — and the limit is stated rather than
   * papered over: a line the owner REWORDED reads here as one dropped and one
   * added. Fuzzy matching would be this handler inventing a judgement about
   * what counts as the same line, which is the thing every other decision in
   * it refuses to do. The sentence stays checkable by opening the two
   * quotations, which is what `explicit` confidence promises.
   */
  const beforeSet = new Set(before.names);
  const afterSet = new Set(after.names);
  const beforeDocument = parseQuotationDocument(previous.document ?? null);
  const afterDocument = parseQuotationDocument(approved.document ?? null);

  const decidedAt = request.decided_at ?? approved.decided_at ?? null;
  const timeline = (t: { min?: number; max?: number } | null | undefined) =>
    typeof t?.min === 'number' && typeof t?.max === 'number' ? { min: t.min, max: t.max } : null;

  const fact = revisionFactFor({
    decidedOn: typeof decidedAt === 'string' ? decidedAt.slice(0, 10) : 'an unrecorded date',
    title: approved.title,
    added: after.names.filter((n) => !beforeSet.has(n)),
    removed: before.names.filter((n) => !afterSet.has(n)),
    beforeMinor: previous.total_minor,
    afterMinor: approved.total_minor,
    timelineBefore: timeline(beforeDocument?.timelineWeeks),
    timelineAfter: timeline(afterDocument?.timelineWeeks),
    exclusionsAdded: Math.max(
      0,
      (afterDocument?.exclusions?.length ?? 0) - (beforeDocument?.exclusions?.length ?? 0),
    ),
  });

  const { error: writeError } = await admin.schema('ai').from('memory_records').insert({
    organization_id: job.organization_id,
    scope: 'organization',
    scope_id: null,
    kind: REVISION_DECISION,
    fact,
    confidence: 'explicit',
    source_kind: 'sales.proposal',
    source_id: approved.id,
    authored_by_agent: null,
    created_by: request.decided_by,
  });

  if (writeError) {
    return { status: 'failed', permanent: false, detail: `could not record the revision: ${writeError.message}` };
  }

  return {
    status: 'succeeded',
    outcome: 'recorded',
    detail: `recorded what the owner changed between v${previous.version} and v${approved.version}`,
  };
}
