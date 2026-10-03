import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

import { quotationFontBytes } from './fonts';

/**
 * The project report as a document — SCR-026 "Export PDF".
 *
 * The same discipline as `invoice.ts`: the renderer draws what the report
 * page computed and stops. Nothing is estimated here; every figure arrives
 * from the page's own readers, already formatted where money is involved
 * (so a role that cannot read money passes no money section, and none is
 * drawn). Deterministic for the same input and `generatedAt`.
 *
 * Lives in `src/lib` and knows nothing about the projects module: the
 * route maps its rows into `ProjectReportInput`.
 */
export interface ProjectReportInput {
  organizationName: string;
  projectName: string;
  projectCode: string | null;
  clientName: string | null;
  status: string;
  /** "12 Mar 2026 – 3 Jun 2026", or null. */
  windowLabel: string | null;
  generatedAt: string;
  timeZone: string;
  /** Label/value pairs — the page's KPI row, already formatted. */
  figures: ReadonlyArray<{ label: string; value: string; caption?: string | null }>;
  health: { label: string; reasons: ReadonlyArray<string> };
  milestones: ReadonlyArray<{ name: string; dueLabel: string | null; state: string }>;
  tasksByStatus: ReadonlyArray<{ label: string; count: number }>;
  workByPerson: ReadonlyArray<{ name: string; done: number; total: number }>;
  risks: ReadonlyArray<{ title: string; severity: string; status: string }>;
  /** Present only when the caller may read money. Already formatted. */
  money: ReadonlyArray<{ label: string; value: string }> | null;
  marginNote: string | null;
  /** The report page's own URL — the footer's traceability line. */
  reference: string;
}

export interface ProjectReportResult {
  bytes: Uint8Array;
  filename: string;
  pageCount: number;
}

const A4 = { width: 595.28, height: 841.89 } as const;
const MARGIN = 56;
const CONTENT_WIDTH = A4.width - MARGIN * 2;
const FOOTER_ROOM = 40;

const INK = rgb(0.12, 0.13, 0.16);
const MUTED = rgb(0.45, 0.47, 0.52);
const RULE = rgb(0.85, 0.86, 0.88);

export function projectReportFilename(projectCode: string | null, projectName: string, generatedAt: string): string {
  const stem = (projectCode ?? projectName).replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  return `${stem}-report-${generatedAt.slice(0, 10)}.pdf`;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

type Cursor = { doc: PDFDocument; page: PDFPage; y: number; pages: PDFPage[]; header: (page: PDFPage) => number };

function ensureRoom(c: Cursor, height: number): void {
  if (c.y - height >= MARGIN + FOOTER_ROOM) return;
  c.page = c.doc.addPage([A4.width, A4.height]);
  c.pages.push(c.page);
  c.y = c.header(c.page);
}

export async function renderProjectReportPdf(input: ProjectReportInput): Promise<ProjectReportResult> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = quotationFontBytes();
  const regular = await doc.embedFont(fontBytes.regular, { subset: false });
  const bold = await doc.embedFont(fontBytes.bold, { subset: false });

  const charset = new Set(regular.getCharacterSet());
  const clean = (text: string): string =>
    Array.from(text.replace(/\r\n?/g, '\n'), (ch) => {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x09) return ' ';
      if (cp !== 0x0a && cp < 0x20) return '';
      return charset.has(cp) ? ch : '?';
    }).join('');
  const line = (text: string) => clean(text).replace(/\n+/g, ' ').trim();

  const organizationName = line(input.organizationName);
  const title = `${line(input.projectName)} — project report`;

  const header = (page: PDFPage): number => {
    const size = 9;
    page.drawText(organizationName, { x: MARGIN, y: A4.height - MARGIN + 8, size, font: bold, color: MUTED });
    const label = `${title} (continued)`;
    page.drawText(label, { x: A4.width - MARGIN - regular.widthOfTextAtSize(label, size), y: A4.height - MARGIN + 8, size, font: regular, color: MUTED });
    page.drawLine({ start: { x: MARGIN, y: A4.height - MARGIN }, end: { x: A4.width - MARGIN, y: A4.height - MARGIN }, thickness: 0.5, color: RULE });
    return A4.height - MARGIN - 24;
  };

  const first = doc.addPage([A4.width, A4.height]);
  const c: Cursor = { doc, page: first, y: A4.height - MARGIN, pages: [first], header };

  const text = (value: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; width?: number; gap?: number } = {}) => {
    const size = opts.size ?? 10;
    const font = opts.font ?? regular;
    const width = opts.width ?? CONTENT_WIDTH - ((opts.x ?? MARGIN) - MARGIN);
    const lines = wrap(clean(value), font, size, width);
    for (const l of lines) {
      ensureRoom(c, size + 4);
      c.page.drawText(l, { x: opts.x ?? MARGIN, y: c.y - size, size, font, color: opts.color ?? INK });
      c.y -= size + 4;
    }
    c.y -= opts.gap ?? 0;
  };
  const rule = () => {
    ensureRoom(c, 12);
    c.page.drawLine({ start: { x: MARGIN, y: c.y - 4 }, end: { x: A4.width - MARGIN, y: c.y - 4 }, thickness: 0.5, color: RULE });
    c.y -= 12;
  };
  const section = (heading: string) => {
    ensureRoom(c, 40);
    c.y -= 8;
    text(heading, { size: 12, font: bold, gap: 2 });
    rule();
  };
  const row = (left: string, right: string, opts: { bold?: boolean } = {}) => {
    const size = 10;
    ensureRoom(c, size + 6);
    const font = opts.bold ? bold : regular;
    const leftLines = wrap(clean(left), font, size, CONTENT_WIDTH * 0.68);
    const rightText = line(right);
    c.page.drawText(leftLines[0] ?? '', { x: MARGIN, y: c.y - size, size, font, color: INK });
    c.page.drawText(rightText, { x: A4.width - MARGIN - regular.widthOfTextAtSize(rightText, size), y: c.y - size, size, font: regular, color: INK });
    c.y -= size + 6;
    for (const extra of leftLines.slice(1)) {
      ensureRoom(c, size + 4);
      c.page.drawText(extra, { x: MARGIN, y: c.y - size, size, font, color: INK });
      c.y -= size + 4;
    }
  };

  // ── header ──
  text(organizationName, { size: 13, font: bold, gap: 2 });
  text(title, { size: 18, font: bold, gap: 2 });
  const sub = [input.projectCode ? `Code ${input.projectCode}` : null, input.clientName ? `Client ${input.clientName}` : 'Internal project', `Status ${input.status.replace(/_/g, ' ')}`]
    .filter((s): s is string => Boolean(s))
    .join(' · ');
  text(sub, { size: 10, color: MUTED });
  text(`${input.windowLabel ? `Window ${input.windowLabel} · ` : ''}Generated ${input.generatedAt.slice(0, 16).replace('T', ' ')} (${input.timeZone})`, { size: 9, color: MUTED, gap: 6 });
  rule();

  // ── figures ──
  section('At a glance');
  for (const f of input.figures) row(f.caption ? `${f.label} — ${f.caption}` : f.label, f.value, { bold: true });

  // ── health ──
  section(`Project health: ${input.health.label}`);
  if (input.health.reasons.length === 0) text('No open blocker, no overdue task, no overdue milestone, no release-blocking defect.', { color: MUTED });
  for (const r of input.health.reasons) text(`• ${r}`);

  // ── milestones ──
  section('Milestones');
  if (input.milestones.length === 0) text('No milestones planned.', { color: MUTED });
  for (const m of input.milestones) row(`${m.name}${m.dueLabel ? ` — due ${m.dueLabel}` : ''}`, m.state);

  // ── tasks ──
  section('Tasks by status');
  if (input.tasksByStatus.length === 0) text('No tasks.', { color: MUTED });
  for (const t of input.tasksByStatus) row(t.label, String(t.count));

  section('Work by person');
  if (input.workByPerson.length === 0) text('No task assigned yet.', { color: MUTED });
  for (const w of input.workByPerson) row(w.name, `${w.done}/${w.total} done`);

  // ── risks ──
  section('Risks and quality');
  if (input.risks.length === 0) text('No open defects.', { color: MUTED });
  for (const r of input.risks) row(`${r.severity.toUpperCase()} — ${r.title}`, r.status.replace(/_/g, ' '));

  // ── money ──
  if (input.money) {
    section('Money');
    for (const m of input.money) row(m.label, m.value);
    if (input.marginNote) text(input.marginNote, { size: 9, color: MUTED });
  }

  // ── footer on every page ──
  const total = c.pages.length;
  c.pages.forEach((page, i) => {
    const foot = `${title} · ${input.reference} · page ${i + 1} of ${total}`;
    page.drawText(foot, { x: MARGIN, y: MARGIN - 16, size: 8, font: regular, color: MUTED });
  });

  doc.setTitle(title);
  doc.setAuthor(organizationName);
  doc.setCreationDate(new Date(input.generatedAt));
  doc.setModificationDate(new Date(input.generatedAt));

  const bytes = await doc.save();
  return { bytes, filename: projectReportFilename(input.projectCode, input.projectName, input.generatedAt), pageCount: total };
}
