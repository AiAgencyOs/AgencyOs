import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Only what Admin approved — Master §7.9, §8; PM §4.4, §14; G-282.
 *
 * G-280 built the first half of §16's order: internal review before Admin. Its
 * migration named this unit as the second half rather than leaving the absence
 * to be discovered. This is that unit.
 *
 * Master §8 marks one Admin Panel row **very important** and phrases it as a
 * question the panel must answer: *"Which UI samples were sent to this
 * client?"* — **without reading WhatsApp manually.** That sentence is why the
 * share is a frozen snapshot rather than a join, and the assertion this file
 * exists for is the consequence: **revising an option later must not rewrite
 * what the client saw.**
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260919130000_only_what_admin_approved.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const GATES = read('supabase/migrations/20260919120000_the_order_is_the_control.sql');

const door = (() => {
  const start = SQL.indexOf('create or replace function projects.record_design_share');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. the rule: nothing unapproved reaches a client', () => {
  test('an option Admin has not approved is refused', () => {
    assert.match(door, /and t\.admin_status <> 'approved'/);
    assert.match(door, /'not_approved'::text/);
  });

  test('and the refusal NAMES the offending options', () => {
    // A PM told "one of these is not approved" has to go and find out which.
    assert.match(door, /format\('not_approved:%s', t\.name\)/);
    assert.match(PROSE, /a PM told \*"one of these is not\s+approved"\* has to go and find out which/);
  });

  test('an id from another project is not approved either, and is COUNTED', () => {
    // `= any()` silently ignores what it cannot find, so a caller passing a
    // foreign id would otherwise share fewer options than they asked for and
    // be told it worked.
    assert.match(door, /if v_count <> array_length\(p_theme_option_ids, 1\) then/);
    assert.match(PROSE, /`= any\(\)` silently\s+ignores what it cannot find/);
  });

  test('the check runs before anything is written', () => {
    assert.ok(door.indexOf("'not_approved'") < door.indexOf('insert into projects.client_design_shares'));
  });

  test('and the gate it depends on is still the one G-280 built', () => {
    // The positive twin: `admin_status` only reaches 'approved' through the
    // Admin door, and that door refuses an option internal review has not
    // passed. Without it this check would be guarding an open field.
    assert.match(GATES, /if v_theme\.internal_review_status <> 'passed' then/);
    assert.match(GATES, /update projects\.theme_options set admin_status = 'approved'/);
  });
});

describe('B. the record answers §8’s question', () => {
  test('it is a snapshot, not a join', () => {
    // A live join answers what those options are NOW — a different question,
    // and a worse one.
    assert.match(SQL, /shared_options\s+jsonb not null/);
    assert.match(door, /select jsonb_agg\(/);
    assert.match(PROSE, /an option revised after it was sent would make the\s+record claim the client saw something they never did/);
  });

  test('the snapshot carries what a person would need to identify it', () => {
    for (const field of ['themeOptionId', 'name', 'version', 'figmaNodeId', 'previewAssetUrl', 'colors']) {
      assert.match(door, new RegExp(`'${field}'`), `${field} is not in the snapshot`);
    }
  });

  test('a palette travels with its direction, never alone', () => {
    // §12 makes a colour belong to a theme. A palette shared without the
    // direction it was drawn for is a swatch.
    assert.match(door, /from projects\.color_options c\s*\n\s*where c\.theme_option_id = t\.id/);
    assert.match(PROSE, /a palette shared without its direction\s+is a swatch/);
  });

  test('and a share can never be edited afterwards', () => {
    // §8: historical data must be preserved. Proven on a scratch Postgres:
    // the update raises.
    // The raise must be the FIRST statement in the body, not merely present:
    // a red-proof inserting `return new;` above it left the message in place
    // and this test green. Asserting the message is asserting the sentence
    // beside the guard.
    assert.match(SQL, /as \$\$\s*\nbegin\s*\n\s*raise exception 'a client design share is a record of what was sent; it cannot be edited'/);
    assert.match(SQL, /create trigger freeze_client_design_share\s*\n\s*before update on projects\.client_design_shares/);
  });

  test('each round is numbered, so "which set" has an answer', () => {
    assert.match(SQL, /share_number\s+int not null check \(share_number > 0\)/);
    assert.match(SQL, /unique \(project_id, share_number\)/);
  });
});

describe('C. what else is refused, and why each exists', () => {
  test('an option with neither a Figma reference nor a preview', () => {
    // Sharing it would be sending a name. §5 permits a preview as a SECONDARY
    // artifact, so either satisfies this — what is refused is having neither.
    assert.match(door, /and t\.figma_node_id is null\s*\n\s*and t\.preview_asset_url is null/);
    assert.match(door, /'nothing_to_show'::text/);
    assert.match(PROSE, /what is refused is having neither/);
  });

  test('a share with no evidence reference', () => {
    // The same rule record_kickoff carries, for the same reason.
    assert.match(door, /'no_evidence'::text/);
    assert.match(SQL, /evidence_ref\s+text not null check \(length\(btrim\(evidence_ref\)\) between 1 and 300\)/);
    assert.match(PROSE, /claiming a client was shown something nobody can show them being shown/);
  });

  test('a channel nobody defined', () => {
    assert.match(door, /'bad_channel'::text/);
    assert.match(SQL, /channel\s+text not null check \(channel in \('whatsapp', 'email', 'other'\)\)/);
  });

  test('an empty list of options', () => {
    assert.match(door, /'no_options'::text/);
  });

  test('and all four are argument-only refusals, before any row is read', () => {
    for (const code of ["'no_options'", "'bad_channel'", "'no_evidence'"]) {
      assert.ok(door.indexOf(code) < door.indexOf('for update'), `${code} is checked after the row`);
    }
  });
});

describe('D. it records a send; it does not send', () => {
  test('nothing here contacts a client', () => {
    assert.doesNotMatch(SQL, /send_outbound_message|dispatchMessage|http|pg_net/i);
    assert.match(PROSE, /\*\*IT DOES NOT SEND\.\*\*/);
  });

  test('and the blockers are named, so the absence is a state not an oversight', () => {
    assert.match(PROSE, /BLK-003/);
    assert.match(PROSE, /BLK-007/);
    assert.match(PROSE, /When a\s+channel exists, the sender fills the evidence argument/);
  });

  test('a shared option is not a chosen one', () => {
    // The client has seen them and has not answered, which is a different
    // fact from having chosen. This door never writes `selected`.
    assert.match(door, /set client_status = 'shared'/);
    assert.doesNotMatch(door, /client_status = 'selected'|client_status = 'locked'/);
    assert.match(PROSE, /which is a different fact\s+from having chosen/);
  });

  test('and it only moves an option that had not been shared', () => {
    // A re-share of an option the client already changed their mind about
    // must not reset that.
    // BOTH updates — the theme options and their palettes. A single match
    // passed while the theme guard was removed, because the colour one still
    // carried the same text: the assertion matched the wrong copy.
    assert.equal((door.match(/and client_status = 'not_shared'/g) ?? []).length, 2);
  });

  test('the phase waits on the client afterwards', () => {
    assert.match(door, /set state = 'waiting_client'/);
    assert.match(door, /and state in \('client_review', 'admin_review', 'revision'\)/);
  });
});

describe('E. the guards this table and door carry', () => {
  test('every org-scoped foreign key is tenancy-guarded', () => {
    assert.match(SQL, /core\.enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('phase_three_id', 'projects\.phase_three'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('conversation_id', 'crm\.conversations'\)/);
  });

  test('RLS on, forced, internal-only, no write policy', () => {
    assert.match(SQL, /alter table projects\.client_design_shares enable row level security/);
    assert.match(SQL, /alter table projects\.client_design_shares force row level security/);
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to /);
  });

  test('the door refuses a null actor and is tenancy-checked, without failing open', () => {
    assert.match(door, /v_actor\s+uuid := \(select auth\.uid\(\)\)/);
    assert.match(door, /'no_actor'::text/);
    // G-281: `not NULL` is NULL and an `if` does not execute it.
    assert.match(door, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
    assert.doesNotMatch(door, /not \(select core\.can_write\(\)\)/);
  });

  test('it locks the phase row before deciding, and is security definer', () => {
    assert.match(door, /for update/);
    assert.match(door, /security definer\s*\nset search_path = ''/);
  });

  test('it audits and announces in the same transaction, and is not callable by the world', () => {
    assert.match(door, /perform core\.record_audit\(/);
    assert.match(door, /perform core\.emit_event\(/);
    assert.match(SQL, /'project\.design_options_shared'/);
    assert.match(SQL, /revoke all on function projects\.record_design_share\(uuid, uuid\[\], text, text, uuid\) from public, anon/);
  });
});
