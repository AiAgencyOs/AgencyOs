import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * Who this contact already is — G-210.
 *
 * ── the question the importer never asked ─────────────────────────────────
 *
 * `match.ts` classifies IDENTITY — `exact`, `new`, `probable`, `conflict`,
 * `unmatched` — is this row the same person as somebody we hold? That is what
 * a deduplicator needs and it answers it well.
 *
 * It never asks what an operator asks before a campaign: **who is this to us
 * already?** A file of twelve hundred numbers contains current clients, deals
 * somebody is actively working, people who told us no, and people waiting for
 * a date we agreed with them.
 *
 * ── most of this file is about what is NOT classified ─────────────────────
 *
 * There is no `hot` and no `warm`. A judgement rendered as a label is the
 * invented score ADM-88 refused — *"no numeric lead score and no invented
 * weights"* — and `crm.leads` still carries the CHECK that keeps `score`
 * null. Every class this adds is a fact with a row behind it.
 *
 * The live proof is `verify-lead-import` §11, which creates each fact and
 * reads the classification back through the real RPC. This file guards the
 * absences, and the section is their positive twin.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260905120000_who_this_contact_already_is.sql');
const SQL = sqlCode(MIGRATION);

describe('A. no judgement is dressed as a fact', () => {
  for (const invented of ["'hot'", "'warm'", "'likely'", "'promising'", "'high_intent'", "'score'"]) {
    test(`no ${invented} class`, () => {
      assert.ok(!SQL.includes(invented), `${invented} is a judgement — that is ADM-88's invented score in a new costume`);
    });
  }

  test('and no coefficient, weight or arithmetic anywhere in the classification', () => {
    // `reactivation_priority` was built this way for the same reason: a
    // deterministic order over recorded facts, with no number to argue with.
    assert.doesNotMatch(SQL, /\bweight\b|\bcoefficient\b|\* 0\.|\bscore\s*\+/);
  });

  test('the reasoning is in the file a reader would open', () => {
    assert.match(MIGRATION, /a judgement rendered as a label is the invented score ADM-88 refused/);
  });
});

describe('B. every class is a row that exists', () => {
  const classes = ['client', 'active_deal', 'nurture', 'lost', 'previously_quoted', 'previously_replied', 'has_conversation', 'cold', 'unknown'];

  for (const cls of classes) {
    test(`${cls} is produced`, () => {
      assert.ok(SQL.includes(`'${cls}'`), `${cls} is missing from the classification`);
    });
  }

  test('and each one is decided by an EXISTS over a real table, not by a guess', () => {
    // Nine classes, eight `exists` probes and a final else — the shape that
    // makes "unknown" the honest answer rather than a default anybody reads
    // as information.
    const existsCount = (SQL.match(/when exists \(/g) ?? []).length;
    assert.ok(existsCount >= 7, `only ${existsCount} fact probes — a class without one is an assertion`);
    assert.match(SQL, /else 'unknown'/);
  });
});

describe('C. who may not be written to, and who may', () => {
  test('client, active_deal and nurture are excluded — and only those', () => {
    assert.match(SQL, /select p_relationship not in \('client', 'active_deal', 'nurture'\)/);
  });

  test('LOST is contactable, because it is what re-engagement is for', () => {
    // Excluding it would exclude the point of the whole campaign. Stated in
    // the comment so nobody "fixes" it later.
    assert.match(MIGRATION, /LOST is contactable/);
  });

  test('the exclusion lives in ONE function, not in three call sites', () => {
    // The preview, the screen and any bulk enrolment must mean the same thing
    // by "excluded", or the count an operator approves is not the campaign
    // that runs.
    assert.match(SQL, /crm\.relationship_is_contactable\(r\.relationship\)/);
  });
});

describe('D. it adds no reach of its own', () => {
  test('both readers are SECURITY INVOKER', () => {
    // RLS on the tables underneath decides what is visible. A definer here
    // would be a second door onto every lead in the database.
    const invokers = (SQL.match(/security invoker/g) ?? []).length;
    assert.ok(invokers >= 2, `only ${invokers} invoker declarations`);
    assert.doesNotMatch(SQL, /security definer/);
  });

  test('and deleted leads are not evidence of anything', () => {
    assert.ok((SQL.match(/l\.deleted_at is null/g) ?? []).length >= 4);
  });
});
