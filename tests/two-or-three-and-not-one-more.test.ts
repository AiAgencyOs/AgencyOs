import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Two or three, and not one more — Master §7.5, §11, §12, §18; Designer §4.2,
 * §5, §10, §12, §13; G-279.
 *
 * Master §18 names *"too many theme options"* as a cost risk and writes the
 * control as *"hard/default policy of 2-3 meaningful directions"*. Designer §5
 * repeats it as a prohibition: *"must not generate 10-20 options."*
 *
 * **A policy a prompt states is a policy a model can decline to follow.** The
 * assertions here are mostly about the two rules that had to be structural
 * rather than instructed: the ceiling, and the reuse key that makes a retry
 * cheap.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260918160000_two_or_three_and_not_one_more.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');
const COVERAGE = read('supabase/migrations/20260822220000_what_the_conversation_already_answered.sql');

const fn = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} is not defined`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

describe('A. the ceiling is a row rule, not a request', () => {
  test('a trigger refuses the fourth direction', () => {
    assert.match(SQL, /create trigger enforce_theme_option_ceiling\s*\n\s*before insert on projects\.theme_options/);
    assert.match(fn('enforce_theme_option_ceiling'), /if v_count >= coalesce\(v_limit, 3\) then/);
    assert.match(fn('enforce_theme_option_ceiling'), /raise exception/);
  });

  test('and the door answers it rather than crashing', () => {
    // Asking for a fourth direction is a policy refusal a caller should read,
    // not a stack trace.
    assert.match(fn('record_theme_option'), /when check_violation then/);
    assert.match(fn('record_theme_option'), /'limit_reached'::text/);
  });

  test('the limit is configurable but not unbounded', () => {
    // A limit a caller could set to 50 would not be a limit.
    assert.match(SQL, /add column if not exists theme_option_limit int not null default 3/);
    assert.match(SQL, /check \(theme_option_limit between 1 and 5\)/);
    assert.match(PROSE, /a limit a caller could set to 50 would not be a limit/);
  });

  test('and the reason it is structural is written down', () => {
    assert.match(PROSE, /\*\*A policy a prompt states is a policy a model can decline to follow\.\*\*/);
  });

  test('the ceiling counts PER design context', () => {
    // Proven on a scratch Postgres: a new screen baseline changes the context
    // version, and a fresh set of directions is allowed against it. A global
    // count would refuse every revision after the third.
    assert.match(fn('enforce_theme_option_ceiling'), /and t\.source_context_version = new\.source_context_version/);
  });
});

describe('B. the reuse key works in both directions', () => {
  test('it is a deterministic hash, computed in SQL', () => {
    // Master §6: "use deterministic code/rules for comparison metadata; do not
    // spend LLM tokens on deterministic tasks."
    assert.match(SQL, /create or replace function projects\.design_context_version/);
    assert.match(SQL, /language sql\s*\n\s*stable\s*\n\s*security invoker/);
    assert.match(fn('design_context_version'), /select md5\(/);
  });

  test('every part is coalesced, and the reason is the bug it prevents', () => {
    // A NULL anywhere makes the whole concatenation NULL, and two null hashes
    // compare equal — which is the reuse bug the function exists to prevent.
    const body = fn('design_context_version');
    assert.equal((body.match(/coalesce\(/g) ?? []).length, 3);
    assert.match(body, /'no-scope'/);
    assert.match(body, /'no-baseline'/);
    assert.match(body, /'no-coverage'/);
    assert.match(PROSE, /two null hashes compare equal/);
  });

  test('it hashes the scope version, the screen baseline AND what the client said', () => {
    const body = fn('design_context_version');
    assert.match(body, /from projects\.scope_versions sv/);
    assert.match(body, /from projects\.screen_baselines sb/);
    assert.match(body, /from crm\.qualification_coverage qc/);
  });

  test('the client’s answers are REUSED, not re-asked', () => {
    // PM §4.2: "do not re-ask confirmed brand/theme/reference preferences."
    // These areas have been recorded with the client's own quote since August.
    assert.match(COVERAGE, /'platforms',/);
    assert.match(COVERAGE, /'design_expectations',/);
    assert.match(COVERAGE, /'existing_assets',/);
    assert.match(fn('design_context_version'), /qc\.area in \('platforms', 'design_expectations', 'existing_assets',/);
  });

  test('the coverage read is ordered, so the hash is stable', () => {
    // An unordered string_agg would produce a different hash per read and
    // every retry would regenerate — the opposite of the intent.
    assert.match(fn('design_context_version'), /order by qc\.area/);
  });

  test('a replay answers already_recorded with the existing row', () => {
    assert.match(SQL, /unique \(project_id, source_context_version, option_index\)/);
    assert.match(fn('record_theme_option'), /'already_recorded'::text, v_existing\.id, v_context/);
    assert.match(PROSE, /answered before the insert so a replay gets the row\s+rather than a constraint violation/);
  });
});

describe('C. Figma is recorded, never claimed', () => {
  test('nothing in the migration contacts Figma', () => {
    assert.doesNotMatch(SQL, /http|api\.figma|fetch|extension|pg_net/i);
    assert.match(PROSE, /\*\*Nothing in this migration contacts Figma, and nothing claims to\.\*\*/);
  });

  test('every Figma column is nullable and filled by a person', () => {
    assert.match(SQL, /figma_file_key\s+text,/);
    assert.match(SQL, /figma_linked_by\s+uuid references core\.users\(id\)/);
    assert.match(fn('link_theme_figma'), /figma_linked_by = v_actor/);
  });

  test('a half reference is refused on the ARGUMENTS, before the row', () => {
    // Phase 4 must open the exact node, and a file key with no node is a file.
    const body = fn('link_theme_figma');
    assert.ok(body.indexOf("'incomplete_reference'") < body.indexOf('for update'));
    assert.match(SQL, /constraint theme_options_figma_is_whole/);
    assert.match(SQL, /check \(figma_file_key is null\s*\n\s*or \(figma_node_id is not null and figma_linked_at is not null\)\)/);
  });

  test('a preview may never substitute for the node', () => {
    // §5: screenshots and generated images must not become the canonical
    // source. The constraint governs the node, not the preview.
    assert.match(SQL, /preview_asset_url is a SECONDARY review artifact|SECONDARY review artifact/);
    assert.doesNotMatch(SQL, /check \([^)]*preview_asset_url is not null/);
  });

  test('replacing a link is visible, not silent', () => {
    // The audit carries the OLD reference as well as the new.
    assert.match(fn('link_theme_figma'), /jsonb_build_object\('figmaFileKey', v_row\.figma_file_key, 'figmaNodeId', v_row\.figma_node_id\)/);
  });
});

describe('D. the three statuses §16’s order needs', () => {
  test('internal, admin and client are separate columns', () => {
    // One column could not say "internally passed, waiting on Admin" without
    // inventing a combined vocabulary.
    assert.match(SQL, /internal_review_status text not null default 'draft'/);
    assert.match(SQL, /admin_status\s+text not null default 'not_submitted'/);
    assert.match(SQL, /client_status\s+text not null default 'not_shared'/);
    assert.match(PROSE, /a single status could not express "internally\s+passed, waiting on Admin"/);
  });

  test('a locked option must have been Admin-approved', () => {
    // §16: "final selection cannot be overwritten silently." Proven on a
    // scratch Postgres: the update violates the constraint.
    assert.match(SQL, /constraint theme_options_locked_was_selected/);
    assert.match(SQL, /check \(client_status <> 'locked' or admin_status = 'approved'\)/);
  });

  test('and this unit sets none of them — the gates do', () => {
    // Designer §5: the Designer must not mark Admin approval or client
    // confirmation. Recording an option does not advance any gate.
    const body = fn('record_theme_option');
    assert.doesNotMatch(body, /admin_status\s*=|client_status\s*=|internal_review_status\s*=/);
  });
});

describe('E. colour tokens Phase 4 can actually read', () => {
  test('tokens are named columns, not a blob', () => {
    // Designer §4.3 asks for reusable tokens rather than swatches, and Phase 4
    // must read them without guessing a key spelling.
    for (const token of ['primary_hex', 'secondary_hex', 'accent_hex', 'background_hex',
                         'surface_hex', 'text_primary_hex', 'success_hex', 'warning_hex', 'error_hex']) {
      assert.match(SQL, new RegExp(`${token}`), `§13's ${token} has no column`);
    }
  });

  test('and every one is validated hex', () => {
    assert.equal((SQL.match(/~\* '\^#\[0-9a-f\]\{6\}\$'/g) ?? []).length, 10);
    assert.match(fn('record_color_option'), /'bad_token'::text/);
    assert.match(PROSE, /Phase 4 reading an unparseable colour would\s+re-pick it/);
  });

  test('contrast notes are prose, deliberately', () => {
    // Master §21: Phase 3 is not a WCAG certification, and a computed score
    // would claim one.
    assert.match(SQL, /contrast_notes\s+text,/);
    assert.match(PROSE, /a computed score would claim one/);
    assert.doesNotMatch(SQL, /contrast_ratio|wcag_level|aa_pass/i);
  });

  test('a palette is idempotent on its theme and index', () => {
    assert.match(SQL, /unique \(theme_option_id, option_index\)/);
    assert.match(fn('record_color_option'), /'already_recorded'::text, v_existing\.id/);
  });
});

describe('F. a granted decision outranks a field name', () => {
  test('no project_type column is created, anywhere', () => {
    // Designer §11's brief lists it. ADM-73, granted: "AgencyOS must NOT
    // restrict projects to a small hardcoded list of service categories."
    assert.doesNotMatch(SQL, /project_type/);
  });

  test('and the conflict is recorded rather than silently resolved', () => {
    assert.match(PROSE, /ADM-73, granted/);
    assert.match(PROSE, /Recorded as D-5 in the Phase 3 traceability matrix/);
    assert.match(
      read('docs/phase3/AGENCYOS_PHASE3_TRACEABILITY.md'),
      /D-5 — `project_type`/,
    );
  });
});

describe('G. the guards, and what the doors refuse', () => {
  test('theme work is refused before a screen baseline is finalized', () => {
    // Designer §2's start condition. A theme drawn against no agreed screens
    // is a picture, not a direction.
    assert.match(fn('record_theme_option'), /and sb\.status = 'finalized'/);
    assert.match(fn('record_theme_option'), /'no_baseline'::text/);
  });

  for (const name of ['record_theme_option', 'link_theme_figma', 'record_color_option']) {
    test(`${name} refuses a null actor and is tenancy-checked`, () => {
      const body = fn(name);
      assert.match(body, /v_actor\s+uuid := \(select auth\.uid\(\)\)/);
      assert.match(body, /'no_actor'::text/);
      assert.match(body, /core\.current_organization_id\(\)/);
      assert.match(body, /core\.can_write\(\)/);
      assert.match(body, /security definer\s*\nset search_path = ''/);
    });
  }

  test('both tables are tenancy-guarded on every org-scoped key', () => {
    assert.match(SQL, /core\.enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('phase_three_id', 'projects\.phase_three'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('theme_option_id', 'projects\.theme_options'\)/);
    assert.equal((SQL.match(/core\.freeze_organization_id\(\)/g) ?? []).length, 2);
  });

  test('INCLUDING the self-reference, which CI caught on the first run', () => {
    // `revision_of` points at another theme option — an org-scoped foreign key
    // like any other, and the easy one to miss because it points at its own
    // table. Without the guard a revision could name ANOTHER agency's
    // direction. The same class as the three G-256 shipped.
    assert.match(SQL, /core\.enforce_parent_org\('revision_of', 'projects\.theme_options'\)/);
    assert.match(PROSE, /CI caught\s+this on the first run/);
  });

  test('RLS on both, forced, internal-only, no write policy', () => {
    for (const table of ['theme_options', 'color_options']) {
      assert.match(SQL, new RegExp(`alter table projects\\.${table} enable row level security`));
      assert.match(SQL, new RegExp(`alter table projects\\.${table} force row level security`));
    }
    assert.doesNotMatch(SQL, /for (insert|update|delete|all) to /);
  });

  test('none of the three doors is callable by the world', () => {
    assert.equal((SQL.match(/revoke all on function projects\.(record_theme_option|link_theme_figma|record_color_option)/g) ?? []).length, 3);
  });
});
