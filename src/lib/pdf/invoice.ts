import { PDFDocument, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

import { quotationFontBytes } from './fonts';

/**
 * The invoice as a document — SCR-051's "Invoice PDF (a renderer, like the
 * quotation's)".
 *
 * The same discipline as `quotation.ts`, which this mirrors on purpose:
 * nothing is invented. The renderer draws what the invoice row, its lines,
 * the billing profile and the receiving accounts record, and stops. A zero
 * tax line on a Non-GST invoice is not drawn as "GST: ₹0"; a missing due
 * date is not defaulted; an account nobody configured is not made up.
 *
 * **Deterministic.** The PDF's metadata date is the invoice's own
 * `issuedAt` (or `createdAt` for a draft), not the wall clock, so the same
 * invoice renders to the same bytes twice.
 *
 * **Honest about status.** A draft or pending-approval invoice carries a
 * band saying so AND a large, faint DRAFT watermark across the page — a
 * draft that looks final IS a final invoice to whoever the client forwards
 * it to, and an invoice number on a document that was never issued is
 * exactly the confusion the watermark exists to prevent. Void is banded
 * too; paid is stated. The clean set is closed (issued, partially_paid,
 * overdue) and anything unknown is banded, fail-closed.
 *
 * Lives in `src/lib` and knows nothing about the finance module: the caller
 * maps its rows into `InvoicePdfInput`.
 */

export interface InvoicePdfInput {
  organizationName: string;
  /** How to reach the agency — drawn only when set. */
  contactLine?: string | null;
  number: string;
  /** The invoice status verbatim. */
  status: string;
  currency: string;
  /** Who is billed — every field as recorded, each drawn only when present. */
  billedTo: {
    clientName: string | null;
    legalName: string | null;
    gstin: string | null;
    billingState: string | null;
    billingAddress: string | null;
    /** The confirmed billing mode, or null when the project never confirmed one. */
    mode: 'gst' | 'non_gst' | null;
    version: number | null;
  };
  projectName: string | null;
  /** The project's identifier for life (CL-000042-P03). Its client's identifier is the part before `-P`. Drawn only when the invoice is for a project. */
  projectCode?: string | null;
  milestoneLabel: string | null;
  items: ReadonlyArray<{
    description: string;
    quantity: number;
    unitPriceMinor: number;
    amountMinor: number;
    taxRateBp: number;
  }>;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  /** ISO timestamps as recorded, or null. */
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  createdAt: string;
  notes: string | null;
  /** The agency's active receiving accounts, already flattened to label/value pairs. */
  receivingAccounts: ReadonlyArray<{
    label: string;
    kindLabel: string;
    fields: ReadonlyArray<{ label: string; value: string }>;
  }>;
  timeZone: string;
  /** The invoice id — the traceability line in the footer. */
  reference: string;
}

export interface InvoicePdfResult {
  bytes: Uint8Array;
  /** Every string drawn, in draw order — the render's testable transcript. */
  drawnText: string[];
  replacedCharacters: string[];
}

// ── the fixed geometry ─────────────────────────────────────────────────────

const A4 = { width: 595.28, height: 841.89 } as const;
const MARGIN = 56;
const CONTENT_WIDTH = A4.width - MARGIN * 2;
const FOOTER_ROOM = 40;

const INK = rgb(0.12, 0.13, 0.16);
const MUTED = rgb(0.45, 0.47, 0.52);
const RULE = rgb(0.85, 0.86, 0.88);
const BAND_INK = rgb(0.55, 0.24, 0.08);
const BAND_FILL = rgb(0.99, 0.95, 0.9);
const WATERMARK = rgb(0.86, 0.86, 0.88);

/**
 * What each status is allowed to look like. The clean list is closed; an
 * unknown status is a status somebody added after this was written, and the
 * safe reading of "I do not know what this is" is "then it is not a final
 * invoice".
 */
const CLEAN_STATUSES = new Set(['issued', 'partially_paid', 'overdue', 'paid']);

export function invoiceStatusBandFor(status: string): string | null {
  if (CLEAN_STATUSES.has(status)) return null;
  switch (status) {
    case 'draft':
      return 'DRAFT — NOT YET ISSUED. THIS IS NOT A TAX INVOICE.';
    case 'pending_approval':
      return 'DRAFT — AWAITING INTERNAL APPROVAL. THIS IS NOT A TAX INVOICE.';
    case 'void':
      return 'VOID — THIS INVOICE HAS BEEN WITHDRAWN';
    default:
      return `NOT ISSUED — STATUS: ${status.toUpperCase().replace(/_/g, ' ')}`;
  }
}

/** A draft, in either of its two states, is watermarked; nothing else is. */
export function invoiceWatermarkFor(status: string): string | null {
  if (status === 'draft' || status === 'pending_approval') return 'DRAFT';
  if (status === 'void') return 'VOID';
  return null;
}

function moneyFormatter(currency: string): (minor: number) => string {
  const fmt = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: 2,
  });
  return (minor: number) => fmt.format(minor / 100);
}

function dateOnly(iso: string, timeZone: string): string {
  const bare = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (bare) {
    return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]))));
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(parsed);
}

/**
 * The document's own arithmetic, checked before a glyph is drawn — the same
 * gate the quotation renderer keeps (G-167). The lines and the totals arrive
 * from separate queries; a Total with lines that do not sum to it is the one
 * defect a client-facing bill must never ship.
 */
export function invoiceArithmeticFault(input: {
  items: ReadonlyArray<{ amountMinor: number }>;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}): string | null {
  if (input.items.length > 0) {
    const lines = input.items.reduce((sum, item) => sum + item.amountMinor, 0);
    if (lines !== input.subtotalMinor) {
      return `the ${input.items.length} line(s) drawn sum to ${lines} but the subtotal drawn says ${input.subtotalMinor}`;
    }
  }
  if (input.subtotalMinor + input.taxMinor !== input.totalMinor) {
    return `subtotal + tax is ${input.subtotalMinor + input.taxMinor} but the total drawn says ${input.totalMinor}`;
  }
  return null;
}

/** A filename every filesystem will take without mangling. */
/** A project code is its client's code plus `-P<nn>` (assigned by the database), so the client's identifier is read off it. */
export function clientCodeOfProject(projectCode: string | null | undefined): string | null {
  const m = /^(CL-\d{6,})-P\d{2,}$/.exec(projectCode ?? '');
  return m ? m[1]! : null;
}

export function invoicePdfFilename(number: string, status: string): string {
  const slug = number
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const draft = status === 'draft' || status === 'pending_approval' ? '-DRAFT' : '';
  return `Invoice-${slug || 'document'}${draft}.pdf`;
}

/** "GST @ 18%" from the lines' basis points, when the invoice is a GST one. */
export function invoiceGstLabel(mode: 'gst' | 'non_gst' | null, items: ReadonlyArray<{ taxRateBp: number }>): string {
  if (mode !== 'gst') return 'Tax';
  const rates = [...new Set(items.map((i) => i.taxRateBp).filter((bp) => bp > 0))];
  if (rates.length === 1) return `GST @ ${(rates[0]! / 100).toString().replace(/\.0+$/, '')}%`;
  return 'GST';
}

// ── the renderer ───────────────────────────────────────────────────────────

interface Cursor {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  pages: PDFPage[];
  continuationHeader: (page: PDFPage) => number;
}

function ensureRoom(c: Cursor, height: number): void {
  if (c.y - height >= MARGIN + FOOTER_ROOM) return;
  c.page = c.doc.addPage([A4.width, A4.height]);
  c.pages.push(c.page);
  c.y = c.continuationHeader(c.page);
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const pieces: string[] = [];
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut -= 1;
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      pieces.push(rest);
      for (const piece of pieces) {
        const candidate = line ? `${line} ${piece}` : piece;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth || line === '') {
          line = candidate;
        } else {
          lines.push(line);
          line = piece;
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<InvoicePdfResult> {
  const fault = invoiceArithmeticFault(input);
  if (fault) throw new Error(`Invoice arithmetic does not hold — ${fault}`);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = quotationFontBytes();
  const regular = await doc.embedFont(fontBytes.regular, { subset: false });
  const bold = await doc.embedFont(fontBytes.bold, { subset: false });

  const charset = new Set(regular.getCharacterSet());
  charset.add('\n'.codePointAt(0)!);
  const replaced = new Set<string>();
  const clean = (text: string): string =>
    Array.from(text.replace(/\r\n?/g, '\n'), (ch) => {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x09) return ' ';
      if (cp !== 0x0a && cp < 0x20) return '';
      if (charset.has(cp)) return ch;
      replaced.add(ch);
      return '?';
    }).join('');
  const cleanLine = (text: string): string => clean(text).replace(/\n+/g, ' ').trim();

  const drawn: string[] = [];
  const draw = (page: PDFPage, text: string, options: Parameters<PDFPage['drawText']>[1]) => {
    drawn.push(text);
    page.drawText(text, options);
  };

  const money = moneyFormatter(input.currency);
  const organizationName = cleanLine(input.organizationName);
  const number = cleanLine(input.number);
  const watermark = invoiceWatermarkFor(input.status);

  // Painted first on every page, under everything else.
  const paintWatermark = (page: PDFPage) => {
    if (!watermark) return;
    const size = 140;
    const width = bold.widthOfTextAtSize(watermark, size);
    draw(page, watermark, {
      x: A4.width / 2 - (width / 2) * Math.cos(Math.PI / 4) + 40,
      y: A4.height / 2 - (width / 2) * Math.sin(Math.PI / 4) - 20,
      size,
      font: bold,
      color: WATERMARK,
      rotate: degrees(45),
      opacity: 0.5,
    });
  };

  const firstPage = doc.addPage([A4.width, A4.height]);
  paintWatermark(firstPage);
  const pages = [firstPage];

  const continuationHeader = (page: PDFPage): number => {
    paintWatermark(page);
    const size = 9;
    draw(page, organizationName, { x: MARGIN, y: A4.height - MARGIN + 8, size, font: bold, color: MUTED });
    const label = `Invoice ${number} (continued)`;
    draw(page, label, {
      x: A4.width - MARGIN - regular.widthOfTextAtSize(label, size),
      y: A4.height - MARGIN + 8,
      size,
      font: regular,
      color: MUTED,
    });
    page.drawLine({
      start: { x: MARGIN, y: A4.height - MARGIN },
      end: { x: A4.width - MARGIN, y: A4.height - MARGIN },
      thickness: 0.5,
      color: RULE,
    });
    return A4.height - MARGIN - 24;
  };

  const c: Cursor = { doc, page: firstPage, y: 0, pages, continuationHeader };

  // ── header ──
  let y = A4.height - MARGIN;
  draw(c.page, organizationName, { x: MARGIN, y, size: 13, font: bold, color: INK });
  const kind = input.billedTo.mode === 'gst' ? 'TAX INVOICE' : 'INVOICE';
  draw(c.page, kind, {
    x: A4.width - MARGIN - regular.widthOfTextAtSize(kind, 10),
    y: y + 1,
    size: 10,
    font: regular,
    color: MUTED,
  });
  if (input.contactLine) {
    draw(c.page, cleanLine(input.contactLine), { x: MARGIN, y: y - 12, size: 8.5, font: regular, color: MUTED });
    y -= 12;
  }
  y -= 14;
  c.page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.width - MARGIN, y }, thickness: 1, color: RULE });
  y -= 28;

  // ── the status band, before the content it qualifies ──
  const band = invoiceStatusBandFor(input.status);
  if (band) {
    const bandHeight = 26;
    c.page.drawRectangle({
      x: MARGIN,
      y: y - bandHeight + 8,
      width: CONTENT_WIDTH,
      height: bandHeight,
      color: BAND_FILL,
      borderColor: BAND_INK,
      borderWidth: 0.75,
    });
    draw(c.page, clean(band), {
      x: MARGIN + 10,
      y: y - bandHeight + 8 + (bandHeight - 9) / 2,
      size: 9,
      font: bold,
      color: BAND_INK,
    });
    y -= bandHeight + 12;
  }

  // ── number and dates ──
  draw(c.page, number, { x: MARGIN, y: y - 20, size: 20, font: bold, color: INK });
  y -= 30;
  const metaParts: string[] = [];
  if (input.issuedAt) metaParts.push(`Issued ${dateOnly(input.issuedAt, input.timeZone)}`);
  else metaParts.push(`Drafted ${dateOnly(input.createdAt, input.timeZone)}`);
  if (input.dueAt) metaParts.push(`Due ${dateOnly(input.dueAt, input.timeZone)}`);
  if (input.paidAt) metaParts.push(`Paid ${dateOnly(input.paidAt, input.timeZone)}`);
  draw(c.page, clean(metaParts.join('   ·   ')), { x: MARGIN, y: y - 10, size: 9.5, font: regular, color: MUTED });
  y -= 24;

  // ── billed to / for ──
  {
    const half = CONTENT_WIDTH / 2;
    const left: string[] = [];
    const b = input.billedTo;
    if (b.legalName) left.push(b.legalName);
    if (b.clientName && b.clientName !== b.legalName) left.push(b.clientName);
    const clientCode = clientCodeOfProject(input.projectCode);
    if (clientCode) left.push(`Client ID ${clientCode}`);
    if (b.billingAddress) left.push(...b.billingAddress.split('\n').map((l) => l.trim()).filter(Boolean));
    if (b.billingState) left.push(b.billingState);
    if (b.gstin) left.push(`GSTIN ${b.gstin}`);
    if (b.mode) left.push(b.mode === 'gst' ? `GST billing${b.version ? ` (v${b.version})` : ''}` : `Non-GST billing${b.version ? ` (v${b.version})` : ''}`);
    else left.push('Billing mode not confirmed');

    const right: string[] = [];
    if (input.projectName) right.push(input.projectName);
    if (input.projectCode) right.push(`Project ID ${input.projectCode}`);
    if (input.milestoneLabel) right.push(input.milestoneLabel);

    draw(c.page, 'BILLED TO', { x: MARGIN, y: y - 8, size: 7.5, font: bold, color: MUTED });
    if (right.length > 0) draw(c.page, 'FOR', { x: MARGIN + half, y: y - 8, size: 7.5, font: bold, color: MUTED });
    y -= 12;
    const size = 10;
    const leading = 14;
    let ly = y;
    for (const line of left) {
      for (const w of wrap(cleanLine(line), regular, size, half - 12)) {
        draw(c.page, w, { x: MARGIN, y: ly - size, size, font: regular, color: INK });
        ly -= leading;
      }
    }
    let ry = y;
    for (const line of right) {
      for (const w of wrap(cleanLine(line), regular, size, half - 12)) {
        draw(c.page, w, { x: MARGIN + half, y: ry - size, size, font: regular, color: INK });
        ry -= leading;
      }
    }
    y = Math.min(ly, ry) - 10;
  }

  c.y = y;

  // ── the lines ──
  if (input.items.length > 0) {
    const amountColumn = 100;
    const unitColumn = 90;
    const qtyColumn = 40;
    const descWidth = CONTENT_WIDTH - amountColumn - unitColumn - qtyColumn;
    const size = 10;
    const leading = 15;

    ensureRoom(c, 30 + leading + 10);
    draw(c.page, 'DESCRIPTION', { x: MARGIN, y: c.y - 8, size: 7.5, font: bold, color: MUTED });
    const header = (label: string, right: number) =>
      draw(c.page, label, { x: right - bold.widthOfTextAtSize(label, 7.5), y: c.y - 8, size: 7.5, font: bold, color: MUTED });
    header('QTY', MARGIN + descWidth + qtyColumn);
    header('UNIT', MARGIN + descWidth + qtyColumn + unitColumn);
    header('AMOUNT', A4.width - MARGIN);
    c.y -= 14;
    c.page.drawLine({ start: { x: MARGIN, y: c.y }, end: { x: A4.width - MARGIN, y: c.y }, thickness: 0.75, color: RULE });
    c.y -= 4;

    for (const item of input.items) {
      const descLines = wrap(clean(item.description), regular, size, descWidth - 12);
      const rowHeight = descLines.length * leading + 6;
      ensureRoom(c, rowHeight + 4);
      const rowTop = c.y;
      descLines.forEach((line, i) => {
        draw(c.page, line, { x: MARGIN, y: rowTop - size - i * leading - 4, size, font: regular, color: INK });
      });
      const cell = (text: string, right: number, color = INK) =>
        draw(c.page, text, { x: right - regular.widthOfTextAtSize(text, size), y: rowTop - size - 4, size, font: regular, color });
      cell(String(item.quantity).replace(/\.0+$/, ''), MARGIN + descWidth + qtyColumn, MUTED);
      cell(clean(money(item.unitPriceMinor)), MARGIN + descWidth + qtyColumn + unitColumn, MUTED);
      cell(clean(money(item.amountMinor)), A4.width - MARGIN);
      c.y -= rowHeight;
      c.page.drawLine({ start: { x: MARGIN, y: c.y }, end: { x: A4.width - MARGIN, y: c.y }, thickness: 0.4, color: RULE });
      c.y -= 2;
    }
    c.y -= 12;
  }

  // ── the money ──
  {
    const rows: Array<{ label: string; value: string; strong?: boolean }> = [];
    rows.push({ label: 'Subtotal', value: money(input.subtotalMinor) });
    if (input.taxMinor > 0 || input.billedTo.mode === 'gst') {
      rows.push({ label: invoiceGstLabel(input.billedTo.mode, input.items), value: money(input.taxMinor) });
    }
    rows.push({ label: 'Total', value: money(input.totalMinor), strong: true });
    if (input.paidMinor > 0) {
      rows.push({ label: 'Paid', value: money(input.paidMinor) });
      rows.push({ label: 'Balance due', value: money(input.totalMinor - input.paidMinor), strong: true });
    }

    const blockWidth = 240;
    const rowHeight = 17;
    ensureRoom(c, rows.length * rowHeight + 14);
    const left = A4.width - MARGIN - blockWidth;
    for (const row of rows) {
      const font = row.strong ? bold : regular;
      const size = row.strong ? 11.5 : 10;
      if (row.strong) {
        c.page.drawLine({ start: { x: left, y: c.y + 2 }, end: { x: A4.width - MARGIN, y: c.y + 2 }, thickness: 0.75, color: RULE });
        c.y -= 6;
      }
      draw(c.page, row.label, { x: left, y: c.y - size, size, font, color: row.strong ? INK : MUTED });
      const value = clean(row.value);
      draw(c.page, value, { x: A4.width - MARGIN - font.widthOfTextAtSize(value, size), y: c.y - size, size, font, color: INK });
      c.y -= rowHeight;
    }
  }

  const sectionLabel = (label: string) => {
    ensureRoom(c, 26 + 14);
    c.y -= 8;
    draw(c.page, label, { x: MARGIN, y: c.y - 8, size: 7.5, font: bold, color: MUTED });
    c.y -= 18;
  };

  // ── where to pay — only what is configured ──
  if (input.receivingAccounts.length > 0) {
    sectionLabel('PAY INTO');
    const size = 9.5;
    const leading = 14;
    for (const account of input.receivingAccounts) {
      ensureRoom(c, leading * 2);
      draw(c.page, cleanLine(`${account.label} — ${account.kindLabel}`), { x: MARGIN, y: c.y - size, size, font: bold, color: INK });
      c.y -= leading;
      for (const field of account.fields) {
        for (const line of wrap(cleanLine(`${field.label}: ${field.value}`), regular, size, CONTENT_WIDTH - 12)) {
          ensureRoom(c, leading);
          draw(c.page, line, { x: MARGIN + 12, y: c.y - size, size, font: regular, color: INK });
          c.y -= leading;
        }
      }
      c.y -= 4;
    }
  }

  // ── notes, as recorded ──
  if (input.notes && input.notes.trim()) {
    sectionLabel('NOTES');
    const size = 9.5;
    const leading = 14;
    for (const line of wrap(clean(input.notes), regular, size, CONTENT_WIDTH)) {
      ensureRoom(c, leading);
      draw(c.page, line, { x: MARGIN, y: c.y - size, size, font: regular, color: INK });
      c.y -= leading;
    }
  }

  // ── footer on every page ──
  const total = pages.length;
  pages.forEach((page, i) => {
    page.drawLine({ start: { x: MARGIN, y: MARGIN - 8 }, end: { x: A4.width - MARGIN, y: MARGIN - 8 }, thickness: 0.5, color: RULE });
    const trace = clean(`Invoice ${input.reference}`);
    draw(page, trace, { x: MARGIN, y: MARGIN - 20, size: 7.5, font: regular, color: MUTED });
    const pageLabel = `Page ${i + 1} of ${total}`;
    draw(page, pageLabel, {
      x: A4.width - MARGIN - regular.widthOfTextAtSize(pageLabel, 7.5),
      y: MARGIN - 20,
      size: 7.5,
      font: regular,
      color: MUTED,
    });
  });

  // ── metadata: the record's own facts ──
  const stamped = new Date(input.issuedAt ?? input.createdAt);
  const metadataDate = Number.isNaN(stamped.getTime()) ? new Date(0) : stamped;
  doc.setTitle(`Invoice ${number}${watermark ? ` (${watermark})` : ''}`);
  doc.setSubject(organizationName);
  doc.setCreator('AgencyOS');
  doc.setProducer('AgencyOS');
  doc.setCreationDate(metadataDate);
  doc.setModificationDate(metadataDate);

  return { bytes: await doc.save(), drawnText: drawn, replacedCharacters: [...replaced] };
}
