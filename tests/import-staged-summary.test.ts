import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { summarizeStaged, type StagedRecord } from '../src/lib/import/staged.ts';

const rec = (over: Partial<StagedRecord>): StagedRecord => ({
  id: crypto.randomUUID(),
  phone: null,
  display_name: 'X',
  message_count: 1,
  source_label: 's',
  classification: 'unmatched',
  auto_importable: false,
  committed_at: null,
  committed_contact_id: null,
  committed_lead_id: null,
  ...over,
});

describe('summarizeStaged', () => {
  const records: StagedRecord[] = [
    rec({ classification: 'exact', auto_importable: true, phone: '+911', committed_at: '2026-08-18T00:00:00Z' }),
    rec({ classification: 'new', auto_importable: true, phone: '+912' }), // pending
    rec({ classification: 'probable' }),
    rec({ classification: 'conflict' }),
    rec({ classification: 'unmatched' }),
    rec({ classification: 'unmatched' }),
  ];
  const s = summarizeStaged(records);

  test('counts each class', () => {
    assert.equal(s.total, 6);
    assert.equal(s.exact, 1);
    assert.equal(s.new, 1);
    assert.equal(s.probable, 1);
    assert.equal(s.conflict, 1);
    assert.equal(s.unmatched, 2);
  });

  test('only exact+new are importable; the rest are manual review', () => {
    assert.equal(s.autoImportable, 2);
    assert.equal(s.manualReview, 4);
  });

  test('committed and pending split the importable rows', () => {
    assert.equal(s.committed, 1);
    assert.equal(s.pending, 1); // the uncommitted 'new'
  });

  test('consent provenance is always none — a staged import is not consent', () => {
    assert.equal(s.consentProvenance, 'none');
  });

  test('an empty batch summarizes to all zeros, still consent-free', () => {
    const e = summarizeStaged([]);
    assert.equal(e.total, 0);
    assert.equal(e.autoImportable, 0);
    assert.equal(e.consentProvenance, 'none');
  });
});
