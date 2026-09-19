import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The spend has a surface — Master §6, §8; Designer §23; G-298.
 *
 * G-297 made the spend attributable and left `ai.project_usage_by_phase` with
 * no caller, and the Admin Panel's cost section saying *"no design generation
 * has run"* as a **hard-coded sentence** rather than a read.
 *
 * The decision worth defending here is what the table refuses to hide: **the
 * unattributed line is kept.** A report showing only the phases it can name
 * would understate the total, and understating spend is the direction that
 * matters — somebody would believe the project cost less than it did.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QUERIES = read('src/modules/projects/queries.ts');
const PAGE = read('app/(internal)/projects/[projectId]/design/page.tsx');
const TYPES = read('src/lib/db/types.ts');
const USAGE = read('supabase/migrations/20260920020000_what_phase_three_cost.sql');

const bounded = (source: string, start: string, next: string) => {
  const i = source.indexOf(start);
  assert.ok(i > 0, `${start} does not exist`);
  const j = source.indexOf(next, i + 1);
  const cut = source.slice(i, j > 0 ? j : undefined);
  assert.ok(cut.length > 0 && cut.length < source.length, `${start} is not bounded`);
  return cut;
};
const reader = bounded(QUERIES, 'export async function readProjectSpend', '\nexport ');

describe('A. the door G-297 built has a caller', () => {
  test('the reader calls it', () => {
    assert.match(reader, /\.rpc\('project_usage_by_phase', \{ p_project_id: projectId \}\)/);
  });

  test('and the page reads it instead of asserting a sentence', () => {
    // Before this, "no design generation has run" was hard-coded — true, and
    // true only until it wasn't.
    assert.match(PAGE, /const spend = await readProjectSpend\(projectId\);/);
    assert.doesNotMatch(PAGE, /No design generation has run on this deployment, so there is nothing to account for/);
  });

  test('the section is still named when there is nothing to show', () => {
    // §8 asks for cost "where available". A section that vanished would read
    // as an oversight rather than a state.
    assert.match(PAGE, /title="Cost and usage"/);
    assert.match(PAGE, /No agent run has been attributed to this project yet\./);
  });
});

describe('B. the unattributed line is kept, not dropped', () => {
  test('a null phase renders as its own row', () => {
    assert.match(PAGE, /row\.phase === null \? \(\s*\n\s*<span className="text-muted">phase not knowable<\/span>/);
    assert.match(PAGE, /key=\{row\.phase \?\? 'unattributed'\}/);
  });

  test('and the reason it is not filtered out is recorded', () => {
    // Understating spend is the direction that matters.
    assert.match(QUERIES, /understating spend\s*\n?\s*\*?\s*is the direction that matters/);
    assert.match(PAGE, /would understate the total, and\s*\n?\s*understating spend is the direction that matters/);
  });

  test('nothing filters the rows before rendering them', () => {
    assert.doesNotMatch(PAGE, /spend\.filter\(/);
  });

  test('and the footnote explains why a phase can be unknown', () => {
    assert.match(PAGE, /Phase is recorded only\s*\n?\s*where a run’s subject belongs to exactly one phase — guessing would make this table\s*\n?\s*confidently wrong\./);
  });

  test('the report itself still orders nulls last rather than dropping them', () => {
    // The positive twin: if the SQL started filtering, this surface would
    // faithfully render an understated total.
    assert.match(USAGE, /group by r\.phase\s*\n\s*order by r\.phase nulls last;/);
  });
});

describe('C. a failed read is not "nothing was spent"', () => {
  test('the reader refuses rather than returning an empty list', () => {
    // "Nothing has been spent" and "the database did not answer" are
    // different statements, and only one of them is about money.
    assert.match(reader, /if \(error\) unreadable\('readProjectSpend', error\)/);
    assert.match(QUERIES, /only one of them is about money/);
  });

  test('and every figure is coerced from what came back, not assumed', () => {
    assert.equal((reader.match(/Number\(r\.\w+ \?\? 0\)/g) ?? []).length, 4);
  });
});

describe('D. the generated type matches the function it describes', () => {
  test('the signature is present', () => {
    assert.match(TYPES, /project_usage_by_phase: \{\s*\n\s*Args: \{ p_project_id: string \}/);
  });

  test('and phase is typed nullable, because it is', () => {
    // Written by hand — `db:types` needs Docker. Typing it `number` would be a
    // lie in a file whose whole purpose is describing the database.
    assert.match(TYPES, /Nullable: a run attributed to this project whose phase is not\s*\n\s*\/\/ knowable comes back as its own row\.\s*\n\s*phase: number \| null/);
  });

  test('the columns match what the function returns', () => {
    // Checked against the live signature on a scratch Postgres:
    // TABLE(phase smallint, runs bigint, input_tokens bigint,
    //       output_tokens bigint, cost_minor bigint)
    // BOUNDED to this function's block. `cost_minor: number` also appears on
    // the agent_runs Row, so an unscoped match found a different copy and the
    // control did not bite.
    const block = bounded(TYPES, '      project_usage_by_phase: {', '\n      recall: {');
    for (const col of ['cost_minor', 'input_tokens', 'output_tokens', 'phase', 'runs']) {
      assert.match(block, new RegExp(`^\\s+${col}: number`, 'm'), `${col} is not typed`);
    }
    assert.match(USAGE, /returns table \(\s*\n[\s\S]{0,400}?phase\s+smallint,[\s\S]{0,300}?cost_minor\s+bigint\s*\n\)/);
  });
});

describe('E. money is rendered the way this system renders money', () => {
  test('minor units, divided once at the edge', () => {
    assert.match(PAGE, /₹\{\(row\.costMinor \/ 100\)\.toFixed\(2\)\}/);
    assert.match(PAGE, /Minor units, like every other money column in this system\./);
  });

  test('and the reader carries minor units, never a float', () => {
    assert.match(reader, /costMinor: Number\(r\.cost_minor \?\? 0\)/);
    assert.doesNotMatch(reader, /\/ 100/);
  });
});
