import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

import { MEETING_STATUSES, completionIsAuthorized } from '../src/modules/crm/schema.ts';

/**
 * What the meeting actually said — gap G-229.
 *
 * The last of the Scheduler's five units, and the one the whole call/meeting
 * branch exists for. Sales Flow §7 calls it the critical trigger: upload
 * evidence, mark completed, analyse, hand the context back to Sales — so that
 * the client is never asked on WhatsApp to repeat what they said on the phone.
 *
 * The gate is the interesting part and the part that fails quietly. §10.1
 * permits analysis only when the interaction is explicitly completed AND
 * evidence is present. A model asked to summarise an empty room will still
 * answer, and §10.3 forbids inventing requirements — so the refusal has to
 * live somewhere the model is not the thing being asked to comply.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260911170000_what_the_meeting_actually_said.sql'));

describe('A. evidence belongs to an exact meeting', () => {
  test('it names the meeting and the lead, and dies with the meeting', () => {
    // §9.2: "Link every artifact to the exact schedule and lead/opportunity."
    // A recording that cannot say which call it is from is one nobody can act on.
    assert.match(SQL, /meeting_id\s+uuid not null references crm\.meetings\(id\) on delete cascade/);
    assert.match(SQL, /lead_id\s+uuid not null references crm\.leads\(id\) on delete cascade/);
  });

  test('it records who uploaded it and when', () => {
    assert.match(SQL, /uploaded_by\s+uuid references core\.users\(id\)/);
    assert.match(SQL, /uploaded_at\s+timestamptz not null default now\(\)/);
  });

  test('§9.2’s kinds are a closed vocabulary, including the notes-only path', () => {
    // Extracted from the CHECK's own `in (...)` list and compared whole, not
    // searched for one literal at a time. The first draft searched, and a
    // red-proof that widened the list to include 'guess' and 'hallucination'
    // stayed green — "closed" only means anything in the direction of things
    // that are NOT in it. Found by review.
    const match = SQL.match(/kind\s+text not null check \(kind in\s*\(([^)]*)\)/);
    assert.ok(match, 'no kind CHECK found — the scan broke');
    const kinds = [...match![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();

    assert.deepEqual(kinds, [
      'chat_export', 'document', 'image', 'notes', 'recording', 'summary', 'transcript',
    ]);
  });

  test('internal and client-visible are separated, and the default is the safe one', () => {
    // An internal note shown to a client cannot be un-shown, so this is a
    // default rather than a nullable column.
    assert.match(SQL, /visibility\s+text not null default 'internal'/);
    assert.match(SQL, /check \(visibility in \('internal', 'client_visible'\)\)/);
  });

  test('a row that carries neither a reference nor a body is refused', () => {
    // It would otherwise satisfy the analysis gate while carrying nothing,
    // which is worse than no row at all.
    assert.match(SQL, /constraint meeting_evidence_carries_something check/);
    assert.match(SQL, /artifact_ref is not null or length\(btrim\(coalesce\(body, ''\)\)\) > 0/);
  });

  test('the artifact is a reference, never the bytes', () => {
    assert.match(SQL, /artifact_ref\s+text/);
    assert.doesNotMatch(SQL, /bytea/);
  });

  test('the table is org-scoped, internal-only and tenancy-guarded', () => {
    assert.match(SQL, /alter table crm\.meeting_evidence enable row level security/);
    assert.match(SQL, /core\.is_internal\(\)/);
    assert.match(SQL, /core\.enforce_parent_org\('meeting_id', 'crm\.meetings'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('lead_id', 'crm\.leads'\)/);
    assert.match(SQL, /core\.freeze_organization_id\(\)/);
  });
});

describe('B. analysis runs on a completed meeting, or not at all', () => {
  test('anything other than completed is refused', () => {
    assert.match(SQL, /if v_meeting\.status <> 'completed' then\s*\n\s*return query select 'not_completed'::text/);
  });

  test('a no-show is deliberately ineligible, and eligibility admits exactly one status', () => {
    // There is nothing to analyse in a meeting that did not happen, and §14
    // gives a no-show its own workflow — a Sales follow-up, not a summary of
    // silence.
    //
    // Asserted as "the eligibility test names exactly one status" rather than
    // "no_show does not appear in a list": the first draft of this test was
    // the second form, and a red-proof widening the check to
    // `not in ('completed', 'no_show')` walked straight past it. An
    // absence-only assertion cannot see a refusal that grew a second member.
    const eligibility = SQL.match(/if v_meeting\.status [^\n]*then/);

    assert.ok(eligibility, 'no eligibility check found — the scan broke');
    assert.equal(
      eligibility[0],
      "if v_meeting.status <> 'completed' then",
      'the analysis gate admits something other than a completed meeting',
    );
  });

  test('and completion itself still needs a person — G-225’s rule, unchanged', () => {
    // Executed rather than read: this is the rule the whole Scheduler
    // specification repeats most, and G-229 must not have loosened it.
    assert.equal(
      completionIsAuthorized({ status: 'completed', completedAt: '2026-09-14T16:00:00.000Z', completedBy: null }),
      false,
    );
    assert.equal(
      completionIsAuthorized({
        status: 'completed',
        completedAt: '2026-09-14T16:00:00.000Z',
        completedBy: '11111111-1111-4111-8111-111111111111',
      }),
      true,
    );
  });

  test('completed is still one of the statuses the domain admits', () => {
    // Guards the assertion above from becoming vacuous if the vocabulary moved.
    assert.ok(MEETING_STATUSES.includes('completed'));
    assert.ok(MEETING_STATUSES.includes('no_show'));
  });
});

describe('C. the refusal that matters — nothing to analyse', () => {
  test('a completed meeting with no evidence does not queue a job', () => {
    // A model asked to summarise an empty room will still answer. §10.3
    // forbids inventing requirements, so the refusal lives here rather than in
    // a prompt, where the model is the thing being asked to comply.
    assert.match(SQL, /select count\(\*\) into v_evidence\s*\n\s*from crm\.meeting_evidence e\s*\n\s*where e\.meeting_id = v_meeting\.id/);
    assert.match(SQL, /if v_evidence = 0 then\s*\n\s*return query select 'no_evidence'::text, null::uuid/);
  });

  test('the count is taken before the job is written, not after', () => {
    const gateAt = SQL.indexOf("'no_evidence'");
    const insertAt = SQL.indexOf('insert into core.jobs');

    assert.ok(gateAt > 0 && insertAt > 0);
    assert.ok(gateAt < insertAt, 'the job is queued before the evidence is counted');
  });
});

describe('D. asking twice analyses once', () => {
  test('the job is deduped on the meeting, in ONE statement', () => {
    // Marking a meeting complete twice, or an operator pressing the button
    // again, must not queue a second analysis of the same call — and two
    // operators pressing it at once must not race a probe-then-insert into a
    // raw unique_violation, which is what the first draft's SELECT-then-INSERT
    // would have done. Found by review.
    assert.match(SQL, /v_key := 'meeting\.analysis:' \|\| v_meeting\.id::text/);
    assert.match(SQL, /on conflict \(dedupe_key\) where dedupe_key is not null do nothing/);
    assert.match(SQL, /return query select 'already_queued'::text, v_job/);
  });

  test('it runs as DEFINER, because an invoker could never write the job', () => {
    // core.jobs admits exactly one INSERT kind from an authenticated caller
    // ('requirement.extract') and no UPDATE at all. The first draft was
    // SECURITY INVOKER and its 'queued' branch was unreachable by any caller on
    // earth — RLS refused authenticated, and the org check refused the service
    // role. Found by review. The tenancy guard is therefore explicit, in the
    // repository's idiom: an authenticated caller must own the row.
    assert.match(SQL, /security definer\s*\n\s*set search_path = ''\s*\n\s*as \$\$\s*\n\s*declare\s*\n\s*v_actor\s+uuid := \(select auth\.uid\(\)\);/);
    assert.match(SQL, /if v_actor is not null\s*\n\s*and v_meeting\.organization_id is distinct from \(select core\.current_organization_id\(\)\) then\s*\n\s*return query select 'forbidden'::text/);
  });

  test('the payload carries what the analysis needs to find the conversation', () => {
    for (const field of ['meeting_id', 'lead_id', 'opportunity_id', 'evidence_count']) {
      assert.match(SQL, new RegExp(`'${field}'`), `${field} is not in the payload`);
    }
  });

  test('a caller from another organization is refused', () => {
    assert.match(SQL, /return query select 'forbidden'::text/);
  });

  test('the function is not reachable by anon or the public role', () => {
    assert.match(SQL, /revoke all on function crm\.request_meeting_analysis\(uuid\) from public, anon/);
    assert.match(SQL, /grant execute on function crm\.request_meeting_analysis\(uuid\) to authenticated, service_role/);
  });
});

describe('E. what analysis may produce', () => {
  test('no new "confirmed fact" path is opened', () => {
    // §10.3: "AI inference is not automatically a confirmed client fact."
    // This repository already has the right shape — requirement_versions are
    // born `proposed` and a human accepts them — and G-229 joins that path
    // rather than opening a second one with different rules. Asserted as an
    // absence because the absence IS the design: nothing here writes a
    // requirement, a confirmation, or a lead status.
    assert.doesNotMatch(SQL, /insert into crm\.requirement_versions/);
    assert.doesNotMatch(SQL, /update crm\.leads/);
    assert.doesNotMatch(SQL, /'accepted'/);
  });

  test('and the job is the only thing it creates', () => {
    // The positive twin of the absence above: exactly one write, and it is a
    // queued job rather than a domain fact.
    const inserts = SQL.match(/insert into [a-z_.]+/g) ?? [];

    assert.deepEqual(inserts, ['insert into core.jobs']);
  });
});
