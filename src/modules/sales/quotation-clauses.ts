/**
 * The four clauses of a quotation that are the owner's wording — the
 * configurability audit's B-6.
 *
 * Clauses 2-5 of the commercial terms (the acceptance window, cancellation,
 * the liability cap, the jurisdiction) used to be code constants. They are
 * now versioned rows the owner publishes (`sales.quotation_clauses`), and a
 * quotation keeps the versions it PRINTED (`sales.proposals.clauses_printed`).
 *
 * This file is a leaf on purpose: pure data and pure functions, no session,
 * no `server-only`. The standards module builds `COMMERCIAL_TERMS` from the
 * defaults here, a client form imports the keys and the validator, and the
 * cron handler (no signed-in user) reaches the snapshot door through
 * `clausesForProposal` with the client it already has.
 */

import { err, ok, type Result } from '@/lib/result';

export const CLAUSE_KEYS = ['acceptance_window', 'cancellation', 'liability_cap', 'jurisdiction'] as const;
export type ClauseKey = (typeof CLAUSE_KEYS)[number];

export function isClauseKey(value: unknown): value is ClauseKey {
  return typeof value === 'string' && (CLAUSE_KEYS as readonly string[]).includes(value);
}

/** What the owner sees the clause called. */
export const CLAUSE_LABELS: Readonly<Record<ClauseKey, string>> = {
  acceptance_window: 'Acceptance window',
  cancellation: 'Cancellation',
  liability_cap: 'Liability cap',
  jurisdiction: 'Jurisdiction',
};

/** One line on what each clause is for, beside its text. */
export const CLAUSE_HINTS: Readonly<Record<ClauseKey, string>> = {
  acceptance_window: 'When a delivered milestone counts as accepted.',
  cancellation: 'What is payable if the client cancels.',
  liability_cap: 'The most the agency can be held to.',
  jurisdiction: 'Which law applies and which courts decide.',
};

/**
 * The wording every quotation printed before this was configurable — and
 * still prints for a clause nobody has published. Same sentences, same order
 * as the old `COMMERCIAL_TERMS[1..4]`.
 */
export const DEFAULT_CLAUSES: Readonly<Record<ClauseKey, string>> = {
  acceptance_window:
    'A milestone is accepted when the demo it names is delivered and no written objection follows within 5 working days.',
  cancellation:
    'On cancellation, work delivered to the last accepted milestone is payable and the advance for work already started is not refundable.',
  liability_cap: 'Our total liability is limited to the amount paid under this quotation.',
  jurisdiction: 'Indian law applies, and the courts at Mohali / Chandigarh have jurisdiction.',
};

export const CLAUSE_MIN_LENGTH = 10;
export const CLAUSE_MAX_LENGTH = 1200;

/**
 * The same rule the database applies (`core.publish_quotation_clause`): a
 * sentence, not markup, on one line. Checked here so the form can say what is
 * wrong; the database is the one that refuses.
 */
export function validateClauseBody(raw: string): Result<string> {
  const body = raw.trim();
  if (body.length < CLAUSE_MIN_LENGTH) return err('VALIDATION', `A clause needs at least ${CLAUSE_MIN_LENGTH} characters.`);
  if (body.length > CLAUSE_MAX_LENGTH) return err('VALIDATION', `A clause is at most ${CLAUSE_MAX_LENGTH} characters.`);
  if (/[<>]/.test(body)) return err('VALIDATION', 'A clause is plain text — no < or > (no markup).');
  if (/[\r\n]/.test(body)) return err('VALIDATION', 'A clause is one line. Publish each clause on its own.');
  return ok(body);
}

/** One published version, as the screen reads it. */
export type ClauseVersion = {
  key: ClauseKey;
  version: number;
  body: string;
  effectiveFrom: string;
  createdBy: string;
  createdByName: string | null;
};

/** What a quotation stores: only the keys that had a published version. */
export type ClauseSnapshot = Partial<Record<ClauseKey, { version: number; body: string }>>;

/** Read a stored snapshot defensively: a malformed entry is an absent one, never a thrown render. */
export function parseClauseSnapshot(value: unknown): ClauseSnapshot {
  const out: ClauseSnapshot = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const key of CLAUSE_KEYS) {
    const entry = (value as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object') continue;
    const { version, body } = entry as { version?: unknown; body?: unknown };
    if (typeof body === 'string' && body.trim() !== '' && typeof version === 'number') {
      out[key] = { version, body };
    }
  }
  return out;
}

/**
 * The four clause bodies, in print order: the snapshot's where it has one,
 * the code default where it does not. Unset means the constants.
 */
export function clauseBodies(snapshot: ClauseSnapshot | null | undefined): readonly string[] {
  return CLAUSE_KEYS.map((key) => snapshot?.[key]?.body ?? DEFAULT_CLAUSES[key]);
}

/** The newest version of each key out of a full listing — what is in force now. */
export function inForce(versions: readonly ClauseVersion[]): ClauseSnapshot {
  const out: ClauseSnapshot = {};
  for (const v of versions) {
    const held = out[v.key];
    if (!held || v.version > held.version) out[v.key] = { version: v.version, body: v.body };
  }
  return out;
}

/** The slice of a Supabase client the snapshot door needs — so a cron handler's admin client fits. */
type RpcClient = {
  schema: (name: 'sales') => {
    rpc: (fn: 'clauses_for_proposal', args: { p_proposal_id: string }) => PromiseLike<{
      data: unknown;
      error: { message: string } | null;
    }>;
  };
};

/**
 * The clauses to print for one quotation. A draft gets today's; anything past
 * draft gets the snapshot it took the first time it was rendered, so a
 * re-render never reads today's wording. A failed read is an error — never
 * "no clauses", which would print the defaults over an owner's own words.
 */
export async function clausesForProposal(
  client: unknown,
  proposalId: string,
): Promise<Result<readonly string[]>> {
  const { data, error } = await (client as RpcClient)
    .schema('sales')
    .rpc('clauses_for_proposal', { p_proposal_id: proposalId });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'clausesForProposal', detail: error.message }));
    return err('INTERNAL', 'The quotation clauses could not be read.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; clauses?: unknown } | null | undefined;
  if (row?.outcome === 'live' || row?.outcome === 'frozen') return ok(clauseBodies(parseClauseSnapshot(row.clauses)));
  if (row?.outcome === 'not_found') return err('NOT_FOUND', 'Quotation not found.');
  if (row?.outcome === 'forbidden') return err('FORBIDDEN', 'You do not have permission to read this quotation.');
  return err('INTERNAL', 'The quotation clauses could not be read.');
}
