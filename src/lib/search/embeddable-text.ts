import { createHash } from 'node:crypto';

import { SECRET_PATTERNS } from '@/lib/security/secret-patterns';

/**
 * What a record may say to an embedding vendor — search by meaning, decision 14.
 *
 * Search by meaning sends a record's words to a vendor to be turned into a
 * vector, so the one thing this module guarantees is what is NOT sent: any
 * field that carries a recognisable credential (the shapes
 * `src/lib/security/secret-patterns.ts` holds, a "password: value" line, a
 * secret in a link) is left out of the text, field by field, and a record that
 * is nothing but credentials is not embedded at all. Vault values and secret
 * columns are never among the fields a source names in the first place
 * (`semantic-sources.ts` lists the columns it reads); this guard is the second
 * line for a person who pasted a key into a title or a note.
 *
 * Pure and server-safe: no I/O, so it is the unit under test.
 */

const PASSWORD_LINE = /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i;
const SECRET_QUERY = /[?&#](?:password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|apikey|client_secret|auth)=[^&\s]{6,}/i;
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i;

/** Per-field and per-record bounds, in characters: a record is a few sentences, not a document. */
export const FIELD_CHARS = 1500;
export const TEXT_CHARS = 4000;

/** True when the words recognisably contain a credential. */
export function looksLikeCredential(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) return true;
  return PASSWORD_LINE.test(text) || SECRET_QUERY.test(text) || URL_PASSWORD.test(text);
}

export type EmbeddableText = {
  /** The words to embed, or null when nothing safe is left. */
  text: string | null;
  /** The field names that were withheld because they looked like a credential. */
  withheld: string[];
};

/** `fields` are label → value; the label is part of the text so "status: won" reads as such. */
export function embeddableText(group: string, fields: Record<string, string | null | undefined>): EmbeddableText {
  const withheld: string[] = [];
  const lines: string[] = [];
  for (const [label, raw] of Object.entries(fields)) {
    const value = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    if (looksLikeCredential(value)) {
      withheld.push(label);
      continue;
    }
    lines.push(`${label}: ${value.slice(0, FIELD_CHARS)}`);
  }
  if (lines.length === 0) return { text: null, withheld };
  return { text: `${group}\n${lines.join('\n')}`.slice(0, TEXT_CHARS), withheld };
}

/** The hash a record is skipped on when it has not changed — covers the model and size, so a new model re-embeds everything. */
export function contentHash(model: string, dimensions: number, text: string): string {
  return createHash('sha256').update(`${model}|${dimensions}\n${text}`).digest('hex');
}
