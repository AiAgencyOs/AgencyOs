import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * A returning client is remembered — G-199 (Doc 05 §4, audit LM-08).
 *
 * `ai.memory_records` has had a `client` scope since the day it was created,
 * and **not one row had ever been written at it**. Lead memory worked: the
 * intent read records what a client says about themselves, scoped to the
 * lead. But a lead ends.
 *
 * So a client who came back — the same person, a second project, six months
 * later — met an agency that had forgotten them. Everything it knew was
 * attached to a lead that had closed.
 *
 * ── who may write a client fact ───────────────────────────────────────────
 *
 * Not an agent, and not on its own judgement. Doc 05 §18 defines VERIFIED as
 * *"confirmed by an authoritative business process"* — and **winning the deal
 * is that process**. It is the moment the system learns this person is a
 * client; it is a row nobody can write by hand; it happens once.
 *
 * So the promotion is a trigger on that transition rather than a job, a
 * prompt or an agent. It cannot be reached through language, which is the
 * rule Doc 19 §38 states and `memory_that_cannot_promote_itself` built the
 * table around.
 *
 * ── and what is carried is not the same as what is promoted ───────────────
 *
 * The WIN becomes a verified fact authored by no agent. What the client SAID
 * is carried at its own confidence with its own provenance — winning does not
 * make a sentence truer. An INFERENCE is left behind entirely, because
 * carrying a guess is exactly how a guess becomes a permanent client fact.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = sqlCode(read('supabase/migrations/20260904150000_a_returning_client_is_remembered.sql'));
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));

describe('A. only the win writes a client fact', () => {
  test('the trigger fires on the TRANSITION, not on the state', () => {
    // A routine update of a won deal must write nothing.
    assert.match(MIGRATION, /if new\.stage <> 'won' or old\.stage is not distinct from 'won' then\s+return new;/);
    assert.match(MIGRATION, /after update of stage on sales\.opportunities/);
  });

  test('and the fact it writes is VERIFIED, authored by no agent', () => {
    // An agent writing this would be an agent confirming its own inference —
    // which the table refuses anyway, and which this must not try.
    assert.match(MIGRATION, /'verified', 'sales\.opportunity', new\.id, null/);
  });

  test('it is idempotent by provenance rather than by a flag', () => {
    assert.match(MIGRATION, /m\.source_kind = 'sales\.opportunity' and m\.source_id = new\.id/);
  });

  test('a deal with no contact behind it writes nothing, and does not refuse the win', () => {
    // A memory feature blocking a sale would be the wrong trade in every
    // direction.
    assert.match(MIGRATION, /if v_contact is null then\s+return new;/);
  });
});

describe('B. what is carried, and what is left behind', () => {
  test('EXPLICIT rows are carried — the client’s own words', () => {
    assert.match(MIGRATION, /and m\.confidence = 'explicit'/);
  });

  test('and an inference is left behind entirely', () => {
    // Doc 05 §35's sentence, enforced by the absence of a branch: there is no
    // clause that would carry `inferred`.
    assert.ok(!MIGRATION.includes("m.confidence in ('explicit'"), 'no widening of the carried set');
    assert.ok(!MIGRATION.includes("'inferred'"), 'an inference must not be nameable here at all');
  });

  test('provenance travels with the row rather than being restamped', () => {
    // Winning does not make a sentence truer, so the source message, the
    // confidence and the author all survive the move.
    assert.match(MIGRATION, /select m\.organization_id, 'client', v_contact, m\.kind, m\.fact,\s*m\.confidence, m\.source_kind, m\.source_id, m\.authored_by_agent/);
  });

  test('a client who says the same thing twice is remembered once', () => {
    assert.match(MIGRATION, /and c\.kind = m\.kind and c\.fact = m\.fact/);
  });

  test('superseded and expired rows are not carried', () => {
    assert.match(MIGRATION, /and m\.superseded_by is null\s+and \(m\.expires_at is null or m\.expires_at > now\(\)\)/);
  });

  test('and the promotion is audited, with how much it carried', () => {
    assert.match(MIGRATION, /'client\.remembered', 'contact', v_contact/);
    assert.match(MIGRATION, /jsonb_build_object\('opportunityId', new\.id, 'carried', v_carried\)/);
  });
});

describe('C. and the agent is handed it', () => {
  test('client memory is recalled for the contact, org-scoped', () => {
    assert.match(
      WORKFLOWS,
      /rpc\('recall', \{\s*p_scope: 'client',\s*p_scope_id: conversation\.contact_id,\s*p_limit: 8,\s*p_organization_id: job\.organization_id,/,
    );
  });

  test('the lead recall now names its tenant too', () => {
    // G-189's fourth argument. A lead id is already tenant-specific so
    // nothing could leak through it; saying whose memories this asks for
    // costs nothing and stops the next scope from having to be the one that
    // remembers.
    assert.match(
      WORKFLOWS,
      /p_scope: 'lead',\s*p_scope_id: conversation\.lead_id,\s*p_limit: 8,[\s\S]{0,400}?p_organization_id: job\.organization_id,/,
    );
  });

  test('the two are shown SEPARATELY, and labelled for what they are', () => {
    // One is what this enquiry has said; the other is what this relationship
    // knows. A model handed them mixed cannot tell a new client's first
    // sentence from a returning one's history.
    assert.match(WORKFLOWS, /What they have told us on THIS enquiry:/);
    assert.match(WORKFLOWS, /What we already know about this client, from before:/);
  });

  test('and neither line appears when there is nothing to say', () => {
    assert.match(WORKFLOWS, /remembered \? `\\nWhat we already know about this client, from before:[\s\S]{0,40}?` : ''/);
  });
});
