import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Audit finding D22 — which tenant an inbound WhatsApp message belongs to.
 *
 * `crm.ingest_whatsapp_message` resolves it from data:
 *
 *     select o.id into v_org
 *       from core.organizations o
 *      where o.settings->>'whatsapp_phone_number_id' = p_phone_number_id
 *      limit 1;
 *
 * No ORDER BY. Two organizations carrying the same id is an accepted state —
 * nothing prevents it — and when it happens the message lands in whichever row
 * came back first. Not merely unspecified: unstable, because the same number
 * can route differently on a later call as the table changes shape.
 *
 * `v_org` is then stamped on the contact, the lead, the conversation, the
 * message and the extraction job. So a customer's phone number, name and the
 * text of what they wrote are written into another agency's tenant, where that
 * agency's RLS correctly shows it to them. It is the one direction the
 * isolation model has no answer for, because nothing was breached — the row was
 * filed under the wrong owner when it was created.
 *
 * The fix makes the ambiguity unrepresentable rather than making the lookup
 * pick a side, so the function is untouched: with at most one match, `limit 1`
 * has nothing left to order. That coupling is what this file pins — the index
 * is only sufficient while the lookup keys on exactly the expression it covers,
 * so both are read and compared rather than asserted separately.
 *
 * The index is proved to refuse against a real database in verify-schema.mjs §5.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) => readFileSync(new URL(relative, new URL(root, 'file:')), 'utf8');

const migration = read('supabase/migrations/20260812120007_one_organization_per_whatsapp_number.sql');
const ingest = read('supabase/migrations/20260811120002_whatsapp_terminal_lead_extraction.sql');

/** The executable SQL, so a comment can never satisfy an assertion. */
const executable = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/** The key the ingest function actually keys tenancy on. */
const SETTINGS_KEY = "settings->>'whatsapp_phone_number_id'";

// ═══════════════════════════════════════════════════════════════════════════
// A. The index
// ═══════════════════════════════════════════════════════════════════════════

describe('A. one organization per WhatsApp number', () => {
  test('a unique index, on core.organizations', () => {
    assert.match(
      executable,
      /create unique index if not exists organizations_whatsapp_number_key[\s\S]{0,120}on core\.organizations/,
    );
  });

  test('over the settings key, not over a column that happens to be near it', () => {
    assert.match(executable, /on core\.organizations \(\(settings->>'whatsapp_phone_number_id'\)\)/);
  });

  test('partial, so organizations with no WhatsApp number do not collide', () => {
    // Without this every organization that has configured nothing shares a
    // null, and the second one to be created is refused.
    assert.match(executable, /where settings->>'whatsapp_phone_number_id' is not null/);
  });

  test('it changes no table', () => {
    assert.doesNotMatch(executable, /create table|alter table|drop table|drop constraint/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The coupling that makes the index sufficient
// ═══════════════════════════════════════════════════════════════════════════

describe('B. the lookup and the index agree', () => {
  test('the ingest function still keys tenancy on that exact expression', () => {
    // If the lookup ever keys on something else — a column, a different
    // settings key — the index stops constraining it and the missing ORDER BY
    // matters again. The function is deliberately not modified by this fix, so
    // this is the assertion that keeps that decision honest.
    const at = ingest.indexOf('create or replace function crm.ingest_whatsapp_message');
    assert.ok(at > 0, 'the ingest function moved');

    const body = ingest.slice(at);
    assert.ok(
      body.includes(`o.${SETTINGS_KEY} = p_phone_number_id`),
      'the tenancy lookup no longer keys on the expression the index covers',
    );
  });

  test('and the index covers the same expression the lookup uses', () => {
    assert.ok(
      executable.includes(`(${SETTINGS_KEY})`),
      'the index and the lookup have drifted apart',
    );
  });

  test('the lookup is still the unordered LIMIT 1 the index exists to bound', () => {
    // Not a defect any more, and worth saying so where somebody will read it:
    // this file explains why the function was left alone. If a future change
    // adds an ORDER BY, this test fails and the migration's reasoning should
    // be revisited rather than left describing code that no longer exists.
    const at = ingest.indexOf(`o.${SETTINGS_KEY} = p_phone_number_id`);
    assert.ok(at > 0);
    const lookup = ingest.slice(at, at + 200);
    assert.match(lookup, /limit 1;/);
    assert.doesNotMatch(lookup.split('limit 1;')[0] ?? '', /order by/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. It refuses legibly on a database that is already ambiguous
// ═══════════════════════════════════════════════════════════════════════════

describe('C. an existing collision', () => {
  test('is detected before the index is built', () => {
    const guard = executable.indexOf('raise exception');
    const index = executable.indexOf('create unique index');
    assert.ok(guard > 0 && index > guard, 'the pre-flight no longer runs before the index');
  });

  test('and names the number and the organizations claiming it', () => {
    // CREATE UNIQUE INDEX alone reports only the key, and _bundle.sql wraps
    // every migration in one transaction — so a single collision would roll
    // back a whole install with a message identifying neither the tenants nor
    // the remedy.
    assert.match(executable, /D22: more than one organization claims the same WhatsApp phone number id/);
    assert.match(executable, /string_agg\(o\.id::text/);
  });

  test('it does not choose a winner', () => {
    // Which organization keeps the number is a question about who owns the
    // WhatsApp account. The migration stops rather than deciding.
    assert.doesNotMatch(executable, /update core\.organizations|delete from core\.organizations/);
  });
});
