/**
 * Known, missing, conflicting, stale — the context resolver PM §4.1 needs.
 *
 * **The instruction, in the specification's own words:** *"Never ask the client
 * to repeat already-confirmed information unless missing, conflicting, stale or
 * explicitly requiring reconfirmation."* PM §14 states the build as *"Build
 * known/missing/conflicting field resolver"*, and PM-02 as *"build known-vs-
 * missing matrix"*.
 *
 * **What already existed, and is therefore read rather than rebuilt.** Two
 * things in this repository already answer part of this, and a parallel copy of
 * either would be a second source that drifts:
 *
 * - `ai.handoffs.unresolved` is a structured missing-information list already,
 *   computed at the win by `sales.record_won_handoff` against the commercial
 *   facts — no accepted quotation, no requirement version, a requirement
 *   version nobody accepted, no approval, no contact, an acceptance with nobody
 *   named on it, no conversation summary, missing payment evidence, and a
 *   project whose proposal differs from the packet's. Those verdicts are
 *   **authoritative here**: the win is when they were true, and re-deriving
 *   them would be a second opinion about a settled question.
 * - `crm.qualification_coverage` records which of Document 09 §9's fifteen
 *   areas the client has **already answered, in their own words**. It exists
 *   precisely so nobody interrogates a lead with a checklist the conversation
 *   already filled in — the same sentence PM §4.1 writes for Phase 2.
 *
 * So this module is the join, not a third opinion: it maps the onboarding
 * checklist's client-facing items onto the rows Phase 1 already wrote, and
 * returns a verdict per field **with the evidence it read**.
 *
 * **A `known` with no evidence is refused.** `crm.qualification_coverage`
 * makes the rule structural — *"a coverage row that cannot point at what it
 * read is an assertion"* — and the same rule holds here: a field is only
 * confirmed if this module can name the row or quote the sentence that
 * confirms it. Anything else is `missing`, which costs one question, rather
 * than `known`, which costs the client's patience and the agency's credibility.
 *
 * **Staleness invents no threshold.** There is no "a fact goes stale after N
 * days" rule anywhere in this repository or in the four Phase 2 documents, and
 * inventing one would be inventing a business rule. A fact is stale here only
 * when the system itself has superseded the row the packet pointed at — a newer
 * accepted requirement version, a superseded proposal, a newer frozen scope.
 * That is the same discipline `core.operational_backlog` states: *"Invents no
 * threshold — each one is either a state the system set itself or the existing
 * constant."*
 *
 * **What is deliberately not modelled: "explicitly requiring reconfirmation".**
 * PM §4.1's fourth reason is a configuration — which fields must be re-asked
 * however well Phase 1 recorded them — and nobody has configured it. Guessing
 * would put words in the owner's mouth about what to ask a paying client twice.
 * Raised as **ADM-107**. It blocks nothing: a field nobody asked in Phase 1 is
 * already `missing` here, so the fields most likely to need reconfirmation —
 * the billing details Finance §4.1 wants and Phase 1 never collected — are
 * asked anyway.
 *
 * Pure: it takes rows and returns verdicts. No database, no model, no clock
 * except the one passed in.
 */

/** PM §4.1's four reasons a confirmed fact may still be asked. */
export type ContextVerdict = 'known' | 'missing' | 'conflicting' | 'stale';

/**
 * A field the PM could ask a client about.
 *
 * `key` matches `projects.onboarding_baseline.key` where the checklist has a
 * matching item, so a resolution can settle a checklist row rather than living
 * beside it as a second list.
 */
export type ContextFieldKey =
  | 'client_identity_confirmed'
  | 'accepted_quotation_confirmed'
  | 'commercial_terms_confirmed'
  | 'project_name_confirmed'
  | 'requirements_imported'
  | 'scope_version_created'
  | 'timeline_assumptions_recorded'
  | 'stakeholders_identified'
  | 'assets_requested'
  | 'design_references_requested'
  | 'technical_access_identified';

export type ContextField = {
  readonly key: ContextFieldKey;
  /** What a person reading the matrix sees. */
  readonly label: string;
  /** What the PM asks when it is missing. Phrased as a question, because it becomes one. */
  readonly question: string;
  /** Where the answer lives if Phase 1 got one. For the record, and for a reader chasing a verdict. */
  readonly source: string;
};

/**
 * The client-facing subset of the onboarding checklist.
 *
 * The baseline has seventeen items; six of them — the WhatsApp group, the PM
 * assignment, the specialist agents, the kickoff and the activation, plus the
 * payment verification Admin performs — are **the agency's own work, not the
 * client's answers**. Asking a client to confirm that their project manager has
 * been assigned is not a question; it is a status update wearing one. They are
 * absent on purpose, and `payment_verified` most deliberately of all: Finance
 * and Admin own it, proof never auto-verifies, and a PM that treated it as a
 * field to collect would be collecting the one thing it must not.
 */
export const CONTEXT_FIELDS: readonly ContextField[] = [
  {
    key: 'client_identity_confirmed',
    label: 'Client identity and contact',
    question: 'Who should we keep as the main contact for this project, and on which number?',
    source: 'core.client_accounts and crm.contacts, via the handoff packet',
  },
  {
    key: 'accepted_quotation_confirmed',
    label: 'Accepted quotation',
    question: 'Could you confirm the quotation you approved, so we bill exactly that?',
    source: 'sales.proposals, via the packet’s artifacts',
  },
  {
    key: 'commercial_terms_confirmed',
    label: 'Commercial terms',
    question: 'Could you confirm the commercial terms we agreed?',
    source: 'the packet’s decisions — the approval and the acceptance',
  },
  {
    key: 'project_name_confirmed',
    label: 'Project name',
    question: 'What should we call this project in our updates to you?',
    source: 'projects.projects.name',
  },
  {
    key: 'requirements_imported',
    label: 'Requirements',
    question: 'Could you confirm the requirements list we prepared is still what you want built?',
    source: 'crm.requirement_versions, via the packet’s requirements',
  },
  {
    key: 'scope_version_created',
    label: 'Scope',
    question: 'Could we confirm the scope before we plan around it?',
    source: 'projects.scope_versions',
  },
  {
    key: 'timeline_assumptions_recorded',
    label: 'Timeline expectations',
    question: 'Do you have a target date or a deadline we should plan towards?',
    source: 'crm.qualification_coverage, area `timeline`',
  },
  {
    key: 'stakeholders_identified',
    label: 'Decision makers and stakeholders',
    question: 'Besides yourself, who else should be in the loop or approve things?',
    source: 'crm.qualification_coverage, area `decision_maker`',
  },
  {
    key: 'assets_requested',
    label: 'Existing assets',
    question: 'Do you already have anything we should build on — a site, content, accounts?',
    source: 'crm.qualification_coverage, area `existing_assets`',
  },
  {
    key: 'design_references_requested',
    label: 'Design references',
    question: 'Any brands, sites or apps whose look you would like us to follow?',
    source: 'crm.qualification_coverage, area `design_expectations`',
  },
  {
    key: 'technical_access_identified',
    label: 'Integrations and access',
    question: 'Are there systems we will need to connect to, or accounts we will need access to?',
    source: 'crm.qualification_coverage, area `integrations`',
  },
];

/** The coverage area each qualification-backed field reads. Document 09 §9's names. */
export const COVERAGE_AREA_FOR: Partial<Record<ContextFieldKey, string>> = {
  timeline_assumptions_recorded: 'timeline',
  stakeholders_identified: 'decision_maker',
  assets_requested: 'existing_assets',
  design_references_requested: 'design_expectations',
  technical_access_identified: 'integrations',
};

/**
 * The markers `sales.record_won_handoff` writes into `ai.handoffs.unresolved`,
 * and which field each one settles.
 *
 * Read rather than re-derived: the win is when these were true, and a second
 * opinion about a settled question is how two sources start disagreeing.
 */
export const UNRESOLVED_MEANS: Record<string, { field: ContextFieldKey; verdict: ContextVerdict; reason: string }> = {
  contact: {
    field: 'client_identity_confirmed',
    verdict: 'missing',
    reason: 'the handoff packet recorded no contact for this deal',
  },
  accepted_quotation: {
    field: 'accepted_quotation_confirmed',
    verdict: 'missing',
    reason: 'no accepted quotation was recorded at the win',
  },
  approval: {
    field: 'commercial_terms_confirmed',
    verdict: 'missing',
    reason: 'the quotation carries no internal approval',
  },
  acceptance_actor: {
    field: 'commercial_terms_confirmed',
    verdict: 'conflicting',
    reason: 'the quotation was accepted but nobody is named as having accepted it',
  },
  requirement_version: {
    field: 'requirements_imported',
    verdict: 'missing',
    reason: 'no requirement version was recorded at the win',
  },
  requirement_version_not_accepted: {
    field: 'requirements_imported',
    verdict: 'missing',
    reason: 'a requirement version exists but nobody accepted it, so it is a draft rather than a confirmation',
  },
  project_proposal_differs: {
    field: 'accepted_quotation_confirmed',
    verdict: 'conflicting',
    reason: 'the project points at a different quotation than the packet does',
  },
};

/** The rows this resolver reads. Plain data, so the rules can be exercised without a database. */
export type ContextSources = {
  /** `ai.handoffs.unresolved`, verbatim. */
  readonly unresolved: readonly string[];
  readonly contact: { id: string; full_name: string | null } | null;
  readonly clientAccount: { id: string; name: string | null } | null;
  readonly project: { id: string; name: string | null } | null;
  /** The quotation the packet references, and whether it is still the live one. */
  readonly proposal: { id: string; version: number | null; status: string | null } | null;
  /** The requirement version the packet references. */
  readonly requirement: { id: string; version: number | null; status: string | null } | null;
  /** The newest accepted requirement version for the same conversation, if any. */
  readonly latestAcceptedRequirement: { id: string; version: number | null } | null;
  /** The project's newest scope version. */
  readonly scope: { id: string; version: number | null; status: string | null } | null;
  /** `crm.qualification_coverage` for the lead, keyed by area. */
  readonly coverage: Readonly<Record<string, { quote: string } | undefined>>;
};

export type Resolution = {
  readonly key: ContextFieldKey;
  readonly label: string;
  readonly verdict: ContextVerdict;
  /** What was read. Empty only when the verdict is `missing`. */
  readonly evidence: string | null;
  /** Why this verdict, in words a person can act on. */
  readonly reason: string;
  /** The question to ask, present whenever the verdict is not `known`. */
  readonly question: string | null;
};

const missing = (field: ContextField, reason: string): Resolution => ({
  key: field.key,
  label: field.label,
  verdict: 'missing',
  evidence: null,
  reason,
  question: field.question,
});

const known = (field: ContextField, evidence: string, reason: string): Resolution => ({
  key: field.key,
  label: field.label,
  verdict: 'known',
  evidence,
  reason,
  question: null,
});

const flagged = (
  field: ContextField,
  verdict: 'conflicting' | 'stale',
  evidence: string | null,
  reason: string,
): Resolution => ({
  key: field.key,
  label: field.label,
  verdict,
  evidence,
  reason,
  question: field.question,
});

/**
 * Resolve one field against the rows.
 *
 * The packet's own verdicts are applied first and win, for the reason above.
 * Everything after them is a read of a current row, and a read that finds
 * nothing says `missing` rather than assuming.
 */
function resolveField(field: ContextField, sources: ContextSources): Resolution {
  // The packet's markers, in the order they were written. A field with two
  // markers takes the more serious one: `conflicting` outranks `missing`,
  // because a contradiction asked as a plain question gets a plain answer and
  // the contradiction survives it.
  const marked = sources.unresolved
    .map((marker) => UNRESOLVED_MEANS[marker])
    .filter((m): m is (typeof UNRESOLVED_MEANS)[string] => m !== undefined && m.field === field.key);
  const worst = marked.find((m) => m.verdict === 'conflicting') ?? marked[0];
  if (worst) {
    return worst.verdict === 'missing'
      ? missing(field, worst.reason)
      : flagged(field, 'conflicting', null, worst.reason);
  }

  const area = COVERAGE_AREA_FOR[field.key];
  if (area) {
    const covered = sources.coverage[area];
    return covered
      ? known(field, `the client’s own words: “${covered.quote}”`, `area \`${area}\` was answered in the conversation`)
      : missing(field, `area \`${area}\` was never covered in the Phase 1 conversation`);
  }

  switch (field.key) {
    case 'client_identity_confirmed': {
      if (!sources.contact) return missing(field, 'no contact is on record for this project');
      if (!sources.clientAccount) return missing(field, 'the contact has no client account behind it');
      return known(
        field,
        `contact ${sources.contact.id}${sources.contact.full_name ? ` (${sources.contact.full_name})` : ''}`,
        'the packet named a contact and the client account exists',
      );
    }
    case 'accepted_quotation_confirmed': {
      if (!sources.proposal) return missing(field, 'no quotation is on record for this project');
      if (sources.proposal.status === 'superseded') {
        return flagged(
          field,
          'stale',
          `quotation ${sources.proposal.id} v${sources.proposal.version ?? '?'}`,
          'the quotation the handoff referenced has since been superseded',
        );
      }
      return known(
        field,
        `quotation ${sources.proposal.id} v${sources.proposal.version ?? '?'}`,
        'the accepted quotation is on record and is still the live one',
      );
    }
    case 'commercial_terms_confirmed': {
      if (!sources.proposal) return missing(field, 'there are no terms without a quotation');
      return known(field, `quotation ${sources.proposal.id}`, 'the packet recorded both the approval and the acceptance');
    }
    case 'project_name_confirmed': {
      const name = sources.project?.name?.trim();
      if (!name) return missing(field, 'the project has no name');
      return known(field, name, 'the project carries a name');
    }
    case 'requirements_imported': {
      if (!sources.requirement) return missing(field, 'no requirement version is on record');
      const latest = sources.latestAcceptedRequirement;
      if (latest && latest.id !== sources.requirement.id) {
        return flagged(
          field,
          'stale',
          `version ${sources.requirement.version ?? '?'}, superseded by ${latest.version ?? '?'}`,
          'a newer requirement version has been accepted since the handoff was written',
        );
      }
      return known(
        field,
        `requirement version ${sources.requirement.version ?? '?'}`,
        'the accepted requirement version is still the newest one',
      );
    }
    case 'scope_version_created': {
      if (!sources.scope) return missing(field, 'no scope version has been created for this project');
      if (sources.scope.status === 'draft') {
        return missing(field, 'a scope version exists but it is still a draft, which is not a confirmation');
      }
      return known(field, `scope version ${sources.scope.version ?? '?'}`, 'the project has a frozen scope version');
    }
    default:
      return missing(field, 'nothing on record answers this');
  }
}

export type ContextMatrix = {
  readonly resolutions: readonly Resolution[];
  /** The fields to ask about, in checklist order — PM §4.1's "structured missing-information list". */
  readonly toAsk: readonly Resolution[];
  /** The fields Phase 1 confirmed. PM-03's "do not re-ask known details" is the complement of `toAsk`. */
  readonly knownKeys: readonly ContextFieldKey[];
  readonly counts: Readonly<Record<ContextVerdict, number>>;
};

/**
 * The known-vs-missing matrix PM-02 asks for.
 *
 * `toAsk` is the list, and it is deliberately *not* filtered down to a first
 * batch: PM-03 asks for "only the first set of missing required information",
 * and which set that is belongs to the unit that writes the message, not to the
 * unit that works out what is unknown.
 */
export function resolveOnboardingContext(sources: ContextSources): ContextMatrix {
  const resolutions = CONTEXT_FIELDS.map((field) => resolveField(field, sources));
  const counts: Record<ContextVerdict, number> = { known: 0, missing: 0, conflicting: 0, stale: 0 };
  for (const r of resolutions) counts[r.verdict] += 1;
  return {
    resolutions,
    toAsk: resolutions.filter((r) => r.verdict !== 'known'),
    knownKeys: resolutions.filter((r) => r.verdict === 'known').map((r) => r.key),
    counts,
  };
}

/**
 * Whether a field may be asked of the client.
 *
 * The whole point of §4.1, as a predicate rather than a sentence, so the rule
 * can be tested as a function and cannot be satisfied by a comment beside it.
 */
export function mayAsk(resolution: Resolution): boolean {
  return resolution.verdict !== 'known';
}
