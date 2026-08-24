import 'server-only';

import { z } from 'zod';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';
import { markLeadConverted, sendClientDocument, sendClientMessage } from '@/modules/crm/service';
import { createProject, seedOnboarding } from '@/modules/projects/service';

import {
  addProposalItemSchema,
  convertToProjectSchema,
  createOpportunitySchema,
  draftProposalSchema,
  recordProposalResponseSchema,
  sendProposalSchema,
  setOpportunityStageSchema,
  setOpportunityTermsSchema,
  setProposalPricingSchema,
  submitProposalSchema,
  OPPORTUNITY_TRANSITIONS,
  SETTLED_OPPORTUNITY_STAGES,
  type AddProposalItemInput,
  type ConvertToProjectInput,
  type CreateOpportunityInput,
  type DraftProposalInput,
  type OpportunityStage,
  type ProposalStatus,
  type RecordProposalResponseInput,
  type SendProposalInput,
  type SetOpportunityStageInput,
  type SetOpportunityTermsInput,
  type SetProposalPricingInput,
  type SubmitProposalInput,
  quotationMessage,
} from './schema';

/**
 * Re-exported as this module's public surface (ARCHITECTURE.md §3.2): the
 * approved-quotation dispatch in crm/handlers composes the client message
 * through the same function `sendProposal` uses, so the two doors cannot say
 * different things to one client — and cross-module access goes through
 * service.ts, never a sibling's schema.
 */
import { quotationSectionsFor } from './quotation-standards';

export { quotationMessage } from './schema';

/**
 * Same door, same reason (ARCHITECTURE.md §3.2): the announce/dispatch
 * handlers assemble the quotation document's sections through the sales
 * module's public surface, so the PDF the owner approves and the PDF the
 * client receives cannot be assembled two different ways.
 */
export { quotationSectionsFor } from './quotation-standards';

/**
 * Writes for the sales module — its only public surface.
 *
 * This module owns the deal: opening it against a lead, moving it through the
 * stages, and the handoff to delivery when it is won. Cross-module work goes
 * through the other modules' service.ts (ARCHITECTURE.md §3.2) — this file
 * never touches crm or projects tables directly.
 *
 * Capabilities are reused, not invented: `lead.write` covers working a deal
 * that belongs to a lead, and `project.write` is additionally required to
 * convert, because conversion creates a project.
 */

/** Opens an opportunity against a qualified lead. */
export async function createOpportunity(
  input: CreateOpportunityInput,
): Promise<Result<{ opportunityId: string }>> {
  const parsed = createOpportunitySchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid opportunity.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to open opportunities.');
  }

  const supabase = await createClient();

  const { data: lead } = await supabase
    .schema('crm')
    .from('leads')
    .select('id, organization_id, status')
    .eq('id', parsed.data.leadId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!lead) return err('NOT_FOUND', 'Lead not found.');
  if (lead.status === 'disqualified') {
    return err('CONFLICT', 'A disqualified lead has no open deal. Reopen it first.');
  }

  // Only an OPEN deal blocks a new one — G-088, ADM-05 and ADM-42: a returning
  // client gets a new deal on their existing lead. This read had no stage
  // filter, so a lead whose only deal was lost handed that lost deal straight
  // back and the second engagement could never be opened from the application.
  // The database had already stopped forbidding it; this is what still did.
  //
  // The predicate matches `opportunities_open_lead_key` exactly, through the
  // one constant that mirrors it. Ordered as well as filtered: `limit 1` over
  // an unfiltered set was an unordered pick, which is the D22 shape.
  const { data: existing } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id')
    .eq('lead_id', lead.id)
    .not('stage', 'in', `(${SETTLED_OPPORTUNITY_STAGES.join(',')})`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return ok({ opportunityId: existing.id });

  const { data, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .insert({
      organization_id: lead.organization_id,
      lead_id: lead.id,
      name: parsed.data.name,
      stage: 'discovery',
      value_minor: parsed.data.valueMinor,
      expected_close_on: parsed.data.expectedCloseOn ?? null,
      owner_id: context.userId,
    })
    .select('id')
    .single();

  if (error || !data) {
    // Losing `opportunities_lead_key` is not a failure — it means another
    // click opened a deal on this lead while this one was working, and the
    // pre-check above simply ran too early to see it (audit D21). The answer
    // is the deal that won, which is the same answer the pre-check gives when
    // it is not racing.
    //
    // Matched on the index name rather than on the code alone: a 23505 from
    // some other constraint added later is a genuine error and must not be
    // answered with a re-read that finds nothing.
    if (error?.code === '23505' && error.message.includes('opportunities_open_lead_key')) {
      // Same filter as the pre-check, and for the same reason: the index that
      // was violated is the OPEN one, so the row it refused this insert for is
      // an open deal. Reading without the filter could answer with a settled
      // deal that had nothing to do with the conflict.
      const { data: winner, error: reReadError } = await supabase
        .schema('sales')
        .from('opportunities')
        .select('id')
        .eq('lead_id', lead.id)
        .not('stage', 'in', `(${SETTLED_OPPORTUNITY_STAGES.join(',')})`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (winner) return ok({ opportunityId: winner.id });

      // The index says a row exists and this cannot see it. Reporting success
      // would mean returning no id; reporting the conflict is the honest
      // answer, and it is retryable by hand.
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'createOpportunity',
          detail: `lost opportunities_open_lead_key but could not read the winner${
            reReadError ? `: ${reReadError.message}` : ''
          }`,
        }),
      );
      return err('CONFLICT', 'A deal was just opened on this lead. Reload to see it.');
    }

    console.error(
      JSON.stringify({ level: 'error', scope: 'createOpportunity', detail: error?.message }),
    );
    return err('INTERNAL', 'Could not open the opportunity.');
  }

  return ok({ opportunityId: data.id });
}

/** Moves a deal through the sales stages, including to won or lost. */
export async function setOpportunityStage(
  input: SetOpportunityStageInput,
): Promise<Result<{ stage: OpportunityStage }>> {
  const parsed = setOpportunityStageSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid stage change.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to move deals.');
  }

  // Doc 09 §38: "LOST requires a reason." Both halves — the one a report
  // counts and the one a person reads. `opportunities_lost_says_why` holds the
  // same rule at the row now, so a direct PostgREST write cannot settle a deal
  // with nothing recorded; this is the message somebody actually sees.
  if (parsed.data.stage === 'lost') {
    if (!parsed.data.lostReason?.trim()) {
      return err('VALIDATION', 'A lost deal needs a reason.');
    }
    if (!parsed.data.lostCategory) {
      return err('VALIDATION', 'A lost deal needs a reason you can count — pick one (Doc 09 §25).');
    }
  }

  const supabase = await createClient();

  const { data: opportunity } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id, stage, organization_id')
    .eq('id', parsed.data.opportunityId)
    .maybeSingle();

  if (!opportunity) return err('NOT_FOUND', 'Opportunity not found.');

  const from = opportunity.stage as OpportunityStage;
  const to = parsed.data.stage;

  if (from === to) return ok({ stage: to });
  if (!OPPORTUNITY_TRANSITIONS[from]?.includes(to)) {
    return err('CONFLICT', `A deal cannot move from ${from} to ${to}.`);
  }

  const terminal = to === 'won' || to === 'lost';
  /**
   * Moving out of a terminal stage — the only way a deal reopens.
   *
   * `lost → discovery` is the one arc that reaches this today; `won` is
   * terminal in OPPORTUNITY_TRANSITIONS and the transition check above refuses
   * anything leaving it. Written against "terminal" rather than against `lost`
   * so that opening `won` later is a change to the map alone, which is where
   * that rule lives.
   */
  const reopening = (from === 'won' || from === 'lost') && !terminal;

  // The predicate the decision was made against, restated in the write (audit
  // D10). Reading the state and then matching on the id alone means a
  // concurrent transition is silently overwritten — the same shape D1, D2 and
  // D4 fixed in finance, where the answer was a lock. Here a compare-and-swap
  // is enough: there is no ledger to sum, only a state to not clobber, and a
  // write that matches zero rows says the world moved.
  const { data: moved, error } = await supabase
    .schema('sales')
    .from('opportunities')
    .update({
      stage: to,
      // The table requires closed_at whenever the stage is terminal.
      ...(terminal ? { closed_at: new Date().toISOString() } : {}),
      ...(to === 'lost'
        ? {
            lost_reason: parsed.data.lostReason ?? null,
            lost_category: parsed.data.lostCategory ?? null,
          }
        : {}),
      // Cleared on the way out as well as set on the way in — gap G-089, and
      // exactly the shape D13 fixed for `disqualified_reason` on a lead.
      //
      // Both columns were only ever written when moving *to* a terminal stage,
      // so a reopened deal read as `discovery` while still carrying the date it
      // closed and the reason it was lost. `opportunities_closed_at_set` only
      // requires the date when the stage is terminal, so nothing objected —
      // and anything reporting on closed deals or on why deals are lost
      // counted a live one.
      ...(reopening ? { closed_at: null, lost_reason: null, lost_category: null } : {}),
    })
    .eq('id', opportunity.id)
    .eq('stage', from)
    .select('id')
    .maybeSingle();

  if (error) {
    // Reopening a settled deal — `lost → discovery`, or `won → discovery` —
    // can now collide with `opportunities_open_lead_key` (audit D21), because
    // the index counts open deals and reopening makes this one of them. That
    // is the index doing its job: the lead already has an open deal, and two
    // is the state D21 exists to prevent. Said in those words rather than as
    // "Could not move the deal", which tells the operator nothing they can act
    // on.
    if (error.code === '23505' && error.message.includes('opportunities_open_lead_key')) {
      return err(
        'CONFLICT',
        'This lead already has an open deal. Settle that one before reopening this.',
      );
    }
    console.error(
      JSON.stringify({ level: 'error', scope: 'setOpportunityStage', detail: error.message }),
    );
    return err('INTERNAL', 'Could not move the deal.');
  }

  if (!moved) {
    // The case that matters: a deal marked won, then overwritten as lost by a
    // caller that read it while it was still in negotiation.
    return err(
      'CONFLICT',
      'This deal was moved by somebody else while you were working. Reload and try again.',
    );
  }

  return ok({ stage: to });
}

/**
 * Turns a won deal into a client and a project — the LEAD → CLIENT WON →
 * PROJECT CREATION handoff.
 *
 * Only a won opportunity converts, and only once: the second call returns the
 * project that already exists rather than creating a duplicate, which matters
 * because a double-clicked button must not produce two projects for one deal.
 *
 * The client account is created here when the deal has none. core has no
 * module of its own to own that table (ARCHITECTURE.md §4.2 lists it under the
 * core *schema*, and §2 has no core module), and the won deal is the moment
 * the client first exists as a billable entity.
 */
export async function convertToProject(
  input: ConvertToProjectInput,
): Promise<Result<{ projectId: string; clientAccountId: string; created: boolean }>> {
  const parsed = convertToProjectSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid conversion request.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write') || !can(context.role, 'project.write')) {
    return err('FORBIDDEN', 'You do not have permission to convert deals into projects.');
  }

  const supabase = await createClient();

  const { data: opportunity } = await supabase
    .schema('sales')
    .from('opportunities')
    .select('id, name, stage, organization_id, lead_id, client_account_id, value_minor, currency')
    .eq('id', parsed.data.opportunityId)
    .maybeSingle();

  if (!opportunity) return err('NOT_FOUND', 'Opportunity not found.');
  if (opportunity.stage !== 'won') {
    return err('CONFLICT', 'Only a won deal can be converted into a project.');
  }

  // Idempotency: one project per opportunity.
  const { data: alreadyConverted } = await supabase
    .schema('projects')
    .from('projects')
    .select('id, client_account_id')
    .eq('opportunity_id', opportunity.id)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();

  if (alreadyConverted) {
    return ok({
      projectId: alreadyConverted.id,
      clientAccountId: alreadyConverted.client_account_id,
      created: false,
    });
  }

  // ── the client ──────────────────────────────────────────────────────────
  let clientAccountId = opportunity.client_account_id;

  if (!clientAccountId) {
    const { data: account, error: accountError } = await supabase
      .schema('core')
      .from('client_accounts')
      .insert({
        organization_id: opportunity.organization_id,
        name: parsed.data.clientAccountName ?? opportunity.name,
        currency: opportunity.currency,
      })
      .select('id')
      .single();

    if (accountError || !account) {
      console.error(
        JSON.stringify({ level: 'error', scope: 'convertToProject', detail: accountError?.message }),
      );
      return err('INTERNAL', 'Could not create the client account.');
    }

    clientAccountId = account.id;

    await supabase
      .schema('sales')
      .from('opportunities')
      .update({ client_account_id: clientAccountId })
      .eq('id', opportunity.id);

  }

  // ── the commercial context the client actually agreed to ────────────────
  //
  // Document 10 §1: "Accepted quotation becomes commercial project context."
  // Until G-011 there were no quotations and this could not be carried; now
  // that there are, a project raised from one keeps the reference and the
  // numbers.
  //
  // Read rather than demanded — see createProject's `proposalId` and ADM-72.
  // `maybeSingle` over an ordered read rather than a bare limit: `accepted` is
  // terminal, so a deal that was re-quoted and re-accepted has more than one,
  // and the answer is the latest.
  const { data: accepted } = await supabase
    .schema('sales')
    .from('proposals')
    .select('id, total_minor')
    .eq('opportunity_id', opportunity.id)
    .eq('status', 'accepted')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── the project ─────────────────────────────────────────────────────────
  const project = await createProject({
    organizationId: opportunity.organization_id,
    clientAccountId,
    opportunityId: opportunity.id,
    proposalId: accepted?.id ?? null,
    name: parsed.data.projectName,
    // The accepted total is what the client agreed to pay; the opportunity's
    // value is what somebody estimated when the deal was opened. When both
    // exist the agreed one wins, because that is the number every later
    // milestone and invoice is measured against.
    budgetMinor: accepted?.total_minor ?? opportunity.value_minor,
    currency: opportunity.currency,
  });

  if (!project.ok) {
    // Losing the index is not a failure — it means another click converted
    // this deal while this one was working, and the answer is the project it
    // created (audit D9). The pre-check above catches the ordinary repeat;
    // projects_opportunity_key catches the concurrent one it cannot.
    if (project.error.code === 'CONFLICT' && project.error.message.includes('already been converted')) {
      const { data: raced } = await supabase
        .schema('projects')
        .from('projects')
        .select('id, client_account_id')
        .eq('opportunity_id', opportunity.id)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();

      if (raced) {
        return ok({
          projectId: raced.id,
          clientAccountId: raced.client_account_id,
          created: false,
        });
      }
    }
    return project;
  }

  // ── the workspace the project needs to be worked in ─────────────────────
  //
  // Document 10 §5 and §6. ADM-06 says the checklist blocks nothing, so a
  // failure here does not undo the project: the project is the durable
  // outcome, an empty checklist is visibly wrong on the screen that shows it,
  // and `seedOnboarding` is idempotent, so re-running conversion repairs it.
  // Rolling back a created project over a list of reminders would be the
  // wrong trade in the other direction.
  const onboarding = await seedOnboarding(project.data.projectId);
  if (!onboarding.ok) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'convertToProject',
        detail: `project ${project.data.projectId} created but its onboarding checklist was not`,
      }),
    );
  }

  // ── close the loop on the lead ──────────────────────────────────────────
  if (opportunity.lead_id) {
    const converted = await markLeadConverted(opportunity.lead_id, context.userId);
    if (!converted.ok) {
      // The project exists and is the durable outcome; a lead left in
      // `qualified` is visibly wrong in the pipeline and can be re-run, which
      // is far better than rolling back a created project.
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'convertToProject',
          detail: `project ${project.data.projectId} created but lead ${opportunity.lead_id} not marked converted`,
        }),
      );
    }
  }

  return ok({ projectId: project.data.projectId, clientAccountId, created: true });
}

// ── quotations ─────────────────────────────────────────────────────────────
//
// G-011, ADM-07: staff draft, the owner approves, then it is sent. Document 09
// §15–§18 and §22 are the specification.
//
// Every guarantee that matters is in Postgres — version allocation under the
// opportunity's lock, the totals summed from the lines, the freeze once a
// version leaves draft, the approval gate on sending, and the refusal to treat
// delivery as acceptance. These functions validate an input, check the
// capability the matrix already publishes, and turn an outcome into a sentence
// somebody can act on. They deliberately re-check nothing: a check here would
// run before the lock, and the answer could be stale by the time it mattered.

/** What `sales.draft_proposal` hands back. */
type DraftRow = {
  outcome: 'created' | 'not_found' | 'settled';
  proposal_id: string | null;
  version: number | null;
  superseded: string | null;
};

const single = <T>(data: unknown): T | undefined =>
  (Array.isArray(data) ? data[0] : data) as T | undefined;

/**
 * Drafts the next quotation version against a deal.
 *
 * §16: drafting v2 supersedes whichever version was live, and cancels its
 * pending approval, so the owner's queue never holds a quote that can no
 * longer be sent.
 */
export async function draftProposal(
  input: DraftProposalInput,
): Promise<Result<{ proposalId: string; version: number; supersededId: string | null }>> {
  const parsed = draftProposalSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid quotation.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'proposal.draft')) {
    return err('FORBIDDEN', 'You do not have permission to draft quotations.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('draft_proposal', {
    p_opportunity_id: parsed.data.opportunityId,
    p_title: parsed.data.title,
    p_created_by: context.userId,
    ...(parsed.data.body ? { p_body: parsed.data.body } : {}),
    ...(parsed.data.validUntil ? { p_valid_until: parsed.data.validUntil } : {}),
    ...(parsed.data.requirementVersionId
      ? { p_requirement_version_id: parsed.data.requirementVersionId }
      : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'draftProposal', detail: error.message }));
    return err('INTERNAL', 'Could not draft the quotation.');
  }

  const row = single<DraftRow>(data);
  if (!row) return err('INTERNAL', 'Could not draft the quotation.');

  switch (row.outcome) {
    case 'created':
      if (!row.proposal_id || row.version === null) {
        return err('INTERNAL', 'Could not draft the quotation.');
      }
      return ok({
        proposalId: row.proposal_id,
        version: row.version,
        supersededId: row.superseded,
      });

    case 'not_found':
      return err('NOT_FOUND', 'Opportunity not found.');

    case 'settled':
      return err('CONFLICT', 'This deal is closed. A settled deal takes no new quotations.');

    default:
      return err('INTERNAL', 'Could not draft the quotation.');
  }
}

type ItemRow = {
  outcome: 'added' | 'not_found' | 'not_draft';
  item_id: string | null;
  subtotal_minor: number | null;
  total_minor: number | null;
};

/** Adds a line to a draft quotation. The totals come back recomputed. */
export async function addProposalItem(
  input: AddProposalItemInput,
): Promise<Result<{ itemId: string; subtotalMinor: number; totalMinor: number }>> {
  const parsed = addProposalItemSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid line item.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'proposal.draft')) {
    return err('FORBIDDEN', 'You do not have permission to edit quotations.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('add_proposal_item', {
    p_proposal_id: parsed.data.proposalId,
    p_description: parsed.data.description,
    p_quantity: parsed.data.quantity,
    p_unit_price_minor: parsed.data.unitPriceMinor,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'addProposalItem', detail: error.message }));
    return err('INTERNAL', 'Could not add the line.');
  }

  const row = single<ItemRow>(data);
  if (!row) return err('INTERNAL', 'Could not add the line.');

  switch (row.outcome) {
    case 'added':
      if (!row.item_id) return err('INTERNAL', 'Could not add the line.');
      return ok({
        itemId: row.item_id,
        subtotalMinor: row.subtotal_minor ?? 0,
        totalMinor: row.total_minor ?? 0,
      });

    case 'not_found':
      return err('NOT_FOUND', 'Quotation not found.');

    // The freeze §16 requires. Said as what to do next rather than as a
    // refusal, because the answer is always the same one.
    case 'not_draft':
      return err(
        'CONFLICT',
        'This version is no longer a draft. Draft the next version to change what it says.',
      );

    default:
      return err('INTERNAL', 'Could not add the line.');
  }
}

type PricingRow = {
  outcome: 'priced' | 'not_found' | 'not_draft' | 'discount_exceeds_subtotal';
  subtotal_minor: number | null;
  discount_minor: number | null;
  tax_minor: number | null;
  total_minor: number | null;
};

/** Sets the discount and tax on a draft quotation (§15). */
export async function setProposalPricing(
  input: SetProposalPricingInput,
): Promise<Result<{ subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number }>> {
  const parsed = setProposalPricingSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid pricing.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'proposal.draft')) {
    return err('FORBIDDEN', 'You do not have permission to price quotations.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('set_proposal_pricing', {
    p_proposal_id: parsed.data.proposalId,
    ...(parsed.data.discountMinor !== undefined ? { p_discount_minor: parsed.data.discountMinor } : {}),
    ...(parsed.data.taxMinor !== undefined ? { p_tax_minor: parsed.data.taxMinor } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setProposalPricing', detail: error.message }));
    return err('INTERNAL', 'Could not price the quotation.');
  }

  const row = single<PricingRow>(data);
  if (!row) return err('INTERNAL', 'Could not price the quotation.');

  switch (row.outcome) {
    case 'priced':
      return ok({
        subtotalMinor: row.subtotal_minor ?? 0,
        discountMinor: row.discount_minor ?? 0,
        taxMinor: row.tax_minor ?? 0,
        totalMinor: row.total_minor ?? 0,
      });

    case 'not_found':
      return err('NOT_FOUND', 'Quotation not found.');

    case 'not_draft':
      return err(
        'CONFLICT',
        'This version is no longer a draft. Draft the next version to change its price.',
      );

    case 'discount_exceeds_subtotal':
      return err('VALIDATION', 'The discount is larger than the work it applies to.', {
        details: { discountMinor: ['A discount cannot exceed the subtotal.'] },
      });

    default:
      return err('INTERNAL', 'Could not price the quotation.');
  }
}

type SubmitRow = {
  outcome:
    | 'submitted'
    | 'already_pending'
    | 'not_found'
    | 'not_draft'
    | 'no_items'
    | 'no_amount'
    | 'no_policy';
  request_id: string | null;
  status: ProposalStatus | null;
};

/**
 * Puts a quotation in front of the owner (ADM-07).
 *
 * The amount travels with the request, so `approval_policies.min_amount_minor`
 * resolves the approver — §17's "high-value project → approval threshold if
 * configured", which is the whole reason the ladder exists.
 */
export async function submitProposal(
  input: SubmitProposalInput,
): Promise<Result<{ requestId: string; alreadyPending: boolean }>> {
  const parsed = submitProposalSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid submission.');

  const context = await requireInternal();
  if (!can(context.role, 'proposal.draft')) {
    return err('FORBIDDEN', 'You do not have permission to submit quotations.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('submit_proposal', {
    p_proposal_id: parsed.data.proposalId,
    p_requested_by: context.userId,
    ...(parsed.data.summary ? { p_summary: parsed.data.summary } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'submitProposal', detail: error.message }));
    return err('INTERNAL', 'Could not submit the quotation.');
  }

  const row = single<SubmitRow>(data);
  if (!row) return err('INTERNAL', 'Could not submit the quotation.');

  switch (row.outcome) {
    case 'submitted':
    case 'already_pending':
      if (!row.request_id) return err('INTERNAL', 'Could not submit the quotation.');
      return ok({ requestId: row.request_id, alreadyPending: row.outcome === 'already_pending' });

    case 'not_found':
      return err('NOT_FOUND', 'Quotation not found.');

    case 'not_draft':
      return err('CONFLICT', `This quotation is ${row.status ?? 'not a draft'}.`);

    case 'no_items':
      return err('VALIDATION', 'A quotation with no lines is not a quotation.');

    case 'no_amount':
      return err('VALIDATION', 'A quotation needs an amount before anybody can approve it.');

    // Not a default-open, and the same answer submitting a deliverable gives:
    // with no policy there is nobody named to approve, so the quote would sit
    // in a queue that rots.
    case 'no_policy':
      return err(
        'CONFLICT',
        'No approval policy covers quotations. An owner sets one before this can be approved.',
      );

    default:
      return err('INTERNAL', 'Could not submit the quotation.');
  }
}

/** Bring the owner's decision back onto the quotation after it is settled. */
export async function syncProposalDecision(
  proposalId: string,
): Promise<Result<{ status: string }>> {
  await requireInternal();

  const supabase = await createClient();

  const { data, error } = await supabase
    .schema('sales')
    .rpc('sync_proposal_decision', { p_proposal_id: proposalId });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'syncProposalDecision', detail: error.message }));
    return err('INTERNAL', 'Could not read the decision.');
  }

  return ok({ status: String(data) });
}

type SendRow = {
  outcome: 'sent' | 'not_found' | 'not_approved' | 'already_sent';
  status: ProposalStatus | null;
  sent_at: string | null;
};

/**
 * Delivers an approved quotation to the client (§18).
 *
 * The gate is ADM-07's, and it is in Postgres under the row's lock: anything
 * the owner has not approved is refused here, not merely hidden in the UI.
 */
/**
 * The rows a quotation document is rendered from, beyond the proposal's own.
 *
 * The organization's name and clock brand and date it; the contact at the far
 * end of proposal → opportunity → lead names who it was prepared for. Every
 * absent link leaves its field null and the renderer omits the block —
 * §12's "where documented" clause, which is ADM-76 wearing a layout: a
 * document must not name a client the rows do not.
 */
/**
 * A read that failed, distinct from a render that failed.
 *
 * The two demand opposite treatment in `sendProposal`: a read failure is the
 * database blinking, and blocking the stamp lets a retry finish the PDF; a
 * render failure is deterministic, and blocking on it would strand an
 * approved quotation forever. The first version folded both into one catch
 * and classified a blink as permanent — the client's PDF was then
 * unrecoverable by construction.
 */
class SurroundingsUnreadable extends Error {}

async function quotationDocumentSurroundings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  opportunityId: string | null,
): Promise<{ organizationName: string; timeZone: string; preparedFor: string | null }> {
  const { data: org, error: orgError } = await supabase
    .schema('core')
    .from('organizations')
    .select('name, timezone')
    .limit(1)
    .maybeSingle();

  // A document with no letterhead is worse than no document — the reader
  // cannot tell whose price this is. Throwing (not defaulting) is deliberate:
  // the caller treats a failed render as "the PDF was not attached", which is
  // honest, where a PDF branded "AgencyOS" would not be.
  if (orgError || !org) {
    throw new SurroundingsUnreadable(`the organization could not be read: ${orgError?.message ?? 'no row'}`);
  }

  let preparedFor: string | null = null;
  if (opportunityId) {
    const { data: opportunity } = await supabase
      .schema('sales')
      .from('opportunities')
      .select('lead_id')
      .eq('id', opportunityId)
      .maybeSingle();
    if (opportunity?.lead_id) {
      const { data: lead } = await supabase
        .schema('crm')
        .from('leads')
        .select('contact_id')
        .eq('id', opportunity.lead_id)
        .maybeSingle();
      if (lead?.contact_id) {
        const { data: contact } = await supabase
          .schema('crm')
          .from('contacts')
          .select('full_name, company')
          .eq('id', lead.contact_id)
          .maybeSingle();
        if (contact) {
          preparedFor = contact.company ? `${contact.full_name} — ${contact.company}` : contact.full_name;
        }
      }
    }
  }

  return { organizationName: org.name, timeZone: org.timezone ?? 'UTC', preparedFor };
}

/**
 * The quotation as a document, for whoever is looking at it in AgencyOS.
 *
 * The same renderer that produces the owner's and the client's copies —
 * deliberately, so what the screen offers for download IS what WhatsApp
 * delivered, byte for byte on the same status. The status band keeps a draft
 * honest: this function renders ANY proposal the caller can see, because
 * reviewing a draft PDF before submitting it is exactly what §12's quality
 * bar is for, and the band says what it is (ADM-76).
 *
 * Gated on `lead.read`, which is what every proposal-showing page gates on —
 * a download is a read wearing a Content-Disposition header, and a new
 * capability naming the same role set would add vocabulary without control.
 */
export async function quotationPdfForProposal(
  proposalId: string,
): Promise<Result<{ bytes: Uint8Array; filename: string }>> {
  const idCheck = z.string().uuid().safeParse(proposalId);
  if (!idCheck.success) return err('VALIDATION', 'Not a quotation id.');

  const context = await requireInternal();
  if (!can(context.role, 'lead.read')) {
    return err('FORBIDDEN', 'You do not have permission to read quotations.');
  }

  const supabase = await createClient();

  const { data: proposal, error } = await supabase
    .schema('sales')
    .from('proposals')
    .select(
      'id, version, title, body, status, currency, subtotal_minor, discount_minor, tax_minor, total_minor, valid_until, created_at, opportunity_id, document',
    )
    .eq('id', idCheck.data)
    .maybeSingle();

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'quotationPdfForProposal', detail: error.message }));
    return err('INTERNAL', 'The quotation could not be read.');
  }
  if (!proposal) return err('NOT_FOUND', 'Quotation not found.');

  const { data: items, error: itemsError } = await supabase
    .schema('sales')
    .from('proposal_items')
    .select('description, quantity, amount_minor, features')
    .eq('proposal_id', proposal.id)
    .order('position')
    .order('created_at');

  if (itemsError) {
    console.error(JSON.stringify({ level: 'error', scope: 'quotationPdfForProposal', detail: itemsError.message }));
    return err('INTERNAL', 'The quotation could not be read.');
  }

  try {
    const surroundings = await quotationDocumentSurroundings(supabase, proposal.opportunity_id);
    const { renderQuotationPdf, quotationPdfFilename } = await import('@/lib/pdf/quotation');
    // The document's sections (G-165): stored judgment + computed policy;
    // null on a legacy quotation, which then renders exactly as before.
    // The scope in words, for the regulated-category backstop (G-167):
    // it reads the quotation's own lines rather than trusting a label.
    const scopeText = (items ?? [])
      .map((i) => [i.description, ...(Array.isArray(i.features) ? i.features : [])].join(' '))
      .join(' ');
    const sections = quotationSectionsFor(proposal.total_minor, proposal.tax_minor, proposal.document ?? null, scopeText);
    const rendered = await renderQuotationPdf({
      ...surroundings,
      title: proposal.title,
      version: proposal.version,
      status: proposal.status,
      body: proposal.body,
      currency: proposal.currency,
      items: (items ?? []).map((i) => ({
        description: i.description,
        quantity: Number(i.quantity),
        amountMinor: i.amount_minor,
        ...(Array.isArray(i.features) ? { features: i.features as string[] } : {}),
      })),
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
      reference: proposal.id,
    });
    return ok({ bytes: rendered.bytes, filename: quotationPdfFilename(proposal.title, proposal.version) });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown render failure';
    console.error(JSON.stringify({ level: 'error', scope: 'quotationPdfForProposal', detail }));
    return err('INTERNAL', 'The quotation document could not be rendered.');
  }
}

export async function sendProposal(
  input: SendProposalInput,
): Promise<Result<{ sentAt: string; alreadySent: boolean; pdfDelivered: boolean; pdfNote: string | null }>> {
  const parsed = sendProposalSchema.safeParse(input);
  if (!parsed.success) return err('VALIDATION', 'Invalid send request.');

  const context = await requireInternal();
  if (!can(context.role, 'proposal.send')) {
    return err('FORBIDDEN', 'You do not have permission to send quotations.');
  }

  const supabase = await createClient();

  /**
   * ── the quotation actually reaches the client ─────────────────────────
   *
   * `sales.send_proposal` never sent anything. It marked the row `sent` and
   * recorded a message reference the caller had typed — so "Send quotation"
   * meant *"I have sent this myself, note it down"*, and on a deployment where
   * nobody knew that, an approved quotation reached nobody. Doc 09 §18 asks
   * for the opposite: send it, record the timestamp, record the reference,
   * link it to the conversation.
   *
   * The order matters and is not the obvious one.
   *
   * The message goes FIRST and `send_proposal` marks the row after it. The
   * reverse — mark, then send — would leave a row saying `sent` with nothing
   * sent whenever the provider refused, which is the exact shape that made a
   * refused reply unretryable in PR #300. This way a failure leaves the
   * quotation `approved` and sendable again, and the worst case is a message
   * in the transcript whose row was not stamped, which a person can see.
   *
   * Approval is checked twice for the same reason: cheaply here, so an
   * unapproved quotation never reaches the client, and again inside
   * `send_proposal` under the row lock, which is the one that counts.
   */
  const { data: proposal } = await supabase
    .schema('sales')
    .from('proposals')
    .select(
      'id, version, title, body, status, currency, subtotal_minor, discount_minor, tax_minor, total_minor, valid_until, conversation_id, created_at, opportunity_id, document',
    )
    .eq('id', parsed.data.proposalId)
    .maybeSingle();

  if (!proposal) return err('NOT_FOUND', 'Quotation not found.');

  if (proposal.status !== 'approved') {
    // The same words the RPC's own branch produces, said BEFORE a client could
    // possibly see anything. Kept identical rather than summarised: the
    // difference between "the owner has not answered" and "it is still a
    // draft" is the difference between waiting and doing something, and a
    // caller that now stops earlier should not lose it.
    if (proposal.status === 'sent') {
      return err('CONFLICT', 'This quotation has already been sent.');
    }
    return err(
      'CONFLICT',
      proposal.status === 'pending_approval'
        ? 'The owner has not answered this quotation yet.'
        : 'A quotation reaches a client only after the owner approves it.',
    );
  }

  const conversationId = parsed.data.conversationId ?? proposal.conversation_id;

  if (!conversationId) {
    return err(
      'VALIDATION',
      'This quotation is not attached to a conversation, so there is nobody to send it to.',
    );
  }

  const { data: items, error: itemsError } = await supabase
    .schema('sales')
    .from('proposal_items')
    .select('description, quantity, amount_minor, features')
    .eq('proposal_id', proposal.id)
    .order('position');

  // A read that failed is not a quotation with no lines. Sending "What it
  // covers: (nothing)" with a full total — and then stamping it sent, which
  // is irreversible — would hand the client an incomplete quotation over a
  // database blink. Refused before anything can leave.
  if (itemsError) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendProposal', detail: itemsError.message }));
    return err('INTERNAL', 'The quotation could not be read in full. Nothing was sent — try again.');
  }

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
  });

  /**
   * Keyed on the quotation and its version, so §28's *"never send the same
   * quotation twice"* is a property of the key rather than of the caller
   * remembering. A second press returns `already_sent` from
   * `send_outbound_message` and the client's phone stays quiet.
   *
   * Through `sendClientMessage` rather than around it: consent (ADM-70), the
   * sequence, the provider call and the delivery record are all its, and it
   * authors the message with the person who pressed Send — which is what lets
   * a message carrying a price past `crm.refuse_unread_price` at all.
   */
  const delivered = await sendClientMessage({
    conversationId,
    body,
    idempotencyKey: `proposal:${proposal.id}:v${proposal.version}`,
  });

  if (!delivered.ok) return delivered;

  /**
   * ── the second leg: the document the client keeps (brief §12, G-156) ────
   *
   * The text is the quotation a phone reads; the PDF is the one that gets
   * saved, forwarded to a partner and printed. Its own idempotency key
   * (`:pdf`), so each leg retries independently — a second press skips
   * whatever already landed and finishes the rest.
   *
   * The failure rule is what a retry could fix, and it decides whether the
   * quotation is stamped `sent` below:
   *
   *   transient (provider unreachable, 429, 5xx) — the send stops HERE,
   *   before `send_proposal` stamps the row, so the quotation stays
   *   `approved` and pressing Send again finishes the PDF. Stamping first
   *   would strand the PDF forever: a `sent` quotation refuses this whole
   *   path at the top. One edge is accepted rather than solved: if consent
   *   is WITHDRAWN while the quotation is parked here, the retry's text leg
   *   answers no_consent before anything else runs, and the quotation stays
   *   `approved` with the priced text already on the client's phone. That is
   *   ADM-70 winning on purpose — consent is checked before idempotency so a
   *   refusal cannot be retried into a permission — and the honest record of
   *   a send interrupted by a withdrawal is exactly this shape.
   *
   *   permanent (the provider refused this document, the renderer crashed) —
   *   the stamp proceeds and the answer says the PDF is missing. §27:
   *   retrying a deterministic "no" to death would leave an approved
   *   quotation that can never become sent, over a document whose every word
   *   the client already has in the text.
   */
  let pdfDelivered = false;
  let pdfNote: string | null = null;
  try {
    const surroundings = await quotationDocumentSurroundings(supabase, proposal.opportunity_id);
    const { renderQuotationPdf, quotationPdfFilename } = await import('@/lib/pdf/quotation');
    // The document's sections (G-165): stored judgment + computed policy;
    // null on a legacy quotation, which then renders exactly as before.
    // The scope in words, for the regulated-category backstop (G-167):
    // it reads the quotation's own lines rather than trusting a label.
    const scopeText = (items ?? [])
      .map((i) => [i.description, ...(Array.isArray(i.features) ? i.features : [])].join(' '))
      .join(' ');
    const sections = quotationSectionsFor(proposal.total_minor, proposal.tax_minor, proposal.document ?? null, scopeText);
    const rendered = await renderQuotationPdf({
      ...surroundings,
      title: proposal.title,
      version: proposal.version,
      status: proposal.status,
      body: proposal.body,
      currency: proposal.currency,
      items: (items ?? []).map((i) => ({
        description: i.description,
        quantity: Number(i.quantity),
        amountMinor: i.amount_minor,
        ...(Array.isArray(i.features) ? { features: i.features as string[] } : {}),
      })),
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
      reference: proposal.id,
    });
    if (rendered.replacedCharacters.length > 0) {
      console.error(
        JSON.stringify({
          level: 'warn',
          scope: 'sendProposal',
          detail: `characters without glyphs replaced: ${rendered.replacedCharacters.join(' ')}`,
        }),
      );
    }

    const document = await sendClientDocument({
      conversationId,
      filename: quotationPdfFilename(proposal.title, proposal.version),
      idempotencyKey: `proposal:${proposal.id}:v${proposal.version}:pdf`,
      bytes: rendered.bytes,
    });

    if (!document.ok) {
      // Two kinds of refusal, told apart by whether pressing Send again could
      // change the answer. INTERNAL is the database blinking — block the
      // stamp so the retry finishes the PDF. Everything else (consent
      // withdrawn between the legs, the conversation gone) is a state no
      // retry fixes, and "press Send again" would be a promise the button
      // cannot keep — an approved quotation stuck behind it forever. Said
      // and stepped past instead, like a permanent provider refusal.
      if (document.error.code === 'INTERNAL') {
        return err(
          'PROVIDER_ERROR',
          `The quotation text was delivered, but its PDF could not be recorded: ${document.error.message} The quotation is still approved — press Send again to retry the PDF.`,
        );
      }
      pdfNote = document.error.message;
    } else {
      if (!document.data.delivered && document.data.retryable) {
        return err(
          'PROVIDER_ERROR',
          `The quotation text was delivered, but the PDF did not go: ${document.data.reason ?? 'the provider could not be reached'} The quotation is still approved — press Send again to retry the PDF.`,
        );
      }
      pdfDelivered = document.data.delivered;
      if (!document.data.delivered) pdfNote = document.data.reason ?? 'the provider refused it';
    }
  } catch (cause) {
    // A read failure and a render failure part ways here — see
    // SurroundingsUnreadable. Only the render failure is permanent.
    if (cause instanceof SurroundingsUnreadable) {
      return err(
        'PROVIDER_ERROR',
        `The quotation text was delivered, but its PDF could not be prepared: ${cause.message}. The quotation is still approved — press Send again to retry the PDF.`,
      );
    }
    const detail = cause instanceof Error ? cause.message : 'unknown render failure';
    console.error(JSON.stringify({ level: 'error', scope: 'sendProposal', detail }));
    pdfNote = 'the document could not be rendered';
  }

  const { data, error } = await supabase.schema('sales').rpc('send_proposal', {
    p_proposal_id: parsed.data.proposalId,
    p_conversation_id: conversationId,
    // The message this system just sent, not one a person typed in a box. The
    // caller may still pass its own — an emailed quotation, say — and it wins,
    // because it names something this function did not do.
    p_message_ref: parsed.data.messageRef ?? delivered.data.messageId,
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'sendProposal', detail: error.message }));
    return err('INTERNAL', 'Could not send the quotation.');
  }

  const row = single<SendRow>(data);
  if (!row) return err('INTERNAL', 'Could not send the quotation.');

  switch (row.outcome) {
    case 'sent':
    case 'already_sent':
      if (!row.sent_at) return err('INTERNAL', 'Could not send the quotation.');
      return ok({
        sentAt: row.sent_at,
        alreadySent: row.outcome === 'already_sent',
        pdfDelivered,
        pdfNote,
      });

    case 'not_found':
      return err('NOT_FOUND', 'Quotation not found.');

    case 'not_approved':
      return err(
        'CONFLICT',
        row.status === 'pending_approval'
          ? 'The owner has not answered this quotation yet.'
          : 'A quotation reaches a client only after the owner approves it.',
      );

    default:
      return err('INTERNAL', 'Could not send the quotation.');
  }
}

type ResponseRow = {
  outcome: 'recorded' | 'not_found' | 'not_answerable' | 'expired' | 'invalid_response';
  status: ProposalStatus | null;
  decided_at: string | null;
};

/**
 * Records what the client said about a quotation that was actually sent.
 *
 * §18: *"Do not mark accepted simply because quote was delivered."* Acceptance
 * is its own act, and the database will only take it from `sent`.
 *
 * Gated on `proposal.send` rather than a capability of its own: it is the same
 * role set, and finance's rule — a capability mapping to a role set that
 * already exists adds vocabulary without adding control — argues for reuse.
 * The quote's outward lifecycle is one job.
 */
export async function recordProposalResponse(
  input: RecordProposalResponseInput,
): Promise<Result<{ status: ProposalStatus; decidedAt: string }>> {
  const parsed = recordProposalResponseSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', 'Invalid response.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'proposal.send')) {
    return err('FORBIDDEN', 'You do not have permission to record quotation responses.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('record_proposal_response', {
    p_proposal_id: parsed.data.proposalId,
    p_response: parsed.data.response,
    ...(parsed.data.contactId ? { p_contact_id: parsed.data.contactId } : {}),
    ...(parsed.data.note ? { p_note: parsed.data.note } : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'recordProposalResponse', detail: error.message }));
    return err('INTERNAL', 'Could not record the response.');
  }

  const row = single<ResponseRow>(data);
  if (!row) return err('INTERNAL', 'Could not record the response.');

  switch (row.outcome) {
    case 'recorded':
      if (!row.status || !row.decided_at) return err('INTERNAL', 'Could not record the response.');
      return ok({ status: row.status, decidedAt: row.decided_at });

    case 'not_found':
      return err('NOT_FOUND', 'Quotation not found.');

    // G-111. Three different reasons a quotation cannot be answered, and the
    // message says which. It used to be one sentence — "a client can only
    // answer a quotation that was actually sent to them" — which was already
    // false of an accepted, rejected or superseded quote, every one of which
    // *was* sent. The branch that would have said "already answered" was
    // unreachable: the outcome implied the status was not `sent`, so an
    // already-answered quotation got the sentence claiming it never went out.
    case 'not_answerable':
      return err(
        'CONFLICT',
        row.status === 'accepted' || row.status === 'rejected'
          ? 'This quotation was already answered.'
          : row.status === 'superseded'
            ? 'A newer version of this quotation replaced it. Answer that one instead.'
            : 'This quotation has not been sent yet, so there is nothing for a client to answer.',
      );

    case 'expired':
      return err(
        'CONFLICT',
        'This quotation is past its validity date. Draft the next version to re-offer it.',
      );

    case 'invalid_response':
      return err('VALIDATION', 'A client either accepts or rejects.');

    default:
      return err('INTERNAL', 'Could not record the response.');
  }
}

/**
 * Correct an open deal's value, name or expected close date — G-092, ADM-43.
 *
 * *"An open deal's value may be changed by the owner or an ops admin. Every
 * change is written to the audit log with the old and new amount."*
 *
 * A deal had no update path at all: `value_minor`, `name` and
 * `expected_close_on` were written once at insert and never again. So a deal
 * lost at one value and re-won at another converted into a project budgeted at
 * the old one — and since G-017 that number is what the accepted quotation is
 * measured against.
 *
 * The capability check is `lead.write`, which is the same owner-and-ops-admin
 * set ADM-43 names and the same one `opportunities_write` enforces in RLS. No
 * new capability: one mapping to an identical role set adds vocabulary without
 * adding control.
 */
export async function setOpportunityTerms(
  input: SetOpportunityTermsInput,
): Promise<Result<{ valueMinor: number; name: string; expectedCloseOn: string | null; changed: boolean }>> {
  const parsed = setOpportunityTermsSchema.safeParse(input);
  if (!parsed.success) {
    return err('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid change.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const context = await requireInternal();
  if (!can(context.role, 'lead.write')) {
    return err('FORBIDDEN', 'You do not have permission to change deal terms.');
  }

  const supabase = await createClient();

  const { data, error } = await supabase.schema('sales').rpc('set_opportunity_terms', {
    p_opportunity_id: parsed.data.opportunityId,
    ...(parsed.data.valueMinor !== undefined ? { p_value_minor: parsed.data.valueMinor } : {}),
    ...(parsed.data.name !== undefined ? { p_name: parsed.data.name } : {}),
    ...(parsed.data.expectedCloseOn !== undefined
      ? { p_expected_close_on: parsed.data.expectedCloseOn }
      : {}),
  });

  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'setOpportunityTerms', detail: error.message }));
    return err('INTERNAL', 'Could not change the deal.');
  }

  const row = single<{
    outcome: 'updated' | 'not_found' | 'settled' | 'nothing_to_change';
    value_minor: number | null;
    name: string | null;
    expected_close_on: string | null;
  }>(data);

  if (!row) return err('INTERNAL', 'Could not change the deal.');

  switch (row.outcome) {
    case 'updated':
    case 'nothing_to_change':
      return ok({
        valueMinor: row.value_minor ?? 0,
        name: row.name ?? '',
        expectedCloseOn: row.expected_close_on,
        changed: row.outcome === 'updated',
      });

    case 'not_found':
      return err('NOT_FOUND', 'Opportunity not found.');

    // ADM-43 says "an open deal's". A won deal has already become a project's
    // budget and possibly an invoice; a lost one records what was on the table.
    case 'settled':
      return err('CONFLICT', 'A settled deal keeps the terms it was settled on.');

    default:
      return err('INTERNAL', 'Could not change the deal.');
  }
}
