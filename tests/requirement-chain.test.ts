import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * The chain from a requirement to a task — gap G-020, decision ADM-16.
 *
 * `crm.requirement_versions` held an approved payload and `projects.tasks`
 * were flat: a task could always be created, and nothing recorded *why it
 * exists*. So "which of the things the client asked for is this work" and its
 * inverse, "has everything they asked for been built", were both unanswerable
 * — and the second is the question every scope dispute is made of.
 *
 * The behaviour is proved against a real Postgres by
 * `scripts/verify-requirement-chain.mjs` — 21 checks, watched failing with the
 * accepted-check and the engagement-check removed. What is here is the rules
 * read out of the migration, and above all the join that was wrong in the
 * first draft.
 */

const migration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260813120024_the_chain_from_requirement_to_task.sql', import.meta.url),
  ),
  'utf8',
);

/** The migration's executable SQL: `--` lines and COMMENT ON bodies removed. */
const sql = migration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/comment on [\s\S]*?';/gi, '');

describe('A. the checks below are not vacuous', () => {
  test('the stripped SQL is still the migration', () => {
    assert.match(sql, /create table if not exists projects\.features/);
    assert.match(sql, /function projects\.break_down_requirement/);
    assert.match(sql, /function projects\.requirement_coverage/);
    assert.ok(sql.length > migration.length / 4, 'the strip removed most of the file');
  });
});

describe('B. the lead that is not a lead', () => {
  /**
   * The defect in the first draft, and the reason this suite exists at all.
   *
   * `projects.projects.lead_id` is a foreign key to **core.users** — the
   * delivery lead, a member of staff. It reads like a CRM lead and is not one.
   * The first version of `break_down_requirement` compared it to
   * `crm.conversations.lead_id`, which is a real CRM lead, so the engagement
   * check could never have matched and every breakdown would have been refused
   * as `wrong_project`. It failed on a foreign key before it could be run,
   * which is luck rather than design.
   */
  test('neither function joins projects.lead_id to a CRM lead', () => {
    assert.ok(
      !/p\.lead_id\s*(=|is distinct from)/.test(sql),
      'projects.lead_id is a core.users reference — the delivery lead, not the CRM lead (G-117)',
    );
    assert.ok(
      !/v_project\.lead_id/.test(sql),
      'the breakdown reads projects.lead_id as though it were a CRM lead',
    );
  });

  test('and the column has since been renamed to say which it is', () => {
    // G-117. The trap is closed at the source: `delivery_lead_id` cannot be
    // mistaken for a crm.leads reference by somebody reading a column list.
    const rename = readFileSync(
      fileURLToPath(
        new URL('../supabase/migrations/20260813120026_the_lead_that_is_not_a_lead.sql', import.meta.url),
      ),
      'utf8',
    );
    assert.match(rename, /rename column lead_id to delivery_lead_id/);
  });

  test('both reach the engagement through the opportunity instead', () => {
    assert.match(sql, /from sales\.opportunities o[\s\S]{0,120}?o\.id = v_project\.opportunity_id/);
    assert.match(sql, /join sales\.opportunities o on o\.id = p\.opportunity_id/);
  });
});

describe('C. what the breakdown refuses', () => {
  test('a requirement version that is not accepted', () => {
    // Directive §12 breaks down *approved* requirements. A proposal an agent
    // extracted and nobody confirmed is not a scope to build against.
    assert.match(sql, /v_version\.status <> 'accepted'/);
    assert.match(sql, /'not_approved'/);
  });

  test('a requirement version from another engagement', () => {
    assert.match(sql, /v_lead is distinct from v_project_lead/);
    assert.match(sql, /'wrong_project'/);
  });

  test('a project with no opportunity — "cannot tell" is not "go ahead"', () => {
    // The one check standing between a plan and the wrong client's scope must
    // not default open when it has nothing to check against.
    assert.match(sql, /'unlinked_project'/);
    assert.match(sql, /v_project_lead is null/);
  });

  test('an empty or nameless plan, without half-writing one', () => {
    assert.match(sql, /'empty'/);
    assert.match(sql, /jsonb_typeof\(p_breakdown\) <> 'array'/);
  });

  test('and it never invents a priority the column would reject', () => {
    assert.match(sql, /in \('p0','p1','p2','p3'\)[\s\S]{0,60}?else 'p2'/);
  });
});

describe('D. the rules it holds', () => {
  test('the whole chain is one transaction, in one function', () => {
    // Not three functions a caller composes: a breakdown that half-succeeded
    // would leave modules with no tasks and no way to tell them from modules
    // whose tasks are still being written.
    const fn = sql.slice(sql.indexOf('function projects.break_down_requirement'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    for (const table of ['projects.modules', 'projects.features', 'projects.tasks']) {
      assert.match(body, new RegExp(`insert into ${table.replace('.', '\\.')}`));
    }
  });

  test('the plan is written under the project’s lock', () => {
    assert.match(sql, /from projects\.projects p[\s\S]{0,200}?for update/);
  });

  test('every level records where it came from', () => {
    assert.match(sql, /alter table projects\.modules\s+add column if not exists requirement_version_id/);
    assert.match(sql, /requirement_version_id uuid references crm\.requirement_versions/);
    assert.match(sql, /add column if not exists requirement_version_id uuid/);
  });

  test('a version breaks down once, and the second attempt answers', () => {
    assert.match(sql, /modules_requirement_version_key/);
    assert.match(sql, /'already_broken_down'/);
  });

  test('an existing module of the same name is adopted, not duplicated', () => {
    // The name is the identity a person uses; two "Ordering" modules would be
    // worse than one shared between a hand-made plan and a generated one.
    assert.match(sql, /on conflict \(project_id, name\) do nothing/);
    assert.match(sql, /if v_module_id is null then[\s\S]{0,200}?select m\.id into v_module_id/);
  });

  test('a hand-made module, feature or task stays legal', () => {
    // The provenance column says where a row came from, not that it must have
    // come from somewhere. Work exists that no requirement asked for.
    assert.ok(
      !/requirement_version_id uuid not null/.test(sql),
      'provenance was made mandatory, which would forbid hand-made work',
    );
  });

  test('the plan is not visible to a client', () => {
    // A client sees deliverables and the portal. The breakdown names internal
    // assignment and estimates.
    const policy = sql.slice(sql.indexOf('policy features_select'));
    assert.match(policy.slice(0, 300), /core\.is_internal\(\)/);
    assert.ok(!/is_client/.test(policy.slice(0, 300)));
  });
});

describe('E. the question provenance exists to answer', () => {
  test('coverage is side-effect free, so a screen can show it', () => {
    const fn = sql.slice(sql.indexOf('function projects.requirement_coverage'));
    assert.match(fn.slice(0, 400), /language sql\s+stable/);
  });

  test('it counts only accepted versions', () => {
    const fn = sql.slice(sql.indexOf('function projects.requirement_coverage'));
    assert.match(fn, /rv\.status = 'accepted'/);
  });

  test('and reports finished work as well as planned', () => {
    const fn = sql.slice(sql.indexOf('function projects.requirement_coverage'));
    assert.match(fn, /t\.status = 'done'/);
  });
});
