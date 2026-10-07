import { looseSchema } from '@/lib/p13/loose-client';

import type { QuoteTaxConfig } from './quotation-standards';

/**
 * P1-QUOTE-024: the tax the quotation PRINTS comes from the organisation's own configuration (`sales.p1o_quote_tax_config`, the same row the tax is computed
 * from), not from a rate written into the wording. Returns the configuration, or null when none is saved. A read that fails THROWS: "no configuration" and "could
 * not read it" are different things, and a quotation must never be rendered on the strength of a guess about which it was.
 *
 * `organizationId` is required for a service-role client (which sees every organisation); a signed-in client is already scoped by row-level security.
 */
export class QuoteTaxUnreadable extends Error {}

type Db = { schema(name: never): unknown };

export async function readQuoteTax(db: Db, organizationId?: string): Promise<QuoteTaxConfig | null> {
  let query = looseSchema(db, 'sales').from('p1o_quote_tax_config').select('mode, rate_bp');
  if (organizationId) query = query.eq('organization_id', organizationId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new QuoteTaxUnreadable(`could not read the tax configuration: ${error.message}`);
  const row = data as { mode?: unknown; rate_bp?: unknown } | null;
  if (!row) return null;
  const rateBp = Number(row.rate_bp);
  if ((row.mode !== 'gst' && row.mode !== 'non_gst') || !Number.isInteger(rateBp)) throw new QuoteTaxUnreadable('the tax configuration is not in a shape this quotation can print');
  return { mode: row.mode, rateBp };
}
