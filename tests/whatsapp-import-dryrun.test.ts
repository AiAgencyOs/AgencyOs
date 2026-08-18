import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { aggregate, analyzeExport } from '../src/lib/import/dry-run.ts';
import { parseWhatsAppChat } from '../src/lib/import/whatsapp-chat.ts';

const NNBSP = ' ';
const LRM = '‎';
const LRE = '‪';
const PDF = '‬';

/** A tiny group export: two name authors, one unsaved-contact phone author. */
function fixture(day2: string) {
  return [
    `[01/08/26, 12:19:10${NNBSP}PM] Grp || Deal ||: ${LRM}You created this group`,
    `[01/08/26, 1:00:00${NNBSP}PM] Jane Vendor: hello`,
    `[${day2}, 2:00:00${NNBSP}PM] Jane Vendor: ${LRM}image omitted`,
    `[${day2}, 3:00:00${NNBSP}PM] ${LRE}+91 90000 11111${PDF}: I am unsaved`,
  ].join('\r\n');
}

describe('analyzeExport', () => {
  const r = analyzeExport(parseWhatsAppChat(fixture('13/08/26')), 'sample.txt');

  test('counts messages by kind and resolves the date range', () => {
    assert.equal(r.messages.total, 4);
    assert.equal(r.messages.media, 1);
    assert.ok(r.messages.system >= 1);
    assert.equal(r.dates.order, 'DMY');
    assert.equal(r.dates.ambiguous, false);
  });

  test('separates phone-matchable from name-only participants', () => {
    assert.equal(r.participants.phoneMatchable, 1); // the +91 author
    assert.equal(r.participants.nameOnly, 1); // Jane Vendor (a name)
    const jane = r.participants.list.find((p) => p.displayName === 'Jane Vendor');
    assert.equal(jane?.phoneMatchable, false);
    assert.equal(jane?.phone, null);
  });

  test('consent provenance is always NONE — a message is not consent', () => {
    assert.equal(r.consentProvenance, 'none');
    assert.doesNotMatch(JSON.stringify(r).replace(/"consentProvenance":"none"/g, ''), /consent/i);
  });

  test('an all-<=12 date export is flagged ambiguous, not silently dated', () => {
    const amb = analyzeExport(parseWhatsAppChat(fixture('05/06/26')), 'amb.txt');
    assert.equal(amb.dates.ambiguous, true);
    assert.ok(amb.warnings.some((w) => /ambiguous/i.test(w)));
  });
});

describe('aggregate', () => {
  test('deduplicates phone-matchable people across files by E.164', () => {
    // Same phone author appears in two files -> one distinct person, one duplicate row.
    const a = analyzeExport(parseWhatsAppChat(fixture('13/08/26')), 'a.txt');
    const b = analyzeExport(parseWhatsAppChat(fixture('14/08/26')), 'b.txt');
    const agg = aggregate([a, b]);
    assert.equal(agg.files, 2);
    assert.equal(agg.distinctPhoneMatchable, 1); // +919000011111 once
    assert.equal(agg.duplicatePhoneRows, 1); // the second occurrence collapsed
  });

  test('name-only participants are NEVER deduped by name (a name is not identity)', () => {
    // Two files each with a "Jane Vendor" name author -> 2 name-only, not merged.
    const a = analyzeExport(parseWhatsAppChat(fixture('13/08/26')), 'a.txt');
    const b = analyzeExport(parseWhatsAppChat(fixture('14/08/26')), 'b.txt');
    const agg = aggregate([a, b]);
    assert.equal(agg.nameOnly, 2);
  });

  test('aggregate consent provenance is NONE', () => {
    const a = analyzeExport(parseWhatsAppChat(fixture('13/08/26')), 'a.txt');
    assert.equal(aggregate([a]).consentProvenance, 'none');
  });
});
