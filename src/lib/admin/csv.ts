/**
 * A CSV body from rows of cells — the one place the quoting rule lives, so the
 * three export routes (invoices, expenses, usage) cannot each get it subtly
 * wrong. RFC 4180: a cell holding a comma, a quote or a line break is wrapped
 * in quotes and its quotes doubled. Numbers are written as they are; the
 * caller decides whether minor units become major before they reach here.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a quote so a spreadsheet
 * opening the file does not execute a cell that came from user-entered text
 * (a vendor name, a description) as a formula.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'number' ? String(value) : value;
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return [header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n';
}

/** The response headers a CSV download needs; `no-store` because the rows move. */
export function csvHeaders(filename: string): Record<string, string> {
  return {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  };
}
