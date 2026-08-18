/**
 * The dry-run analyzer — pure, read-only, no database. It turns a parsed export
 * (or several) into the counts an operator needs to see BEFORE anything mutates:
 * how many messages, how many participants, how many of those carry a phone we
 * could actually match on, how many are name-only (manual review), duplicates
 * across files, and — stated every time — that historical messages carry NO
 * consent.
 *
 * What it deliberately does NOT do: decide who is a lead, match against the
 * AgencyOS database (that is the Admin preview, which is RLS-scoped and runs
 * server-side), or assign consent. It reports the file side of the ledger; the
 * database side is added later, against real records, under tenant isolation.
 */

import type { DateOrder, ExportFormat, ParsedChat } from './whatsapp-chat';

export type ParticipantLine = {
  displayName: string;
  /** E.164 iff resolvable — the only reliable match key. Null ⇒ name-only. */
  phone: string | null;
  messageCount: number;
  /** True iff phone !== null: importable by the phone key without ambiguity. */
  phoneMatchable: boolean;
};

export type DryRunReport = {
  source: string;
  format: ExportFormat;
  isGroup: boolean;
  groupSubject: string | null;
  messages: { total: number; text: number; media: number; system: number };
  dates: { order: DateOrder; ambiguous: boolean; firstRaw: string | null; lastRaw: string | null };
  participants: {
    total: number;
    phoneMatchable: number;
    nameOnly: number;
    list: ParticipantLine[];
  };
  /** Distinct E.164 phones seen anywhere (author or body) — provenance only. */
  distinctPhonesMentioned: number;
  /** ALWAYS 'none'. A message is data, not permission. Nothing here is consent. */
  consentProvenance: 'none';
  warnings: string[];
};

export function analyzeExport(parsed: ParsedChat, source: string): DryRunReport {
  const byKind = { text: 0, media: 0, system: 0 };
  const mentioned = new Set<string>();
  for (const m of parsed.messages) {
    byKind[m.kind] += 1;
    for (const p of m.mentionsPhones) mentioned.add(p);
  }

  const list: ParticipantLine[] = parsed.participants.map((p) => ({
    displayName: p.displayName,
    phone: p.phone,
    messageCount: p.messageCount,
    phoneMatchable: p.phone !== null,
  }));

  return {
    source,
    format: parsed.meta.format,
    isGroup: parsed.meta.isGroup,
    groupSubject: parsed.meta.groupSubject,
    messages: { total: parsed.meta.messageCount, ...byKind },
    dates: {
      order: parsed.meta.dateOrder,
      ambiguous: parsed.meta.dateOrder === 'ambiguous',
      firstRaw: parsed.meta.firstAtRaw,
      lastRaw: parsed.meta.lastAtRaw,
    },
    participants: {
      total: list.length,
      phoneMatchable: list.filter((p) => p.phoneMatchable).length,
      nameOnly: list.filter((p) => !p.phoneMatchable).length,
      list,
    },
    distinctPhonesMentioned: mentioned.size,
    consentProvenance: 'none',
    warnings: parsed.warnings,
  };
}

export type AggregateReport = {
  files: number;
  totalMessages: number;
  totalParticipants: number;
  /** Distinct phone-matchable people across ALL files, deduped by E.164. */
  distinctPhoneMatchable: number;
  /** People with no phone across all files — cannot be phone-matched. */
  nameOnly: number;
  /** Duplicates: how many participant rows collapsed into the distinct phone set. */
  duplicatePhoneRows: number;
  groups: number;
  formats: Partial<Record<ExportFormat, number>>;
  ambiguousDateFiles: number;
  /** ALWAYS 'none'. */
  consentProvenance: 'none';
  warnings: string[];
};

/**
 * Fold many per-file reports into one. Duplicates across files are collapsed by
 * E.164 (the reliable key). Name-only participants are counted but NEVER deduped
 * by name here — two different people can share a display name, and collapsing
 * them would fabricate identity. That ambiguity is surfaced, not resolved.
 */
export function aggregate(reports: DryRunReport[]): AggregateReport {
  const phones = new Set<string>();
  let phoneRows = 0;
  let nameOnly = 0;
  let groups = 0;
  let ambiguous = 0;
  let totalMessages = 0;
  let totalParticipants = 0;
  const formats: Partial<Record<ExportFormat, number>> = {};
  const warnings = new Set<string>();

  for (const r of reports) {
    totalMessages += r.messages.total;
    totalParticipants += r.participants.total;
    if (r.isGroup) groups += 1;
    if (r.dates.ambiguous) ambiguous += 1;
    formats[r.format] = (formats[r.format] ?? 0) + 1;
    for (const w of r.warnings) warnings.add(w);
    for (const p of r.participants.list) {
      if (p.phone) {
        phoneRows += 1;
        phones.add(p.phone);
      } else {
        nameOnly += 1;
      }
    }
  }

  return {
    files: reports.length,
    totalMessages,
    totalParticipants,
    distinctPhoneMatchable: phones.size,
    nameOnly,
    duplicatePhoneRows: phoneRows - phones.size,
    groups,
    formats,
    ambiguousDateFiles: ambiguous,
    consentProvenance: 'none',
    warnings: [...warnings],
  };
}
