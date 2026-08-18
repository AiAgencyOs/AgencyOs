import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseWhatsAppChat } from '../src/lib/import/whatsapp-chat.ts';
import { extractPhones, normalizePhone } from '../src/lib/import/phone.ts';

/**
 * The parser is built to a MEASURED real export (docs/import/whatsapp-export-format.md).
 * These fixtures reproduce that exact byte format — U+202F before AM/PM, U+200E on
 * system/media lines, CRLF, multi-line bodies — with invented (non-personal) content,
 * which is the right way to pin the format without committing a real conversation.
 *
 * The load-bearing proofs are the negatives: an ambiguous date is never guessed, a
 * bare national number is never given a country, and NOTHING in the output is consent.
 */

const NNBSP = ' '; // narrow no-break space (before AM/PM)
const LRM = '‎'; // left-to-right mark (prefixes system/media lines)
const LRE = '‪';
const PDF = '‬'; // bidi wrappers around phone numbers

// An iOS group export: create + add system lines, a name author, a multi-line
// message, a media placeholder, and one unsaved-contact PHONE author.
const IOS = [
  `[01/08/26, 12:19:10${NNBSP}PM] Acme Project || Deal || Owner ||: ${LRM}You created this group`,
  `[01/08/26, 12:19:10${NNBSP}PM] Acme Project || Deal || Owner ||: ${LRM}Messages and calls are end-to-end encrypted.`,
  `[01/08/26, 1:15:56${NNBSP}PM] Acme Project || Deal || Owner ||: ${LRM}You added Jane Vendor and ${LRE}+91 90000 11111${PDF}`,
  `[01/08/26, 2:33:04${NNBSP}PM] Jane Vendor: Hello, following up on the quote`,
  `[01/08/26, 2:33:40${NNBSP}PM] Jane Vendor: line one`,
  `line two continues here`,
  `line three`,
  `[02/08/26, 9:05:00${NNBSP}AM] Jane Vendor: ${LRM}image omitted`,
  `[13/08/26, 10:00:00${NNBSP}AM] ${LRE}+91 90000 11111${PDF}: I am on the number, not saved`,
].join('\r\n');

describe('parseWhatsAppChat — iOS format (measured)', () => {
  const p = parseWhatsAppChat(IOS);

  test('detects iOS format and a group', () => {
    assert.equal(p.meta.format, 'ios');
    assert.equal(p.meta.isGroup, true);
    assert.match(p.meta.groupSubject ?? '', /Acme Project/);
  });

  test('normalizes the U+202F timestamp and resolves it (day 13 forces DMY)', () => {
    assert.equal(p.meta.dateOrder, 'DMY');
    const first = p.messages.find((m) => m.kind === 'text');
    assert.equal(first?.at, '2026-08-01T14:33:04'); // 2:33:04 PM -> 14:33:04
  });

  test('joins a multi-line message body', () => {
    const multi = p.messages.find((m) => m.body.startsWith('line one'));
    assert.ok(multi, 'multi-line message found');
    assert.match(multi!.body, /line one\nline two continues here\nline three/);
  });

  test('classifies system, media, and text', () => {
    const kinds = p.messages.reduce<Record<string, number>>((a, m) => ((a[m.kind] = (a[m.kind] ?? 0) + 1), a), {});
    assert.ok((kinds.system ?? 0) >= 3, `system>=3, got ${kinds.system}`);
    assert.equal(kinds.media, 1);
    assert.ok((kinds.text ?? 0) >= 2);
  });

  test('a name author has no fabricated phone; a phone author is E.164', () => {
    const jane = p.participants.find((x) => x.displayName === 'Jane Vendor');
    assert.equal(jane?.phone, null, 'a display name is never given a phone');
    const phoneAuthor = p.participants.find((x) => x.isPhone);
    assert.equal(phoneAuthor?.phone, '+919000011111');
  });

  test('extracts mentioned phones as provenance (from the "added" system line)', () => {
    const added = p.messages.find((m) => m.body.includes('You added'));
    assert.deepEqual(added?.mentionsPhones, ['+919000011111']);
  });
});

describe('date order is detected, never guessed', () => {
  test('all-<=12 dates are AMBIGUOUS: timestamps stay null and a warning is raised', () => {
    const ambiguous = [
      `[05/06/26, 9:00:00${NNBSP}AM] A: msg one`,
      `[07/06/26, 9:00:00${NNBSP}AM] A: msg two`,
    ].join('\r\n');
    const p = parseWhatsAppChat(ambiguous);
    assert.equal(p.meta.dateOrder, 'ambiguous');
    assert.ok(p.messages.every((m) => m.at === null), 'no timestamp is guessed under ambiguity');
    assert.ok(p.warnings.some((w) => /ambiguous/i.test(w)));
  });
});

describe('Android shape is recognized but flagged as unverified', () => {
  test('dash format parses with a warning', () => {
    const android = `8/1/26, 2:33${NNBSP}PM - Jane Vendor: hi\ncontinues`;
    const p = parseWhatsAppChat(android);
    assert.equal(p.meta.format, 'android');
    assert.ok(p.warnings.some((w) => /Android/i.test(w)));
  });
});

describe('the parser output is never consent', () => {
  test('no key or value anywhere in the serialized output is "consent"', () => {
    const p = parseWhatsAppChat(IOS);
    assert.doesNotMatch(JSON.stringify(p).toLowerCase(), /consent/);
  });
});

describe('normalizePhone is deterministic and never guesses a country', () => {
  test('an E.164 number normalizes by stripping formatting', () => {
    assert.equal(normalizePhone('+91 90000 11111').e164, '+919000011111');
    assert.equal(normalizePhone(`${LRE}+1 (415) 555-2671${PDF}`).e164, '+14155552671');
  });

  test('a bare national number gets NO country and a stated reason', () => {
    const r = normalizePhone('9389998942');
    assert.equal(r.e164, null);
    assert.equal(r.reason, 'no-country-code');
  });

  test('an implausible-length +number is rejected, not truncated', () => {
    assert.equal(normalizePhone('+12').e164, null);
    assert.equal(normalizePhone('+1234567890123456').e164, null);
  });

  test('extractPhones returns only resolvable E.164 numbers, deduped', () => {
    const found = extractPhones(`ring ${LRE}+91 90000 11111${PDF} or +91 90000 11111 but not 9389998942`);
    assert.deepEqual(found, ['+919000011111']);
  });
});
