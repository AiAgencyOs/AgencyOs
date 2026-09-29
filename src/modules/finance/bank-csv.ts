/**
 * The bank statement as a CSV — SCR-053, owner decision 2026-09-29.
 *
 * Two pure functions and nothing else: read the file into lines, and propose
 * which recorded payment or pending claim each line is about. Pure so the
 * panel, the import door and a test all agree on what a line is, and so the
 * proposal can be read on the page without a round-trip.
 *
 * ── the file ─────────────────────────────────────────────────────────────
 *
 * Four columns, found by header name in any order and any case: `date`,
 * `description`, `amount`, `reference` (the last optional). Dates are read
 * as ISO (2026-09-10), day-first with slashes or hyphens (10/09/2026, the
 * shape Indian banks print), or `10 Sep 2026`. Amounts are read as a decimal
 * with optional thousands separators and an optional sign; a `Cr`/`Dr`
 * suffix, or separate `credit`/`debit` columns, are honoured because the
 * statement formats that use them are the common ones. Everything is kept
 * in minor units.
 *
 * A row that cannot be read is reported with its line number and left out;
 * the import door then files what parsed and the panel says what did not.
 */

export type BankCsvLine = {
  /** 1-based position in the file, counting the header as line 1. */
  lineNo: number;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  description: string;
  amountMinor: number;
  reference: string | null;
};

export type BankCsvParse = {
  lines: BankCsvLine[];
  /** One sentence per row that was left out, with its line number. */
  errors: string[];
};

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Split one CSV record into fields, honouring double quotes and doubled quotes. */
export function splitCsvRecord(record: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < record.length; i += 1) {
    const ch = record[i];
    if (quoted) {
      if (ch === '"') {
        if (record[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Split a file into records. A quoted field may contain a newline. */
function splitCsvRecords(text: string): string[] {
  const records: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      records.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  records.push(current);
  return records;
}

/** A date in one of the shapes a bank prints, as YYYY-MM-DD; null when unreadable. */
export function parseStatementDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value);
  if (iso) return checkDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // Day first: 10/09/2026, 10-09-2026, 10.09.26.
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(value);
  if (dmy) {
    const year = dmy[3]!.length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    return checkDate(year, Number(dmy[2]), Number(dmy[1]));
  }

  // 10 Sep 2026, 10-Sep-2026, 10 September 2026.
  const dMonY = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ ,-]+(\d{2}|\d{4})$/.exec(value);
  if (dMonY) {
    const month = MONTHS[dMonY[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[dMonY[2]!.slice(0, 3).toLowerCase()];
    if (!month) return null;
    const year = dMonY[3]!.length === 2 ? 2000 + Number(dMonY[3]) : Number(dMonY[3]);
    return checkDate(year, month, Number(dMonY[1]));
  }

  return null;
}

function checkDate(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * An amount as minor units. Accepts `45,000.00`, `-1200`, `(1200)` for a
 * debit, `₹ 45000`, and a trailing `Cr` / `Dr`. Null when unreadable.
 */
export function parseStatementAmount(raw: string): number | null {
  let value = raw.trim();
  if (!value) return null;

  let sign = 1;
  const suffix = /\s*(cr|dr)\.?$/i.exec(value);
  if (suffix) {
    if (suffix[1]!.toLowerCase() === 'dr') sign = -1;
    value = value.slice(0, suffix.index);
  }
  if (/^\(.*\)$/.test(value)) {
    sign = -1;
    value = value.slice(1, -1);
  }
  value = value.replace(/[\s,₹$€£]/g, '');
  if (value.startsWith('-')) {
    sign = -sign;
    value = value.slice(1);
  } else if (value.startsWith('+')) {
    value = value.slice(1);
  }

  const match = /^(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) return null;
  const whole = match[1] === '' ? 0 : Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) return null;
  const minor = whole * 100 + Number(fraction.slice(0, 2));
  if (!Number.isSafeInteger(minor)) return null;
  return sign * minor;
}

const HEADER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  date: ['date', 'txn date', 'transaction date', 'value date', 'posting date'],
  description: ['description', 'narration', 'particulars', 'details', 'remarks', 'transaction details'],
  amount: ['amount', 'transaction amount', 'amt'],
  credit: ['credit', 'credit amount', 'deposit', 'cr'],
  debit: ['debit', 'debit amount', 'withdrawal', 'dr'],
  reference: ['reference', 'ref', 'ref no', 'ref no.', 'reference no', 'reference no.', 'utr', 'cheque no', 'chq no', 'transaction id'],
};

function headerIndex(headers: string[], want: keyof typeof HEADER_ALIASES): number {
  const names = HEADER_ALIASES[want]!;
  return headers.findIndex((h) => names.includes(h.trim().toLowerCase().replace(/\s+/g, ' ')));
}

/**
 * Read a whole CSV. Never throws: an unreadable file is zero lines and an
 * error naming what was wrong, so the door can refuse with a sentence.
 */
export function parseBankCsv(text: string): BankCsvParse {
  const records = splitCsvRecords(text.replace(/^\uFEFF/, ''));
  const errors: string[] = [];
  const lines: BankCsvLine[] = [];

  const headerAt = records.findIndex((r) => r.trim() !== '');
  if (headerAt < 0) return { lines, errors: ['The file is empty.'] };

  const headers = splitCsvRecord(records[headerAt]!);
  const dateAt = headerIndex(headers, 'date');
  const descAt = headerIndex(headers, 'description');
  const amountAt = headerIndex(headers, 'amount');
  const creditAt = headerIndex(headers, 'credit');
  const debitAt = headerIndex(headers, 'debit');
  const refAt = headerIndex(headers, 'reference');

  const missing: string[] = [];
  if (dateAt < 0) missing.push('date');
  if (descAt < 0) missing.push('description');
  if (amountAt < 0 && creditAt < 0 && debitAt < 0) missing.push('amount');
  if (missing.length > 0) {
    return {
      lines,
      errors: [`The header row has no ${missing.join(', ')} column. Expected: date, description, amount, reference.`],
    };
  }

  for (let i = headerAt + 1; i < records.length; i += 1) {
    const record = records[i]!;
    if (record.trim() === '') continue;
    const lineNo = i + 1;
    const fields = splitCsvRecord(record);

    const date = parseStatementDate(fields[dateAt] ?? '');
    if (!date) {
      errors.push(`Line ${lineNo}: "${fields[dateAt] ?? ''}" is not a date.`);
      continue;
    }

    const description = (fields[descAt] ?? '').trim();
    if (!description) {
      errors.push(`Line ${lineNo}: no description.`);
      continue;
    }

    let amountMinor: number | null = null;
    if (amountAt >= 0 && (fields[amountAt] ?? '').trim() !== '') {
      amountMinor = parseStatementAmount(fields[amountAt]!);
    } else {
      const credit = creditAt >= 0 && (fields[creditAt] ?? '').trim() !== '' ? parseStatementAmount(fields[creditAt]!) : null;
      const debit = debitAt >= 0 && (fields[debitAt] ?? '').trim() !== '' ? parseStatementAmount(fields[debitAt]!) : null;
      if (credit !== null && credit !== 0) amountMinor = Math.abs(credit);
      else if (debit !== null && debit !== 0) amountMinor = -Math.abs(debit);
      else if (credit === 0 || debit === 0) amountMinor = 0;
    }
    if (amountMinor === null) {
      errors.push(`Line ${lineNo}: the amount could not be read.`);
      continue;
    }

    const reference = refAt >= 0 ? (fields[refAt] ?? '').trim() : '';
    lines.push({
      lineNo,
      date,
      description: description.slice(0, 500),
      amountMinor,
      reference: reference ? reference.slice(0, 200) : null,
    });
  }

  return { lines, errors };
}

// ── proposing matches ─────────────────────────────────────────────────────

export type MatchCandidate = {
  kind: 'payment' | 'claim';
  id: string;
  amountMinor: number;
  /** The provider's id, a UTR, whatever reference the record carries. */
  reference: string | null;
  /** Something a person can recognise: the invoice number, the payer. */
  label: string;
  /** For a claim, the invoice it is against; for a payment, the same. */
  invoiceNumber: string | null;
};

export type MatchProposal = {
  lineId: string;
  /** The one candidate this is confident about, or null. */
  candidate: MatchCandidate | null;
  /** Why. Read on the page beside the proposal. */
  reason: 'reference_and_amount' | 'reference' | 'amount' | 'ambiguous' | 'none';
  /** Every candidate with the same amount, for the picker. */
  sameAmount: MatchCandidate[];
};

export type BankLineForMatching = {
  id: string;
  amountMinor: number;
  reference: string | null;
  description: string;
};

/** Letters and digits only, lower case — how a UTR survives a bank's formatting. */
export function normaliseReference(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Which record each line is about — §29's auto-match, on the uploaded lines.
 *
 * Confidence, in order:
 *   1. the line's reference (or its description) contains the candidate's
 *      reference AND the amounts agree — one candidate;
 *   2. the reference alone matches — one candidate;
 *   3. exactly one candidate has this amount;
 *   otherwise the line is `ambiguous` (several by amount) or `none`.
 *
 * A candidate is offered to at most one line: once proposed with a
 * reference match it is taken out of the amount-only pool, so two ₹45,000
 * lines do not both get the same payment. It proposes; nothing is written.
 */
export function proposeMatches(
  lines: readonly BankLineForMatching[],
  candidates: readonly MatchCandidate[],
): MatchProposal[] {
  const taken = new Set<string>();
  const proposals = new Map<string, MatchProposal>();

  // Pass 1 — by reference, strongest first, so a reference hit claims its
  // candidate before an amount-only line can.
  for (const line of lines) {
    const haystack = normaliseReference(`${line.reference ?? ''} ${line.description}`);
    const byRef = candidates.filter((c) => {
      const ref = normaliseReference(c.reference);
      return ref.length >= 6 && haystack.includes(ref) && !taken.has(`${c.kind}:${c.id}`);
    });
    if (byRef.length === 0) continue;
    const withAmount = byRef.filter((c) => c.amountMinor === line.amountMinor);
    const pick = withAmount.length === 1 ? withAmount[0]! : byRef.length === 1 ? byRef[0]! : null;
    if (!pick) continue;
    taken.add(`${pick.kind}:${pick.id}`);
    proposals.set(line.id, {
      lineId: line.id,
      candidate: pick,
      reason: pick.amountMinor === line.amountMinor ? 'reference_and_amount' : 'reference',
      sameAmount: candidates.filter((c) => c.amountMinor === line.amountMinor),
    });
  }

  // Pass 2 — by amount, for the rest.
  return lines.map((line) => {
    const already = proposals.get(line.id);
    if (already) return already;
    const sameAmount = candidates.filter((c) => c.amountMinor === line.amountMinor);
    const free = sameAmount.filter((c) => !taken.has(`${c.kind}:${c.id}`));
    if (free.length === 1) {
      taken.add(`${free[0]!.kind}:${free[0]!.id}`);
      return { lineId: line.id, candidate: free[0]!, reason: 'amount', sameAmount };
    }
    return { lineId: line.id, candidate: null, reason: free.length > 1 ? 'ambiguous' : 'none', sameAmount };
  });
}
