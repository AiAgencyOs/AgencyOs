import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

/**
 * The campaign preview shows who is excluded — G-211.
 *
 * G-210 built the classification and proved it live. **Nothing rendered it.**
 * So the answer existed and no operator could see it, which is half a feature
 * — and specifically the half the claim rested on: a campaign is safe because
 * somebody can SEE who is excluded before authorising it.
 *
 * The batch screen already answered *"can we file this row?"* — importable,
 * pending, manual review. It could not answer *"may we write to this person?"*
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const PAGE = read('app/(internal)/import/[batchId]/page.tsx');
const QUERIES = codeOnly(read('src/lib/import/queries.ts'));

describe('A. the question is asked at all', () => {
  test('the screen reads the preview', () => {
    assert.match(codeOnly(PAGE), /const relationships = await importRelationshipPreview\(batchId\);/);
  });

  test('and it comes from the classification G-210 built, not a second copy', () => {
    // Two implementations of "who may we write to" is two answers, and the
    // campaign would run on whichever one nobody was reading.
    assert.match(QUERIES, /\.rpc\('import_relationship_preview', \{ p_batch_id: batchId \}\)/);
  });
});

describe('B. a failed read refuses', () => {
  test('rather than showing an empty preview', () => {
    // "Nobody in this file is a client" is the most dangerous sentence this
    // surface could say when the database did not answer — the same reason
    // `listLeadsNeedingAttention` refuses rather than reporting nobody needs you.
    assert.match(QUERIES, /unreadable\('importRelationshipPreview', error\)/);
  });
});

describe('C. what the operator actually reads', () => {
  test('every stored class has a human label', () => {
    for (const cls of [
      'client', 'active_deal', 'nurture', 'lost',
      'previously_quoted', 'previously_replied', 'has_conversation', 'cold', 'unknown',
    ]) {
      assert.match(PAGE, new RegExp(`\\b${cls}:`), `${cls} has no label — a stored value would render raw`);
    }
  });

  test('and an excluded class says so on its own tile', () => {
    // Not a legend somewhere else on the page: the count and the fact that it
    // is untouchable have to be in the same glance, or the number reads as
    // "people we are about to message".
    assert.match(PAGE, /r\.contactable \? null : ' · never contacted'/);
  });

  test('the copy says the classes come from records, not from a guess', () => {
    assert.match(PAGE, /From what this system has recorded, not from a guess/);
  });
});
