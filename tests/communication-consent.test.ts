import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * No consent, no send — gap G-012, decisions ADM-70 and ADM-81.
 *
 * ADM-70 granted that automated follow-ups require **recorded** consent, that
 * consent is **channel-specific**, and that suppression must be enforced by
 * the communication system rather than the UI. ADM-81 — the
 * transactional-versus-sales question it left open — is taken here as a
 * delegated decision: **there is no transactional exception.**
 *
 * The tests that matter are the refusals, and the one exemption. ADM-70 named
 * the trap before anybody built it: the approval announcement to the internal
 * group runs through the same chokepoint, is not a client communication, and
 * suppressing it would silently break G-110.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260814120008_no_consent_no_send.sql');
const audit = read('../supabase/migrations/20260814120005_seven_kinds_that_were_not_notes.sql');

/** The chokepoint body, comments stripped — a check must read code, not prose. */
const sendBody = (() => {
  // Case-insensitive: the function was carried forward verbatim from
  // `pg_get_functiondef`, which emits uppercase keywords, rather than retyped.
  // Retyping is how this repository once dropped a branch from a regenerated
  // function without noticing.
  const i = migration.search(/create or replace function crm\.send_outbound_message/i);
  assert.ok(i > 0, 'the chokepoint is not in this migration');
  const end = migration.indexOf('$function$', migration.indexOf('$function$', i) + 1);
  return migration
    .slice(i, end)
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
})();

describe('A. consent is a table, because it is channel-specific', () => {
  test('it is not a column on contacts', () => {
    // ADM-70: a column cannot hold one status per channel, and channel-specific
    // is what was granted.
    assert.match(migration, /create table if not exists crm\.communication_consent/);
    assert.ok(
      !/alter table crm\.contacts[\s\S]{0,200}consent/i.test(migration),
      'consent was added to contacts as a column',
    );
  });

  test('one current status per contact per channel', () => {
    assert.match(migration, /primary key \(organization_id, contact_id, channel\)/);
  });

  test('and only the channel that actually exists is admitted', () => {
    // Email and SMS have no sender, no configuration and no code. A row for a
    // channel nothing can honour is a permission that cannot be acted on.
    assert.match(migration, /check \(channel in \('whatsapp'\)\)/);
  });

  test('withdrawn is a row, not a deletion', () => {
    // Deleting would lose the fact that consent was withdrawn and when — the
    // half that matters when somebody asks why a client stopped being messaged.
    assert.match(migration, /check \(status in \('granted', 'withdrawn'\)\)/);
  });
});

describe('B. the refusal is at the chokepoint, not in a caller', () => {
  test('the guard lives inside send_outbound_message', () => {
    // ADM-70 required the communication system to enforce it: both callers pass
    // through this function, so a future third one cannot skip the rule by not
    // knowing about it.
    assert.match(sendBody, /crm\.communication_consent/);
    assert.match(sendBody, /'no_consent'/);
  });

  test('absent consent and withdrawn consent are the same answer', () => {
    // Asserted through the query's shape: it requires a `granted` row to exist,
    // so anything else — absent, withdrawn, a future status — refuses.
    assert.match(sendBody, /cc\.status\s+= 'granted'/);
    assert.match(sendBody, /if not exists \(/);
  });

  test('and the check precedes the idempotency lookup', () => {
    // A send refused for want of consent must not become permitted by being
    // retried under the same external ref.
    const consentAt = sendBody.indexOf('communication_consent');
    const idempotencyAt = sendBody.indexOf('v_existing.id is not null');
    assert.ok(consentAt > 0 && idempotencyAt > 0, 'one of the two branches is gone');
    assert.ok(consentAt < idempotencyAt, 'a retry reaches the send before consent is checked');
  });

  test('a client conversation with no identifiable contact is refused', () => {
    // Treating "nobody to have consented" as "no objection" is how a consent
    // model becomes decorative.
    assert.match(sendBody, /v_conversation\.contact_id is null/);
  });
});

describe('C. the internal group is exempt, and that is G-110 surviving', () => {
  test('suppression keys off the conversation kind', () => {
    // The trap ADM-70 named before anybody built it. The approval announcement
    // runs through this same function; suppressing it would stop the owner
    // being told what needs deciding, with nothing to say why.
    assert.match(sendBody, /v_conversation\.kind <> 'internal_group'/);
  });

  test('and the exemption is by kind rather than by caller', () => {
    // A caller-based exemption is one a future caller can claim.
    assert.ok(
      !/p_author_id is (not )?null[\s\S]{0,120}no_consent/.test(sendBody),
      'the exemption keys off who is sending rather than what the conversation is',
    );
  });
});

describe('D. consent changes are audited', () => {
  test('the table has the audit trigger', () => {
    assert.match(migration, /create trigger record_row_change\s*\n\s*after insert or update on crm\.communication_consent/);
  });

  test('and the vocabulary arrives in the same change, as ADM-70 warned', () => {
    // `audit.record_row_change` RAISES for any table it has no vocabulary for,
    // so attaching the trigger without a branch would make every write fail.
    assert.match(migration, /when 'communication_consent' then/);
    assert.match(migration, /v_action\s+:= 'consent\.' \|\| new\.status;/);
  });

  test('the function was regenerated whole, not from an older copy', () => {
    // An earlier change here regenerated this same function from a stale copy
    // and silently dropped the `proposals` branch.
    for (const marker of ["when 'proposals' then", "when 'lead_activities' then", 'security invoker']) {
      assert.ok(migration.includes(marker), `the regenerated audit function lost: ${marker}`);
    }
  });

  test('and every branch of the previous version survived', () => {
    // Compared structurally rather than by eye: strip comments and whitespace
    // from both copies, drop the three lines this change adds, and the
    // remainder must be identical. This is the assertion that would have
    // caught the dropped `proposals` branch.
    const linesOf = (sql: string) => {
      const i = sql.indexOf('create or replace function audit.record_row_change');
      return sql
        .slice(i, sql.indexOf('$$;', i))
        .split('\n')
        .map((l) => l.replace(/--.*$/, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    };
    const added = new Set([
      "when 'communication_consent' then",
      "v_subject := 'communication_consent';",
      "v_action := 'consent.' || new.status;",
    ]);
    assert.deepEqual(
      linesOf(migration).filter((l) => !added.has(l)),
      linesOf(audit),
    );
  });
});

describe('E. ADM-81 invented no category', () => {
  test('there is no transactional exception anywhere in the guard', () => {
    // The words transactional, marketing and promotional appear nowhere in any
    // AgencyOS document, so there was no rule to apply and nothing to separate
    // without inventing it. A "transactional" category is also the exact shape
    // a broad marketing exception takes on its way in.
    for (const word of ['transactional', 'marketing', 'promotional']) {
      assert.ok(
        !new RegExp(word, 'i').test(sendBody),
        `the guard distinguishes "${word}", which no business rule defines`,
      );
    }
  });

  test('and agents cannot grant themselves consent', () => {
    // ADM-70. Writes require core.is_admin(), which no agent is.
    assert.match(migration, /create policy communication_consent_write[\s\S]{0,300}core\.is_admin\(\)/);
  });
});
