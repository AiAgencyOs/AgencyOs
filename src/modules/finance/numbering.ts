import { invoiceNumberPrefix, invoicePrefixFrom, parseInvoiceSequence } from './schema';

/**
 * The owner's invoice numbering and terms (PDF §7 "Invoice numbering/terms").
 * Three keys of `core.organizations.settings`, written only by
 * `finance.set_invoice_numbering`:
 *
 *   invoice_number_prefix  1-8 of A-Z / 0-9, default INV
 *   invoice_terms_days     whole days 0-365 — the due date when a milestone
 *                          carries none and the caller named none
 *   invoice_terms_note     free text printed under the invoice's lines
 *
 * Unset means "as before": prefix INV, no default due date, no note. The
 * readers take the `settings` JSON already read, or a client to read it with,
 * so the admin-client job paths and the session paths number identically.
 */
export type InvoiceNumbering = { prefix: string; termsDays: number | null; termsNote: string | null };

type Settings = Record<string, unknown> | null | undefined;

export function termsDaysFrom(raw: unknown): number | null {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!/^[0-9]{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n >= 0 && n <= 365 ? n : null;
}

export function numberingFrom(settings: Settings): InvoiceNumbering {
  const note = typeof settings?.invoice_terms_note === 'string' ? settings.invoice_terms_note.trim() : '';
  return {
    prefix: invoicePrefixFrom(settings?.invoice_number_prefix),
    termsDays: termsDaysFrom(settings?.invoice_terms_days),
    termsNote: note.length > 0 && note.length <= 500 ? note : null,
  };
}

/** Structural type both the session client and the admin client satisfy. */
type Reader = {
  schema: (name: 'core' | 'finance') => {
    from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
};

/** Reads the organization's numbering. A failed read falls back to the defaults it always had; it never blocks a bill. */
export async function readInvoiceNumbering(client: Reader): Promise<InvoiceNumbering> {
  const { data, error } = await client.schema('core').from('organizations').select('settings').limit(1).maybeSingle();
  if (error) {
    console.error(JSON.stringify({ level: 'error', scope: 'readInvoiceNumbering', detail: String(error.message ?? error) }));
    return numberingFrom(null);
  }
  return numberingFrom((data?.settings ?? null) as Settings);
}

/** The highest sequence already used in `year` under `prefix`; RLS supplies the organization scope. */
export async function highestInvoiceSequenceFor(client: Reader, year: number, prefix: string): Promise<number> {
  const { data } = await client
    .schema('finance')
    .from('invoices')
    .select('number')
    .like('number', `${invoiceNumberPrefix(year, prefix)}%`)
    .order('number', { ascending: false })
    .limit(1)
    .maybeSingle();
  return parseInvoiceSequence(data?.number, year, prefix);
}

/** The organization's whole `settings` JSON, for the Settings › Finance form's current values. */
export async function readOrganizationSettingsRow(client: Reader): Promise<Record<string, unknown>> {
  const { data, error } = await client.schema('core').from('organizations').select('settings').limit(1).maybeSingle();
  if (error) throw new Error(`readOrganizationSettingsRow: ${String(error.message ?? error)}`);
  return (data?.settings ?? {}) as Record<string, unknown>;
}
