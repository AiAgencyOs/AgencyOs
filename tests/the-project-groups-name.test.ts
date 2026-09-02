import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * The project group's name — G-188.
 *
 * ── the requirement, quoted, because it is unusually specific ─────────────
 *
 * The brief that commissioned the audit ends at the last step of the flow —
 * PROJECT WHATSAPP GROUP CREATION — and states the title format literally:
 *
 *     PROJECT NAME // FINAL QUOTATION PRICE // PROJECT START DATE //
 *     CLIENT NAME // [remaining configured identifier]
 *
 * The audit found (PG-03) that `crm.conversations.title` is free text on the
 * link form and **nothing composed that name anywhere**.
 *
 * ── what this can and cannot do ───────────────────────────────────────────
 *
 * It cannot create the group. Meta's Cloud API has no Groups API — the owner
 * established that against the real Graph API (#131215) — so a person creates
 * it and links it. The honest half is to compose the exact name and hand it
 * over, because a name retyped from five screens is wrong by the third
 * project.
 *
 * ── and it refuses to invent a segment ────────────────────────────────────
 *
 * Every part is a fact about a row. A title assembled around a guessed price
 * would be read as the price the client agreed, so a missing fact produces no
 * title and a list of what is missing.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION_RAW = read('supabase/migrations/20260902130000_the_project_groups_name.sql');
const MIGRATION = sqlCode(MIGRATION_RAW);
const QUERIES = codeOnly(read('src/modules/projects/queries.ts'));
const PANEL = read('app/(internal)/projects/[projectId]/group-panel.tsx');

describe('A. the format is the brief’s, exactly', () => {
  test('and the SQL stripper does not eat the separator on the way in', () => {
    // `sqlCode` used to inherit TypeScript's `//` rule, which truncated this
    // migration's own separator inside a string literal — so the assertion
    // below ran against a mangled copy and failed on code that was there.
    // Pinned because a helper that silently mangles input makes every
    // assertion downstream of it worth less.
    assert.match(sqlCode("select array_to_string(a, ' // ');"), / \/\/ /);
    assert.equal(sqlCode('select 1; -- a comment').trim(), 'select 1;');
  });

  test('the segments are joined with the separator the brief uses', () => {
    assert.match(MIGRATION, /array_to_string\(v_parts, ' \/\/ '\)/);
  });

  test('and they are assembled in the brief’s order', () => {
    const order = ['v_project.name', 'v_price', 'v_project.starts_on', 'v_client', 'v_identifier'];
    let at = -1;
    for (const part of order) {
      const next = MIGRATION.indexOf(`v_parts := v_parts || `, at + 1);
      assert.ok(next > at, `${part} is out of order`);
      at = next;
    }
    // And the price is the quotation's, not the project's budget: a budget is
    // what the agency planned, the brief asks for what the client agreed.
    assert.match(MIGRATION, /from sales\.proposals pr\s*\n\s*where pr\.id = v_project\.proposal_id/);
    assert.ok(!MIGRATION.includes('budget_minor'));
  });

  test('the price is written in rupees, grouped the Indian way', () => {
    assert.match(MIGRATION, /to_char\(round\(v_price \/ 100\.0\), 'FM99,99,99,999'\)/);
  });

  test('the date is written for a person, not for a machine', () => {
    // The name sits in a WhatsApp list beside a rupee figure; an ISO date
    // there reads as another number.
    assert.match(MIGRATION, /to_char\(v_project\.starts_on, 'FMDD Mon YYYY'\)/);
  });

  test('and it is the PLANNED start, because the group precedes the start', () => {
    // ADM-13 makes the linked group one of the three conditions for the
    // project officially starting, so `started_at` is null at the moment this
    // name is needed.
    assert.match(MIGRATION_RAW, /at the\n-- moment this name is needed, `started_at` is null by definition/);
    assert.ok(!MIGRATION.includes('started_at'));
  });
});

describe('B. it invents nothing, and says what is missing', () => {
  test('each absent fact is named', () => {
    for (const fact of ['project name', 'accepted quotation', 'start date', 'client name']) {
      assert.ok(MIGRATION.includes(`'${fact}'`), `${fact} must be nameable as missing`);
    }
  });

  test('and a partial title is never offered', () => {
    assert.match(MIGRATION, /if array_length\(v_missing, 1\) is not null then\s*\n\s*return query select null::text, v_missing;/);
    assert.match(MIGRATION_RAW, /would be read as the price the client agreed/);
  });

  test('a project that does not exist says so rather than raising', () => {
    assert.match(MIGRATION, /return query select null::text, array\['project'\]::text\[\];/);
  });

  test('the fifth segment is optional, and its absence is not a missing fact', () => {
    // The brief writes it in brackets, which is how an optional field is
    // written. An organization without one gets a four-part name.
    assert.match(MIGRATION, /if coalesce\(btrim\(coalesce\(v_identifier, ''\)\), ''\) <> '' then/);
    assert.ok(!MIGRATION.includes("'identifier'"));
  });
});

describe('C. the owner’s own segment is a setting, and a guarded one', () => {
  test('it joins the whitelist rather than opening the door', () => {
    assert.match(MIGRATION, /'project_group_identifier'\n\s*\) then\s*\n\s*return query select 'invalid_key'/);
  });

  test('and it cannot contain the separator the format uses', () => {
    assert.match(MIGRATION, /if length\(v_value\) > 40 or v_value like '%\/\/%' then/);
  });

  test('the settings function was regenerated, not retyped', () => {
    // The PR #113 near miss, recorded as G-126: a hand-rewritten function
    // drops a branch and every structural test stays green.
    for (const outcome of ['forbidden', 'invalid_key', 'invalid_value', 'not_found', 'cleared']) {
      assert.ok(MIGRATION.includes(`'${outcome}'`), `the ${outcome} answer must survive`);
    }
    for (const key of ['whatsapp_phone_number_id', 'quotation_contact_email', 'pricing_multiplier_max']) {
      assert.ok(MIGRATION.includes(`'${key}'`), `${key} must still be settable`);
    }
    assert.match(MIGRATION_RAW, /REGENERATED FROM THE LIVE DEFINITION, not retyped/);
  });
});

describe('D. the linker uses it, and never overrules a person', () => {
  test('a project group with no title given gets the composed one', () => {
    assert.match(MIGRATION, /if v_title is null and p_kind = 'project_group' and p_project_id is not null then/);
    assert.match(MIGRATION, /select t\.title into v_title from crm\.project_group_title\(p_project_id\) t;/);
  });

  test('a title the caller supplied is left alone', () => {
    assert.match(MIGRATION, /v_title text := p_title;/);
    assert.match(MIGRATION_RAW, /An owner renaming a\s*\n\s*\* group they created is not a mistake to correct/);
  });

  test('and every refusal the linker had survives the regeneration', () => {
    for (const outcome of ['bad_kind', 'group_taken', 'already_linked', 'linked']) {
      assert.ok(MIGRATION.includes(`'${outcome}'`), `the ${outcome} answer must survive`);
    }
    // G-176's announcement rides in the same function and must not be lost.
    assert.match(MIGRATION, /perform crm\.announce_waiting_approvals\(p_organization_id\);/);
  });

  test('an internal group is never named this way', () => {
    // It is not a project's group and has no project to be named from.
    assert.match(MIGRATION, /p_kind = 'project_group' and p_project_id is not null/);
  });
});

describe('E. the name does not cross a tenant', () => {
  test('the composer is INVOKER, so RLS decides what it can read', () => {
    /**
     * It is callable by any authenticated user with a project id in their
     * hand, and what it composes is a client's NAME and the price they
     * agreed. As `security definer` it would hand both to any other agency
     * that guessed an id — which the live red-proof reproduced exactly:
     * "zztest-groups named project // ₹87,500 // … // zztest-groups client".
     *
     * Every other check in the group verifier runs as the service role, which
     * bypasses RLS, so the leak would have looked identical to a pass. Pinned
     * here and proved live in `verify-whatsapp-groups` §7.
     */
    const body = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function crm.project_group_title'),
      MIGRATION.indexOf('create or replace function crm.link_whatsapp_group'),
    );
    assert.ok(body.length > 200, 'the composer must be in this migration');
    assert.ok(!/security definer/i.test(body), 'the composer must not bypass RLS');
    assert.match(body, /stable/);
  });
});

describe('E2. the owner is shown the name, and told what they must do themselves', () => {
  test('the page reads the composed name and the linked group together', () => {
    assert.match(QUERIES, /rpc\('project_group_title', \{ p_project_id: projectId \}\)/);
    assert.match(QUERIES, /\.eq\('kind', 'project_group'\)/);
  });

  test('a failed read refuses rather than rendering "no group yet"', () => {
    // G-054, and it matters more here than usual: this is a start condition.
    assert.match(QUERIES, /if \(composeError\) unreadable\('readProjectGroupName', composeError\);/);
    assert.match(QUERIES, /if \(groupError\) unreadable\('readProjectGroupName', groupError\);/);
  });

  test('the panel says plainly that AgencyOS cannot create the group', () => {
    // The audit's §17: a platform limitation, not a missing feature. A page
    // that showed a name without saying who makes the group would read as a
    // button somebody forgot to add.
    assert.match(PANEL, /AgencyOS cannot create it/);
    assert.match(PANEL, /WhatsApp gives no API/);
  });

  test('and it names what is missing rather than showing a gap', () => {
    assert.match(PANEL, /it is missing/);
    assert.match(PANEL, /\{group\.missing\.join\(', '\)\}/);
  });

  test('a group whose name differs is reported, never renamed', () => {
    assert.match(PANEL, /rename it in WhatsApp if you want/);
    assert.ok(!PANEL.includes('update'), 'the panel must not write anything');
  });
});
