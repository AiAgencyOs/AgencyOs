import 'server-only';

import { requireInternal } from '@/lib/auth/session';
import { hasRole } from '@/lib/authz/permissions';
import { createClient } from '@/lib/db/server';
import { err, ok, type Result } from '@/lib/result';

import { inForce, isClauseKey, validateClauseBody, type ClauseKey, type ClauseSnapshot, type ClauseVersion } from './quotation-clauses';

/**
 * The quotation clauses the owner can edit — configurability audit B-6.
 *
 * Two doors, both in the database (`core.list_quotation_clauses`,
 * `core.publish_quotation_clause`); this file is the session-bound face of
 * them. Reading is every internal role, and a failed read is an error — never
 * an empty list, which would tell the owner nothing has been published while
 * quotations go on printing what they published. Publishing is owner or ops
 * admin, said here first with a better sentence and decided again by the
 * database, which is the one that counts.
 */

type ListedRow = {
  clause_key: string;
  version: number;
  body: string;
  effective_from: string;
  created_by: string;
  created_by_name: string | null;
};

/** Every published version of every clause, newest first within each clause. */
export async function readQuotationClauses(): Promise<Result<ClauseVersion[]>> {
  // Every internal role reads; the database's own is_internal() is the gate.
  await requireInternal();

  const supabase = await createClient();
  const { data, error } = await supabase.schema('core').rpc('list_quotation_clauses');
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'readQuotationClauses', detail: error.message }));
    return err('INTERNAL', 'The quotation clauses could not be read.');
  }
  const rows = (Array.isArray(data) ? data : []) as ListedRow[];
  return ok(
    rows
      .filter((r) => isClauseKey(r.clause_key))
      .map((r) => ({
        key: r.clause_key as ClauseKey,
        version: r.version,
        body: r.body,
        effectiveFrom: r.effective_from,
        createdBy: r.created_by,
        createdByName: r.created_by_name,
      })),
  );
}

/** What a new quotation would print now: the newest version of each clause. */
export async function readClausesInForce(): Promise<Result<ClauseSnapshot>> {
  const versions = await readQuotationClauses();
  if (!versions.ok) return versions;
  return ok(inForce(versions.data));
}

/** Publish a new version of one clause. Appends; never edits an earlier one. */
export async function publishQuotationClause(input: {
  key: string;
  body: string;
}): Promise<Result<{ key: ClauseKey; version: number | null; unchanged: boolean }>> {
  if (!isClauseKey(input.key)) return err('VALIDATION', 'Choose one of the four clauses.');
  const body = validateClauseBody(input.body);
  if (!body.ok) return body;

  const context = await requireInternal();
  if (!hasRole(context, 'owner') && !hasRole(context, 'ops_admin')) {
    return err('FORBIDDEN', 'Only an owner or ops admin can publish quotation clauses.');
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('core')
    .rpc('publish_quotation_clause', { p_key: input.key, p_body: body.data });
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'publishQuotationClause', detail: error.message }));
    return err('INTERNAL', 'Could not publish the clause.');
  }
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; version?: number | null } | undefined;
  switch (row?.outcome) {
    case 'published':
      return ok({ key: input.key, version: row.version ?? null, unchanged: false });
    case 'unchanged':
      return ok({ key: input.key, version: row.version ?? null, unchanged: true });
    case 'not_authorized':
    case 'no_actor':
      return err('FORBIDDEN', 'The database refused: only an owner or ops admin can publish quotation clauses.');
    case 'invalid_key':
      return err('VALIDATION', 'That is not one of the four clauses.');
    case 'invalid_body':
      return err('VALIDATION', 'That wording is not valid — 10 to 1200 characters, plain text, one line.');
    default:
      return err('INTERNAL', 'Could not publish the clause.');
  }
}
