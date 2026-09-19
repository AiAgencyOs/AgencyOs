import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The samples have a surface — Designer §7, §17, §19; G-293.
 *
 * G-292's door, given a caller in the unit that follows it rather than five
 * units later. The lesson G-291 was opened for, applied on purpose this time.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE = read('src/modules/projects/design.ts');
const QUERIES = read('src/modules/projects/queries.ts');
const FORMS = read('app/(internal)/projects/[projectId]/design/design-forms.tsx');
const PAGE = read('app/(internal)/projects/[projectId]/design/page.tsx');
const SAMPLES = read('supabase/migrations/20260919220000_a_sample_screen_is_a_real_screen.sql');

const bounded = (source: string, start: string, next: string) => {
  const i = source.indexOf(start);
  assert.ok(i > 0, `${start} does not exist`);
  const j = source.indexOf(next, i + 1);
  const cut = source.slice(i, j > 0 ? j : undefined);
  assert.ok(cut.length > 0 && cut.length < source.length, `${start} is not bounded`);
  return cut;
};

const service = bounded(SERVICE, 'export async function recordRepresentativeScreen', '\nexport async function ');
const reader = bounded(QUERIES, 'export async function readSampleScreens', '\nexport ');
const form = bounded(FORMS, 'export function RecordSampleForm', '\nexport function ');

describe('A. the picker offers exactly what the door accepts', () => {
  test('only approved screens are read', () => {
    // §17. A picker showing drafts would make `screen_not_approved` the normal
    // outcome of using it — a form built to fail.
    assert.match(reader, /\.from\('screens'\)[\s\S]{0,200}?\.eq\('status', 'approved'\)/);
  });

  test('and the door refuses anything else, so the two agree', () => {
    assert.match(SAMPLES, /if v_screen\.status <> 'approved' then/);
  });

  test('no approved screen means the form says so rather than offering nothing', () => {
    assert.match(form, /No screen on this project is approved yet, so there is nothing a sample could stand for\./);
  });

  test('every pattern the door accepts is offered, and no other', () => {
    const offered = [...form.matchAll(/<option value="(\w+)"/g)].map((m) => m[1] ?? '').sort();
    assert.deepEqual(offered, ['detail', 'form', 'list', 'navigation', 'primary', 'state']);
  });
});

describe('B. §17’s refusal is explained as the rule working', () => {
  test('an unapproved screen is not reported as the caller’s mistake', () => {
    assert.match(service, /A sample has to stand for a screen somebody signed off — otherwise it is a picture of a screen nobody asked for\./);
  });

  test('redundancy says what a second sample would cost', () => {
    assert.match(service, /A second one costs a render and settles nothing\./);
  });

  test('and a locked direction says why it is closed', () => {
    assert.match(service, /Its samples are the evidence it was judged on/);
  });

  test('every outcome the door can give is handled', () => {
    // The eight-door meta-invariant in the-gates-have-a-surface.test.ts covers
    // this door too; this is the local half, so a reader of this file sees it.
    const start = SAMPLES.indexOf('create or replace function projects.record_representative_screen');
    const body = SAMPLES.slice(start, SAMPLES.indexOf('$$;', start));
    const outcomes = new Set([...body.matchAll(/select '([a-z_]+)'::text/g)].map((m) => m[1] ?? ''));
    outcomes.delete('no_actor');
    outcomes.delete('forbidden');
    const mapped = new Set([...service.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] ?? ''));
    assert.deepEqual([...outcomes].filter((o) => !mapped.has(o)).sort(), []);
  });
});

describe('C. coverage is shown as a report, and refuses nothing', () => {
  test('the unmet list renders beside the samples', () => {
    assert.match(PAGE, /cov && cov\.unmet\.length > 0 \? \(/);
    assert.match(PAGE, /\{cov\.unmet\.map\(\(u\) => \(/);
  });

  test('and nothing on the page is gated on it', () => {
    // §7 hedges both "at least one" rules with "when applicable". A gate would
    // invent a rule the specification softened.
    assert.doesNotMatch(PAGE, /cov\.unmet\.length === 0 \?|!cov\.unmet\.length &&/);
    assert.match(PAGE, /The unmet list\s*\n?\s*\*?\s*is a REPORT/);
  });

  test('a direction with no samples says what that means', () => {
    assert.match(PAGE, /Nothing is sampled yet, so there is nothing to judge this direction on\./);
  });

  test('the coverage read is G-054 guarded like the rest', () => {
    assert.match(reader, /if \(error\) unreadable\('readSampleScreens\.coverage', error\)/);
    assert.match(reader, /if \(samplesError\) unreadable\('readSampleScreens\.samples', samplesError\)/);
    assert.match(reader, /if \(screensError\) unreadable\('readSampleScreens\.approved', screensError\)/);
  });

  test('and an empty list on a failed read would be a claim about somebody’s work', () => {
    assert.match(QUERIES, /a statement about somebody's\s*\n?\s*\/\/ work rather than about the database/);
  });
});

describe('D. the samples show under the direction they demonstrate', () => {
  test('filtered by theme, not shown as one flat list', () => {
    assert.match(PAGE, /samples\.filter\(\(sc\) => sc\.themeOptionId === t\.id\)/);
  });

  test('each says which screen it stands for', () => {
    // §7: "record which final screen definitions each representative sample
    // maps to." A sample rendered without its screen answers nothing.
    assert.match(PAGE, /\{sc\.screenName\}/);
    assert.match(reader, /screens:screen_id\(name, screen_key\)/);
  });

  test('and the decision it was chosen to settle, when there is one', () => {
    assert.match(PAGE, /\{sc\.decisionNote\}/);
  });
});

describe('E. this unit exists because of the last one', () => {
  test('the door has a caller now', () => {
    assert.match(service, /\.rpc\('record_representative_screen', \{/);
    assert.match(PAGE, /<RecordSampleForm/);
  });

  test('and the action refreshes the page the sample appears on', () => {
    assert.match(read('src/modules/projects/actions.ts'), /recordRepresentativeScreenAction[\s\S]{0,900}?revalidatePath\(`\/projects\/\$\{projectId\}\/design`\)/);
  });
});
