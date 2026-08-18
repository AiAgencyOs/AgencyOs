/**
 * A parser for a WhatsApp chat export (`_chat.txt` / "WhatsApp Chat with X.txt").
 *
 * Pure and dependency-free (only `./phone`), so the node test runner imports it
 * directly and no secret/DB surface is involved. It is built to a MEASURED real
 * export, documented in `docs/import/whatsapp-export-format.md` — not an assumed
 * format. Where the format is genuinely ambiguous (the DD/MM vs MM/DD order,
 * which the file does not state), it DETECTS from the data and refuses to assign
 * a timestamp rather than guessing.
 *
 * It reads. It classifies. It extracts phones as provenance. It does NOT decide
 * who is a lead, does NOT set consent (there is no consent field anywhere in its
 * output), and does NOT invent identity — a message is data, not permission.
 */

import { extractPhones, normalizePhone } from './phone';

export type MessageKind = 'text' | 'media' | 'system';
export type DateOrder = 'DMY' | 'MDY' | 'ambiguous';
export type ExportFormat = 'ios' | 'android' | 'unknown';

export type ParsedMessage = {
  index: number;
  /** The timestamp exactly as written (marks stripped), for audit. */
  timestampRaw: string;
  /** Naive wall-clock ISO (no timezone — the export states none) iff resolvable. */
  at: string | null;
  /** Author display string as written (a name, or a phone for an unsaved contact). */
  author: string | null;
  /** E.164 iff the author field itself is a phone number; else null. */
  authorPhone: string | null;
  kind: MessageKind;
  /** Joined multi-line body with marks stripped. */
  body: string;
  /** E.164 phones seen in this message (provenance only — NEVER consent). */
  mentionsPhones: string[];
};

export type ParticipantObservation = {
  /** The author string as it appears. */
  displayName: string;
  /** The display "name" is itself a phone number (unsaved contact). */
  isPhone: boolean;
  /** E.164 iff derivable (author-is-phone, or an unambiguous "added <name> <phone>"). */
  phone: string | null;
  messageCount: number;
  firstAtRaw: string;
  lastAtRaw: string;
};

export type ParsedChat = {
  messages: ParsedMessage[];
  participants: ParticipantObservation[];
  meta: {
    format: ExportFormat;
    isGroup: boolean;
    groupSubject: string | null;
    dateOrder: DateOrder;
    firstAtRaw: string | null;
    lastAtRaw: string | null;
    lineCount: number;
    messageCount: number;
  };
  /** Non-fatal problems an operator must see (ambiguous dates, unverified format…). */
  warnings: string[];
};

// WhatsApp's invisible marks, normalized away before any matching. Written as
// escapes so no invisible byte lives in this source: LRM/RLM (U+200E/U+200F),
// bidi embeddings and overrides (U+202A..U+202E), and the narrow no-break space
// (U+202F) and nbsp (U+00A0) used inside timestamps.
const BIDI_MARKS = /[\u200e\u200f\u202a-\u202e]/g;
const NBSP = /[\u00a0\u202f]/g;

function stripMarks(s: string): string {
  return s.replace(BIDI_MARKS, '').replace(NBSP, ' ').replace(/\r/g, '');
}

// iOS: [D/M/YY, H:MM:SS AM/PM] Author: body   (author + ': ' present)
const IOS_START = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\]\s?(.*)$/;
// Android: D/M/YY, H:MM AM/PM - Author: body   (or a system line with no 'Author:')
const ANDROID_START = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\s-\s(.*)$/;

const MEDIA_RE = /(image|video|audio|voice|document|sticker|GIF|Contact card) omitted|<attached:/i;
const SYSTEM_RE =
  /^(You created this group|You added |.+ added .+|.+ left$|.+ was removed|.+ removed .+|.+ changed the (subject|group|description).*|.+ changed their phone number.*|Messages and calls are end-to-end encrypted.*|Your security code with .+ changed.*|.+ joined using .+|This message was deleted|You deleted this message|Missed (voice|video) call|You're now an admin.*)/;

type RawStart = {
  d: number;
  m: number;
  y: number;
  hh: number;
  mm: number;
  ss: number | null;
  ampm: string | null;
  rest: string; // "Author: body" (iOS/Android with author) OR "system text" (Android system)
  tsRaw: string;
};

function matchStart(line: string): RawStart | null {
  const ios = IOS_START.exec(line);
  const m = ios ?? ANDROID_START.exec(line);
  if (!m) return null;
  const tsEnd = line.indexOf(ios ? ']' : ' - ');
  return {
    d: Number(m[1]),
    m: Number(m[2]),
    y: Number(m[3]),
    hh: Number(m[4]),
    mm: Number(m[5]),
    ss: m[6] ? Number(m[6]) : null,
    ampm: m[7] ?? null,
    rest: m[8] ?? '',
    tsRaw: ios ? line.slice(1, tsEnd) : line.slice(0, tsEnd),
  };
}

/** Detect DD/MM vs MM/DD from the whole set; ambiguous when nothing disambiguates. */
function detectOrder(starts: RawStart[]): DateOrder {
  let firstOver12 = false;
  let secondOver12 = false;
  for (const s of starts) {
    if (s.d > 12) firstOver12 = true;
    if (s.m > 12) secondOver12 = true;
  }
  if (firstOver12 && !secondOver12) return 'DMY';
  if (secondOver12 && !firstOver12) return 'MDY';
  return 'ambiguous'; // both ≤12 everywhere, or contradictory — do not guess
}

function toIso(s: RawStart, order: DateOrder): string | null {
  if (order === 'ambiguous') return null;
  const day = order === 'DMY' ? s.d : s.m;
  const mon = order === 'DMY' ? s.m : s.d;
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  let hh = s.hh;
  if (s.ampm) {
    const pm = s.ampm.toUpperCase() === 'PM';
    if (hh === 12) hh = pm ? 12 : 0;
    else if (pm) hh += 12;
  }
  const year = s.y < 100 ? 2000 + s.y : s.y;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  // Naive wall-clock — the export carries no timezone, so none is asserted.
  return `${p(year, 4)}-${p(mon)}-${p(day)}T${p(hh)}:${p(s.mm)}:${p(s.ss ?? 0)}`;
}

function splitAuthor(rest: string): { author: string | null; body: string; isSystem: boolean } {
  // A leading system phrase is a system line even if it contains ': '.
  if (SYSTEM_RE.test(rest)) return { author: null, body: rest, isSystem: true };
  // "Author: body" — the author cannot contain ': ' before the one WhatsApp inserts.
  const idx = rest.indexOf(': ');
  if (idx > 0) {
    return { author: rest.slice(0, idx).trim(), body: rest.slice(idx + 2), isSystem: false };
  }
  // No "Author:" — an Android system line, or an iOS line whose author has no colon.
  return { author: null, body: rest, isSystem: true };
}

export function parseWhatsAppChat(text: string): ParsedChat {
  const normalized = stripMarks(text ?? '');
  const lines = normalized.split('\n');
  const warnings: string[] = [];

  // First pass: find message-start lines and stitch continuations.
  type Accum = { start: RawStart; bodyLines: string[] };
  const accums: Accum[] = [];
  let sawIos = false;
  let sawAndroid = false;
  for (const line of lines) {
    const start = matchStart(line);
    if (start) {
      if (IOS_START.test(line)) sawIos = true;
      else sawAndroid = true;
      accums.push({ start, bodyLines: [start.rest] });
    } else if (line.length > 0) {
      const last = accums[accums.length - 1];
      if (last) last.bodyLines.push(line);
      // A stray continuation before any start line is export preamble — dropped.
    }
  }

  const format: ExportFormat = sawIos ? 'ios' : sawAndroid ? 'android' : 'unknown';
  if (format === 'android') warnings.push('Android export shape detected; only iOS was verified against a real sample.');
  if (format === 'unknown' && accums.length === 0)
    warnings.push('No WhatsApp message lines were recognized — is this a chat export?');

  const dateOrder = detectOrder(accums.map((a) => a.start));
  if (dateOrder === 'ambiguous' && accums.length > 0) {
    warnings.push('Date order is ambiguous (no day > 12 anywhere); timestamps are left unresolved rather than guessed.');
  }

  const messages: ParsedMessage[] = [];
  let groupSubject: string | null = null;
  let isGroup = false;

  accums.forEach((a, i) => {
    const joined = a.bodyLines.join('\n');
    const { author, body, isSystem } = splitAuthor(joined);

    let kind: MessageKind = 'text';
    if (MEDIA_RE.test(body)) kind = 'media';
    else if (isSystem || SYSTEM_RE.test(body)) kind = 'system';

    if (kind === 'system') {
      if (/created this group|added |changed the (subject|group|description)/i.test(body)) isGroup = true;
      if (author && !groupSubject && /\|\||group/i.test(author)) groupSubject = author;
    }

    const authorNorm = author ? normalizePhone(author) : null;
    const authorPhone = authorNorm && authorNorm.e164 ? authorNorm.e164 : null;

    messages.push({
      index: i,
      timestampRaw: a.start.tsRaw,
      at: toIso(a.start, dateOrder),
      author,
      authorPhone,
      kind,
      body,
      mentionsPhones: extractPhones(joined),
    });
  });

  // Participants: authored (non-system) messages only — a system line's "author"
  // is the group, not a person.
  const byAuthor = new Map<string, ParticipantObservation>();
  for (const msg of messages) {
    if (msg.kind === 'system' || !msg.author) continue;
    const existing = byAuthor.get(msg.author);
    if (existing) {
      existing.messageCount += 1;
      existing.lastAtRaw = msg.timestampRaw;
    } else {
      byAuthor.set(msg.author, {
        displayName: msg.author,
        isPhone: msg.authorPhone !== null,
        phone: msg.authorPhone,
        messageCount: 1,
        firstAtRaw: msg.timestampRaw,
        lastAtRaw: msg.timestampRaw,
      });
    }
  }

  return {
    messages,
    participants: [...byAuthor.values()].sort((a, b) => b.messageCount - a.messageCount),
    meta: {
      format,
      isGroup,
      groupSubject,
      dateOrder,
      firstAtRaw: accums[0]?.start.tsRaw ?? null,
      lastAtRaw: accums[accums.length - 1]?.start.tsRaw ?? null,
      lineCount: lines.length,
      messageCount: messages.length,
    },
    warnings,
  };
}
