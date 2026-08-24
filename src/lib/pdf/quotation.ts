import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

import { quotationFontBytes } from './fonts';

/**
 * The quotation as a document — brief §12.
 *
 * A WhatsApp message is read once and scrolls away; the PDF is the version of
 * a quotation somebody saves, forwards to a partner, or prints. §12's bar is
 * "professional, readable, structured, branded, versioned, traceable" — and
 * its last line is the one this module is actually built around: **"Do not
 * add undocumented commercial commitments."**
 *
 * So the rule is the same one `quotationMessage` follows: nothing is
 * invented. A zero discount is not a "Discount: ₹0" row, a missing validity
 * is not a made-up one, an empty body is not boilerplate. The document
 * renders what the proposal row records and stops.
 *
 * Two properties are deliberate and tested:
 *
 * **Deterministic.** The same proposal renders to the same bytes — the
 * creation date in the PDF metadata is the proposal's own `preparedAt`, not
 * the wall clock, and nothing else in here reads time or randomness. A
 * quotation is a record; two renderings of one record that differ would be
 * two documents claiming to be one.
 *
 * **Honest about status.** Anything not yet — or no longer — an approved
 * quotation carries a labelled band saying exactly what it is. The list of
 * states that render clean is closed (approved, sent, accepted) and every
 * other state, including one this module has never heard of, gets a band.
 * Fail-closed, because ADM-76's warning is precisely that an invented (or
 * merely premature) record is indistinguishable from a real one — a draft
 * PDF that looks final IS a final PDF to whoever the client forwards it to.
 *
 * This lives in `src/lib` and therefore knows nothing about the sales
 * module: the caller maps its rows into `QuotationPdfInput`.
 */

export interface QuotationPdfInput {
  /** The agency's own name — the branding line. */
  organizationName: string;
  /** The client or project this was prepared for, where known. Never invented. */
  preparedFor: string | null;
  title: string;
  version: number;
  /** The proposal's status verbatim; anything but approved/sent/accepted gets a band. */
  status: string;
  /** The proposal body — the summary that names what is and is NOT covered. */
  body: string | null;
  currency: string;
  items: ReadonlyArray<{
    description: string;
    quantity: number;
    amountMinor: number;
    /** Bullet-level contents of the line (G-165); absent on legacy quotations. */
    features?: readonly string[];
  }>;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** As recorded (a date string), or absent — never defaulted. */
  validUntil: string | null;
  /** The proposal's own created_at (ISO). Doubles as the PDF's metadata date. */
  preparedAt: string;
  /** The zone the agency reads its clock in — dates are rendered in it. */
  timeZone: string;
  /** The proposal id — the traceability line in the footer. */
  reference: string;
  /**
   * The document sections beyond the lines (G-165) — every field optional,
   * and a legacy quotation with none renders exactly as it always did. The
   * judgment sections come from the stored document; the policy sections
   * (payment, timeline, support, GST, scope rule, next steps) are computed
   * by the caller from the standards module — this renderer stays a painter
   * and holds no policy.
   */
  understanding?: string | null;
  exclusions?: readonly string[] | null;
  assumptions?: readonly string[] | null;
  clientResponsibilities?: readonly string[] | null;
  paymentRows?: ReadonlyArray<{ label: string; pct: number; amountMinor: number }> | null;
  timelineLabel?: string | null;
  timelineTerms?: readonly string[] | null;
  supportLines?: readonly string[] | null;
  gstLine?: string | null;
  scopeProtection?: readonly string[] | null;
  nextSteps?: readonly string[] | null;
  /** G-167 — each drawn only when supplied, like everything above. */
  dependencies?: readonly string[] | null;
  acceptanceCriteria?: readonly string[] | null;
  optionalAddons?: ReadonlyArray<{ label: string; priceRupees: number }> | null;
  regulatedClauses?: readonly string[] | null;
  commercialTerms?: readonly string[] | null;
  /**
   * A note for whoever is DECIDING this quotation — G-168.
   *
   * Structurally internal, not internal by convention: it is drawn only when
   * `statusBandFor` already returns a band, so it can appear on a draft or a
   * pending-approval copy and on nothing else. An approved, sent or accepted
   * document cannot carry it, whatever a caller passes.
   */
  internalNote?: string | null;
  /**
   * The industry accent (G-167). Absent, unknown or 'general' renders the
   * neutral document byte-for-byte as before; nothing structural varies.
   */
  theme?: string | null;
}

export interface QuotationPdfResult {
  bytes: Uint8Array;
  /**
   * Every string the document draws, in draw order — the render's testable
   * transcript. The PDF's own content streams are compressed CID-encoded
   * glyph runs, so "the document does not say Discount when there is none"
   * cannot be asserted against the bytes; it is asserted against this, which
   * is written by the same single wrapper every draw goes through.
   */
  drawnText: string[];
  /**
   * Characters the font has no glyph for, replaced with '?' in the output.
   * Empty in every expected case (the font covers Latin, punctuation and ₹);
   * surfaced rather than swallowed so a caller can log that the document is
   * not showing exactly what the row says.
   */
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

/**
 * One master brand, twelve industry accents — G-167.
 *
 * The corpus study's §19: a quotation should feel prepared for this client's
 * business while still obviously being one agency's document. The way to get
 * that — and the way to NOT get twelve templates that drift apart — is to let
 * a theme change exactly one thing: the accent hue, at three fixed places
 * (the header keyline, the section labels, the rule above the total).
 *
 * Everything structural stays locked: the typeface, the ink and neutral
 * greys, every section and its order, every table, all commercial language,
 * the footer, the page numbers. A theme cannot add a section, remove one, or
 * change a word.
 *
 * `general` is null on purpose and is the default. An untheme'd quotation
 * renders byte-for-byte as it did before this change — the same promise
 * G-165 made to legacy documents, kept again rather than quietly broken.
 *
 * The status band is deliberately NOT themed: BAND_INK is a warning, and a
 * warning that changes colour by industry is a warning nobody learns to read.
 */
const THEME_ACCENTS = {
  general: null,
  marketplace: rgb(0.14, 0.16, 0.36),
  ecommerce: rgb(0.4, 0.26, 0.09),
  logistics: rgb(0.56, 0.27, 0.06),
  fintech: rgb(0.11, 0.3, 0.32),
  health: rgb(0.1, 0.33, 0.26),
  education: rgb(0.11, 0.22, 0.42),
  media: rgb(0.42, 0.1, 0.31),
  saas: rgb(0.18, 0.24, 0.33),
  realestate: rgb(0.35, 0.22, 0.1),
  ai: rgb(0.29, 0.16, 0.45),
  faith: rgb(0.56, 0.32, 0.03),
  gaming: rgb(0.36, 0.09, 0.1),
} as const;

export type QuotationTheme = keyof typeof THEME_ACCENTS;

export const QUOTATION_THEMES = Object.keys(THEME_ACCENTS) as readonly QuotationTheme[];

/** An unknown theme is the neutral one — a bad string may not change a document. */
function accentFor(theme: string | null | undefined) {
  if (!theme) return null;
  return THEME_ACCENTS[theme as QuotationTheme] ?? null;
}

/**
 * What each status is allowed to look like.
 *
 * The clean list is closed; the band is the default. An unknown status is a
 * status somebody added after this was written, and the safe reading of "I
 * do not know what this is" is "then it is not a finished quotation".
 */
const CLEAN_STATUSES = new Set(['approved', 'sent', 'accepted']);

export function statusBandFor(status: string): string | null {
  if (CLEAN_STATUSES.has(status)) return null;
  switch (status) {
    case 'draft':
      return 'DRAFT — NOT YET APPROVED';
    case 'pending_approval':
      return 'FOR INTERNAL REVIEW — NOT YET APPROVED';
    case 'superseded':
      return 'SUPERSEDED — A LATER VERSION REPLACES THIS DOCUMENT';
    case 'lapsed':
      return 'VALIDITY EXPIRED';
    case 'rejected':
      return 'DECLINED BY THE CLIENT';
    default:
      return `NOT APPROVED — STATUS: ${status.toUpperCase().replace(/_/g, ' ')}`;
  }
}

// ── formatting: identical to every other surface ───────────────────────────

function moneyFormatter(currency: string): (minor: number) => string {
  const fmt = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: 2,
  });
  return (minor: number) => fmt.format(minor / 100);
}

function dateOnly(iso: string, timeZone: string): string {
  // A bare date (valid_until is a Postgres `date`) is a calendar day, not an
  // instant: `new Date('2026-09-15')` is UTC midnight, and rendering that in
  // any negative-offset zone says the 14th — a quotation whose validity
  // shrinks by a day depending on where the agency is. Formatted as the day
  // it names, no zone involved.
  const bare = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (bare) {
    return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]))));
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(parsed);
}

/** "×1" is noise; "×12" is the reason for the number beside it. */
function quantityLabel(quantity: number): string {
  if (quantity === 1) return '';
  return `×${String(quantity).replace(/\.0+$/, '')}`;
}

/**
 * The document's own arithmetic, checked at the last gate before a client
 * reads it — G-167, from the corpus study of this agency's 45 quotations.
 *
 * Five of those 45 shipped a cost table that did not sum to its own total,
 * one of them by ₹5,40,000 on a ₹19,75,000 quotation. The cause there was
 * hand-built tables; that cause does not exist here, because
 * `sales.proposal_totals()` re-sums the subtotal from the items and
 * `proposals_total_is_arithmetic` asserts the identity — **the database
 * already owns this invariant** and this function does not replace it.
 *
 * What it owns is narrower and genuinely reachable: the renderer is handed
 * `items` by a SEPARATE query from the one that read the totals (service.ts
 * and handlers.ts both do this), and `items ?? []` on a null result would
 * paint a Total with no lines under it. A document whose drawn lines do not
 * add up to its drawn total is the exact defect the corpus shipped, whatever
 * produced it — so it is caught here, where every caller passes through.
 *
 * Fail-closed by throwing: all three call sites already wrap the render in a
 * try/catch that answers INTERNAL, so the owner gets no document rather than
 * a wrong one. The message names both figures, because "they disagree" is
 * not something anyone can act on and "8,50,000 vs 9,50,000" is.
 */
export function quotationArithmeticFault(input: {
  items: ReadonlyArray<{ amountMinor: number }>;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}): string | null {
  if (input.items.length > 0) {
    const lines = input.items.reduce((sum, item) => sum + item.amountMinor, 0);
    if (lines !== input.subtotalMinor) {
      return `the ${input.items.length} line(s) drawn sum to ${lines} but the subtotal drawn says ${input.subtotalMinor}`;
    }
  }
  const identity = input.subtotalMinor - input.discountMinor + input.taxMinor;
  if (identity !== input.totalMinor) {
    return `subtotal − discount + tax is ${identity} but the total drawn says ${input.totalMinor}`;
  }
  return null;
}

/** A filename WhatsApp and every filesystem will take without mangling. */
export function quotationPdfFilename(title: string, version: number): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `Quotation-v${version}${slug ? `-${slug}` : ''}.pdf`;
}

// ── the renderer ───────────────────────────────────────────────────────────

interface Cursor {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  pages: PDFPage[];
  regular: PDFFont;
  bold: PDFFont;
  /** Repainted at the top of every continuation page. */
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
      // A word wider than the whole column — a URL, an unbroken id — cannot
      // wrap and would otherwise be drawn straight through the next column
      // and off the page. Broken at the last character that fits, however
      // inelegant: a visible break beats invisible money.
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

export async function renderQuotationPdf(input: QuotationPdfInput): Promise<QuotationPdfResult> {
  // Before a single glyph: a quotation whose lines do not add up to its own
  // total is not a document to fix on page 2 (G-167).
  const fault = quotationArithmeticFault(input);
  if (fault) throw new Error(`Quotation arithmetic does not hold — ${fault}`);

  // The industry accent, or null for the neutral document (G-167). `LABEL` is
  // the one colour a theme moves in the body: the section labels. Table
  // furniture (QTY, AMOUNT) stays MUTED — it is not brand, it is a column.
  const accent = accentFor(input.theme);
  const LABEL = accent ?? MUTED;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = quotationFontBytes();
  // `subset: false`, and the reason is written on quotationFontBytes: the
  // vendored files are already subsets, and pdf-lib's own subsetting breaks
  // Apple's renderer — the one the owner's iPhone opens this PDF with.
  const regular = await doc.embedFont(fontBytes.regular, { subset: false });
  const bold = await doc.embedFont(fontBytes.bold, { subset: false });

  // Both weights of Noto Sans carry the same character set, so one check
  // serves both. Characters outside it become '?' — visibly wrong beats a
  // crashed send, and the substitution is reported, not swallowed.
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

  const drawn: string[] = [];
  const draw = (page: PDFPage, text: string, options: Parameters<PDFPage['drawText']>[1]) => {
    drawn.push(text);
    page.drawText(text, options);
  };

  // For fields drawn as ONE line — the letterhead, the client, the header
  // labels — a newline that survived clean() would make pdf-lib draw an
  // unaccounted extra line straight through the block below, while the
  // transcript records one entry. Collapsed to spaces before drawing.
  const cleanLine = (text: string): string => clean(text).replace(/\n+/g, ' ').trim();

  const money = moneyFormatter(input.currency);
  const title = cleanLine(input.title);
  const organizationName = cleanLine(input.organizationName);
  const versionLabel = `Version ${input.version}`;

  const firstPage = doc.addPage([A4.width, A4.height]);
  const pages = [firstPage];

  const continuationHeader = (page: PDFPage): number => {
    const size = 9;
    draw(page, organizationName, {
      x: MARGIN,
      y: A4.height - MARGIN + 8,
      size,
      font: bold,
      color: MUTED,
    });
    // Truncated to the half of the width the letterhead does not own — a
    // 200-character title would otherwise compute a negative x and be drawn
    // straight through the organization's name.
    let label = `${title} — ${versionLabel} (continued)`;
    const labelMax = CONTENT_WIDTH / 2;
    if (regular.widthOfTextAtSize(label, size) > labelMax) {
      while (label.length > 1 && regular.widthOfTextAtSize(`${label}…`, size) > labelMax) {
        label = label.slice(0, -1);
      }
      label = `${label}…`;
    }
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

  const c: Cursor = { doc, page: firstPage, y: 0, pages, regular, bold, continuationHeader };

  // ── header: who this document is from ──
  let y = A4.height - MARGIN;
  draw(c.page, organizationName, { x: MARGIN, y, size: 13, font: bold, color: INK });
  const kind = 'QUOTATION';
  draw(c.page, kind, {
    x: A4.width - MARGIN - regular.widthOfTextAtSize(kind, 10),
    y: y + 1,
    size: 10,
    font: regular,
    color: MUTED,
  });
  y -= 14;
  // The keyline under the masthead — the theme's first and loudest move, and
  // still only a rule (G-167).
  c.page.drawLine({
    start: { x: MARGIN, y },
    end: { x: A4.width - MARGIN, y },
    thickness: accent ? 1.5 : 1,
    color: accent ?? RULE,
  });
  y -= 28;

  // ── the status, before the content it qualifies ──
  const band = statusBandFor(input.status);
  if (band) {
    const bandText = clean(band);
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
    draw(c.page, bandText, {
      x: MARGIN + 10,
      y: y - bandHeight + 8 + (bandHeight - 9) / 2,
      size: 9,
      font: bold,
      color: BAND_INK,
    });
    y -= bandHeight + 12;
  }

  // ── title and the facts that identify this version ──
  for (const line of wrap(title, bold, 20, CONTENT_WIDTH)) {
    draw(c.page, line, { x: MARGIN, y: y - 20, size: 20, font: bold, color: INK });
    y -= 26;
  }
  y -= 4;

  const metaParts = [versionLabel, `Prepared ${dateOnly(input.preparedAt, input.timeZone)}`];
  if (input.validUntil) metaParts.push(`Valid until ${dateOnly(input.validUntil, input.timeZone)}`);
  draw(c.page, clean(metaParts.join('   ·   ')), {
    x: MARGIN,
    y: y - 10,
    size: 9.5,
    font: regular,
    color: MUTED,
  });
  y -= 24;

  if (input.preparedFor) {
    draw(c.page, 'PREPARED FOR', { x: MARGIN, y: y - 8, size: 7.5, font: bold, color: LABEL });
    y -= 12;
    draw(c.page, cleanLine(input.preparedFor), { x: MARGIN, y: y - 11, size: 11, font: regular, color: INK });
    y -= 24;
  }

  c.y = y;

  // ── the project, as understood (G-165) — before the boundaries ──
  if (input.understanding) {
    const size = 10.5;
    const leading = 15.5;
    ensureRoom(c, 14 + leading);
    draw(c.page, 'THE PROJECT, AS UNDERSTOOD', { x: MARGIN, y: c.y - 8, size: 7.5, font: bold, color: LABEL });
    c.y -= 16;
    for (const line of wrap(clean(input.understanding), regular, size, CONTENT_WIDTH)) {
      ensureRoom(c, leading);
      draw(c.page, line, { x: MARGIN, y: c.y - size, size, font: regular, color: INK });
      c.y -= leading;
    }
    c.y -= 10;
  }

  // ── the summary — including what is NOT covered ──
  if (input.body) {
    const size = 10.5;
    const leading = 15.5;
    for (const line of wrap(clean(input.body), regular, size, CONTENT_WIDTH)) {
      ensureRoom(c, leading);
      draw(c.page, line, { x: MARGIN, y: c.y - size, size, font: regular, color: INK });
      c.y -= leading;
    }
    c.y -= 10;
  }

  // ── the scope, line by priced line ──
  if (input.items.length > 0) {
    const amountColumn = 110;
    const qtyColumn = input.items.some((i) => i.quantity !== 1) ? 60 : 0;
    const descWidth = CONTENT_WIDTH - amountColumn - qtyColumn;
    const size = 10;
    const leading = 15;

    // Room for the header AND the first row: a header whose every item sits
    // on the next page is a table that appears to cover nothing.
    ensureRoom(c, 30 + leading + 10);
    draw(c.page, 'WHAT IT COVERS', { x: MARGIN, y: c.y - 8, size: 7.5, font: bold, color: LABEL });
    if (qtyColumn) {
      draw(c.page, 'QTY', {
        x: MARGIN + descWidth + (qtyColumn - bold.widthOfTextAtSize('QTY', 7.5)) - 8,
        y: c.y - 8,
        size: 7.5,
        font: bold,
        color: MUTED,
      });
    }
    draw(c.page, 'AMOUNT', {
      x: A4.width - MARGIN - bold.widthOfTextAtSize('AMOUNT', 7.5),
      y: c.y - 8,
      size: 7.5,
      font: bold,
      color: MUTED,
    });
    c.y -= 14;
    c.page.drawLine({
      start: { x: MARGIN, y: c.y },
      end: { x: A4.width - MARGIN, y: c.y },
      thickness: 0.75,
      color: RULE,
    });
    c.y -= 4;

    for (const item of input.items) {
      const descLines = wrap(clean(item.description), regular, size, descWidth - 12);
      const rowHeight = descLines.length * leading + 6;
      ensureRoom(c, rowHeight + 4);

      const rowTop = c.y;
      descLines.forEach((line, i) => {
        draw(c.page, line, {
          x: MARGIN,
          y: rowTop - size - i * leading - 4,
          size,
          font: regular,
          color: INK,
        });
      });
      const qty = quantityLabel(item.quantity);
      if (qtyColumn && qty) {
        draw(c.page, qty, {
          x: MARGIN + descWidth + (qtyColumn - regular.widthOfTextAtSize(qty, size)) - 8,
          y: rowTop - size - 4,
          size,
          font: regular,
          color: MUTED,
        });
      }
      const amount = clean(money(item.amountMinor));
      draw(c.page, amount, {
        x: A4.width - MARGIN - regular.widthOfTextAtSize(amount, size),
        y: rowTop - size - 4,
        size,
        font: regular,
        color: INK,
      });
      c.y -= rowHeight;

      // The line's contents, bullet-level (G-165) — below the description,
      // in the row's own flow so a long list paginates with everything else.
      if (item.features && item.features.length > 0) {
        const bSize = 9;
        const bLeading = 13;
        for (const feature of item.features) {
          const bLines = wrap(clean(feature), regular, bSize, descWidth - 30);
          bLines.forEach((line, i) => {
            ensureRoom(c, bLeading);
            draw(c.page, i === 0 ? `\u2022 ${line}` : line, {
              x: MARGIN + 12 + (i === 0 ? 0 : 8),
              y: c.y - bSize,
              size: bSize,
              font: regular,
              color: MUTED,
            });
            c.y -= bLeading;
          });
        }
        c.y -= 4;
      }

      c.page.drawLine({
        start: { x: MARGIN, y: c.y },
        end: { x: A4.width - MARGIN, y: c.y },
        thickness: 0.4,
        color: RULE,
      });
      c.y -= 2;
    }
    c.y -= 12;
  }

  // ── the money — only rows that carry a fact ──
  {
    const rows: Array<{ label: string; value: string; strong?: boolean }> = [];
    if (input.discountMinor > 0 || input.taxMinor > 0) {
      rows.push({ label: 'Subtotal', value: money(input.subtotalMinor) });
      if (input.discountMinor > 0) rows.push({ label: 'Discount', value: `−${money(input.discountMinor)}` });
      if (input.taxMinor > 0) rows.push({ label: 'Tax', value: money(input.taxMinor) });
    }
    rows.push({ label: 'Total', value: money(input.totalMinor), strong: true });

    const blockWidth = 240;
    const rowHeight = 17;
    ensureRoom(c, rows.length * rowHeight + 14);
    const left = A4.width - MARGIN - blockWidth;

    for (const row of rows) {
      const font = row.strong ? bold : regular;
      const size = row.strong ? 11.5 : 10;
      if (row.strong && rows.length > 1) {
        // The theme's third and last move: the rule the total sits under.
        c.page.drawLine({
          start: { x: left, y: c.y + 2 },
          end: { x: A4.width - MARGIN, y: c.y + 2 },
          thickness: accent ? 1 : 0.75,
          color: accent ?? RULE,
        });
        c.y -= 6;
      }
      draw(c.page, row.label, { x: left, y: c.y - size, size, font, color: row.strong ? INK : MUTED });
      const value = clean(row.value);
      draw(c.page, value, {
        x: A4.width - MARGIN - font.widthOfTextAtSize(value, size),
        y: c.y - size,
        size,
        font,
        color: INK,
      });
      c.y -= rowHeight;
    }
  }

  // ── the document sections beyond the money (G-165) ──
  //
  // Each renders only when its content was supplied; a legacy quotation
  // renders none of them and looks exactly as it always did. One painter for
  // the list-shaped ones, so every section paginates the same way.
  const sectionList = (label: string, lines: readonly string[], bullet: boolean) => {
    if (lines.length === 0) return;
    const size = 9.5;
    const leading = 14;
    ensureRoom(c, 26 + leading);
    c.y -= 8;
    draw(c.page, label, { x: MARGIN, y: c.y - 8, size: 7.5, font: bold, color: LABEL });
    c.y -= 18;
    for (const entry of lines) {
      const wrapped = wrap(clean(entry), regular, size, CONTENT_WIDTH - (bullet ? 14 : 0));
      wrapped.forEach((line, i) => {
        ensureRoom(c, leading);
        draw(c.page, bullet && i === 0 ? `\u2022 ${line}` : line, {
          x: MARGIN + (bullet ? (i === 0 ? 0 : 10) : 0),
          y: c.y - size,
          size,
          font: regular,
          color: INK,
        });
        c.y -= leading;
      });
    }
    c.y -= 2;
  };

  if (input.gstLine) {
    const size = 8.5;
    ensureRoom(c, 14);
    const text = clean(input.gstLine);
    draw(c.page, text, {
      x: A4.width - MARGIN - regular.widthOfTextAtSize(text, size),
      y: c.y - size,
      size,
      font: regular,
      color: MUTED,
    });
    c.y -= 16;
  }

  if (input.timelineLabel) {
    sectionList('TIMELINE', [input.timelineLabel, ...(input.timelineTerms ?? [])], false);
  }

  if (input.paymentRows && input.paymentRows.length > 0) {
    const size = 9.5;
    const leading = 15;
    // 26 for the heading, leading + 2 for the first row, and headroom — the
    // review reproduced a 2pt window where the heading painted as a page's
    // last line and every milestone flowed to the next (an orphaned heading
    // in a client-facing quotation). The reservation now covers what the
    // heading AND the first row actually consume.
    ensureRoom(c, 26 + leading + 4);
    c.y -= 8;
    draw(c.page, 'PAYMENT SCHEDULE', { x: MARGIN, y: c.y - 8, size: 7.5, font: bold, color: LABEL });
    c.y -= 18;
    for (const row of input.paymentRows) {
      const amount = clean(`${money(row.amountMinor)} (${row.pct}%)`);
      const amountWidth = regular.widthOfTextAtSize(amount, size) + 16;
      const labelLines = wrap(clean(row.label), regular, size, CONTENT_WIDTH - amountWidth);
      ensureRoom(c, labelLines.length * leading + 2);
      const rowTop = c.y;
      labelLines.forEach((line, i) => {
        draw(c.page, line, { x: MARGIN, y: rowTop - size - i * leading, size, font: regular, color: INK });
      });
      draw(c.page, amount, {
        x: A4.width - MARGIN - regular.widthOfTextAtSize(amount, size),
        y: rowTop - size,
        size,
        font: regular,
        color: INK,
      });
      c.y -= labelLines.length * leading + 2;
    }
    c.y -= 2;
  }

  sectionList('EXPLICITLY NOT INCLUDED', input.exclusions ?? [], true);
  // Priced, named, and outside the total — the amount is drawn INTO the line
  // rather than into a column, because an add-on that looks like a table row
  // is an add-on a client reads as included (G-167).
  sectionList(
    'OPTIONAL — NOT IN THE TOTAL ABOVE',
    (input.optionalAddons ?? []).map((a) => `${a.label} — ${money(a.priceRupees * 100)}`),
    true,
  );
  sectionList('CLIENT RESPONSIBILITIES', input.clientResponsibilities ?? [], true);
  sectionList('ASSUMPTIONS', input.assumptions ?? [], true);
  sectionList('DEPENDENCIES', input.dependencies ?? [], true);
  sectionList('ACCEPTED WHEN', input.acceptanceCriteria ?? [], true);
  sectionList('SCOPE & CHANGES', input.scopeProtection ?? [], false);
  // The approver's note, and the gate that keeps it theirs (G-168). `band` is
  // the same value the status banner was drawn from: non-null means this
  // document already declares itself unapproved, which is exactly the set of
  // copies a client never receives.
  if (input.internalNote && band) {
    sectionList('FOR THE APPROVER — NOT PART OF THE QUOTATION', [input.internalNote], false);
  }
  sectionList('SUPPORT', input.supportLines ?? [], true);
  sectionList('COMMERCIAL TERMS', input.commercialTerms ?? [], true);
  sectionList('REGULATORY', input.regulatedClauses ?? [], true);
  sectionList('NEXT STEPS', input.nextSteps ?? [], true);

  // ── footer, on every page, once the page count is known ──
  const total = pages.length;
  pages.forEach((page, i) => {
    page.drawLine({
      start: { x: MARGIN, y: MARGIN - 8 },
      end: { x: A4.width - MARGIN, y: MARGIN - 8 },
      thickness: 0.5,
      color: RULE,
    });
    const trace = clean(`Quotation ${input.reference} — ${versionLabel.toLowerCase()}`);
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

  // ── metadata: the record's own facts, so the bytes are deterministic ──
  const stamped = new Date(input.preparedAt);
  const metadataDate = Number.isNaN(stamped.getTime()) ? new Date(0) : stamped;
  doc.setTitle(`Quotation v${input.version} — ${title}`);
  doc.setSubject(organizationName);
  doc.setCreator('AgencyOS');
  doc.setProducer('AgencyOS');
  doc.setCreationDate(metadataDate);
  doc.setModificationDate(metadataDate);

  return { bytes: await doc.save(), drawnText: drawn, replacedCharacters: [...replaced] };
}
