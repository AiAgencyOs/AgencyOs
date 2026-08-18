import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { classifyAll, classifyCandidate, type ExistingContact, type ImportCandidate } from '../src/lib/import/match.ts';

const cand = (over: Partial<ImportCandidate> = {}): ImportCandidate => ({
  phone: null,
  displayName: 'Jane Vendor',
  sourceLabel: 'a.txt',
  messageCount: 1,
  ...over,
});

const CONTACTS: ExistingContact[] = [
  { id: 'c1', phone: '+919000011111', fullName: 'Jane Vendor' },
  { id: 'c2', phone: '+919000022222', fullName: 'Bob Buyer' },
  { id: 'c3', phone: '+919000022222', fullName: 'Bob Buyer (dup)' }, // a phone shared by two rows
  { id: 'c4', phone: null, fullName: 'Mahir' },
  { id: 'c5', phone: null, fullName: 'Mahir' }, // a name shared by two rows
];

describe('classifyCandidate — phone decides identity, never a name', () => {
  test('a phone that matches exactly one contact is EXACT and auto-importable (update)', () => {
    const r = classifyCandidate(cand({ phone: '+919000011111' }), CONTACTS);
    assert.equal(r.classification, 'exact');
    assert.deepEqual(r.matchedContactIds, ['c1']);
    assert.equal(r.autoImportable, true);
  });

  test('a phone that matches no contact is NEW and auto-importable (safe create)', () => {
    const r = classifyCandidate(cand({ phone: '+919000099999', displayName: 'Nobody' }), CONTACTS);
    assert.equal(r.classification, 'new');
    assert.deepEqual(r.matchedContactIds, []);
    assert.equal(r.autoImportable, true);
  });

  test('a phone matching MORE THAN ONE contact is a CONFLICT, never auto-imported', () => {
    const r = classifyCandidate(cand({ phone: '+919000022222' }), CONTACTS);
    assert.equal(r.classification, 'conflict');
    assert.deepEqual(r.matchedContactIds.sort(), ['c2', 'c3']);
    assert.equal(r.autoImportable, false);
  });

  test('phone WINS over name: a phone with no match is NEW even if the name collides', () => {
    // displayName 'Jane Vendor' equals c1's name, but the phone matches nobody —
    // identity follows the phone, so this is a new record, not a match to c1.
    const r = classifyCandidate(cand({ phone: '+915555555555', displayName: 'Jane Vendor' }), CONTACTS);
    assert.equal(r.classification, 'new');
    assert.deepEqual(r.matchedContactIds, []);
  });
});

describe('classifyCandidate — a name is not an identity', () => {
  test('no phone + unique name match is PROBABLE and NOT auto-importable', () => {
    const r = classifyCandidate(cand({ phone: null, displayName: 'Jane Vendor' }), CONTACTS);
    assert.equal(r.classification, 'probable');
    assert.deepEqual(r.matchedContactIds, ['c1']);
    assert.equal(r.autoImportable, false);
  });

  test('no phone + a name matching several contacts is a CONFLICT, not auto-imported', () => {
    const r = classifyCandidate(cand({ phone: null, displayName: 'Mahir' }), CONTACTS);
    assert.equal(r.classification, 'conflict');
    assert.equal(r.autoImportable, false);
  });

  test('no phone + no name match is UNMATCHED, not auto-imported', () => {
    const r = classifyCandidate(cand({ phone: null, displayName: 'Totally New Person' }), CONTACTS);
    assert.equal(r.classification, 'unmatched');
    assert.equal(r.autoImportable, false);
  });

  test('RED-PROOF: a name-only candidate is NEVER auto-importable, whatever it matches', () => {
    for (const name of ['Jane Vendor', 'Mahir', 'Totally New Person', '']) {
      const r = classifyCandidate(cand({ phone: null, displayName: name }), CONTACTS);
      assert.equal(r.autoImportable, false, `name-only "${name}" must never auto-import`);
    }
  });
});

describe('classifyAll summary and safety', () => {
  test('summary counts each bucket and only exact+new are auto-importable', () => {
    const candidates: ImportCandidate[] = [
      cand({ phone: '+919000011111' }), // exact
      cand({ phone: '+919000099999', displayName: 'New' }), // new
      cand({ phone: null, displayName: 'Jane Vendor' }), // probable
      cand({ phone: null, displayName: 'Mahir' }), // conflict
      cand({ phone: null, displayName: 'Ghost' }), // unmatched
    ];
    const { summary } = classifyAll(candidates, CONTACTS);
    assert.equal(summary.total, 5);
    assert.equal(summary.exact, 1);
    assert.equal(summary.new, 1);
    assert.equal(summary.probable, 1);
    assert.equal(summary.conflict, 1);
    assert.equal(summary.unmatched, 1);
    assert.equal(summary.autoImportable, 2); // exact + new only
    assert.equal(summary.manualReview, 3);
  });

  test('nothing in the classifier output is consent', () => {
    const { results } = classifyAll([cand({ phone: '+919000011111' })], CONTACTS);
    assert.doesNotMatch(JSON.stringify(results).toLowerCase(), /consent/);
  });
});
