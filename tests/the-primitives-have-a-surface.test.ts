import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The primitives have a surface — Designer §4.5, §19, §23; G-296.
 *
 * G-295's two doors, given a caller in the unit that follows them.
 *
 * One thing here is load-bearing rather than cosmetic: **the fields carry the
 * current values**. The door treats a null argument as *unchanged*, so a new
 * version inherits the last finalized one — and a form showing empty boxes
 * would present a set that exists as though it did not, and invite somebody to
 * retype what is already there.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE = read('src/modules/projects/design.ts');
const ACTIONS = read('src/modules/projects/actions.ts');
const QUERIES = read('src/modules/projects/queries.ts');
const FORMS = read('app/(internal)/projects/[projectId]/design/design-forms.tsx');
const PAGE = read('app/(internal)/projects/[projectId]/design/page.tsx');
const TOKENS = read('supabase/migrations/20260920000000_the_tokens_phase_four_inherits.sql');

const bounded = (source: string, start: string, next: string) => {
  const i = source.indexOf(start);
  assert.ok(i > 0, `${start} does not exist`);
  const j = source.indexOf(next, i + 1);
  const cut = source.slice(i, j > 0 ? j : undefined);
  assert.ok(cut.length > 0 && cut.length < source.length, `${start} is not bounded`);
  return cut;
};

const recordSvc = bounded(SERVICE, 'export async function recordDesignTokenSet', '\nexport async function ');
const finalSvc = bounded(SERVICE, 'export async function finalizeDesignTokenSet', '\nexport async function ');
const reader = bounded(QUERIES, 'export async function readTokenSets', '\nexport ');
const form = bounded(FORMS, 'export function TokenSetForm', '\nexport function ');

describe('A. blank means unchanged, all the way down', () => {
  test('the action passes `undefined` rather than an empty string', () => {
    // The door nullifies blanks anyway, so `''` would be harmless — but going
    // through `undefined` keeps the intent readable at every layer.
    assert.match(ACTIONS, /const untouched = \(v: FormDataEntryValue \| null\) => String\(v \?\? ''\)\.trim\(\) \|\| undefined;/);
  });

  test('the service passes null to the door for anything absent', () => {
    assert.match(recordSvc, /p_navigation_style: input\.navigationStyle \?\? null,/);
  });

  test('and the door reads null as "leave it as it was"', () => {
    // The positive twin. If the door stopped carrying forward, this whole
    // surface would silently clear on every edit.
    assert.match(TOKENS, /navigation_style\s+= coalesce\(nullif\(btrim\(coalesce\(p_navigation_style, ''\)\), ''\), navigation_style\)/);
  });

  test('the form shows the current values, which is what makes that visible', () => {
    assert.match(form, /defaultValue=\{current\?\.fontFamilyHeading \?\? ''\}/);
    assert.match(form, /defaultValue=\{\(values\[s\.name\] as string \| null\) \?\? ''\}/);
    assert.match(FORMS, /a form showing empty boxes|A form that presented empty boxes/);
  });

  test('and the person is told what blank means', () => {
    assert.match(FORMS, /Anything left blank is unchanged\./);
    assert.match(ACTIONS, /Recorded\. Anything you left blank is unchanged\./);
  });
});

describe('B. a number that is not a number is refused, not silently dropped', () => {
  test('a non-numeric entry becomes NaN rather than undefined', () => {
    // `undefined` would mean "unchanged": the door would accept the call and
    // change nothing, and the person would believe they had set it.
    assert.match(ACTIONS, /return Number\.isFinite\(n\) \? n : Number\.NaN;/);
    assert.match(ACTIONS, /person would believe they had set it/);
  });

  test('and the action refuses before calling the door', () => {
    assert.match(ACTIONS, /if \(Number\.isNaN\(ratio\) \|\| Number\.isNaN\(spacing\)\) \{\s*\n\s*return \{ status: 'error'/);
    assert.ok(
      ACTIONS.indexOf('Number.isNaN(ratio)') < ACTIONS.indexOf('await recordDesignTokenSet({'),
    );
  });

  test('an empty box is still "unchanged", not zero', () => {
    assert.match(ACTIONS, /if \(raw === ''\) return undefined;/);
  });
});

describe('C. a final set is shown, not edited', () => {
  test('the save button is disabled and says what it would do next', () => {
    assert.match(form, /disabled=\{pending \|\| isFinal\}/);
    assert.match(form, /\{isFinal \? 'Start the next version' : 'Save the primitives'\}/);
  });

  test('finalizing is offered only while there is something to finalize', () => {
    assert.match(form, /\{current && !isFinal \? \(/);
  });

  test('and the door is what actually refuses an edit', () => {
    // The positive twin: the form's `disabled` is a courtesy, the trigger is
    // the control.
    assert.match(TOKENS, /if old\.status = 'final' then\s*\n\s*raise exception/);
  });

  test('`already_final` is a success, because the row is in the asked-for state', () => {
    assert.match(finalSvc, /case 'already_final':[\s\S]{0,200}?return ok\(\{ tokenSetId: row\?\.token_set_id \?\? null, alreadyFinal: true \}\)/);
    assert.match(ACTIONS, /These were already final\./);
  });
});

describe('D. the reader answers with the current set per direction', () => {
  test('newest first, and the first seen per theme is the current one', () => {
    assert.match(reader, /\.order\('version', \{ ascending: false \}\)/);
    assert.match(reader, /if \(newest\.has\(theme\)\) continue;/);
  });

  test('a failed read refuses rather than presenting blank boxes as the state', () => {
    // The specific harm: empty defaults would look like the current values,
    // and the first save would appear to have dropped everything.
    assert.match(reader, /if \(error\) unreadable\('readTokenSets', error\)/);
    assert.match(QUERIES, /the first edit would look like it dropped everything/);
  });

  test('the numeric ratio is carried as a string, so it renders as stored', () => {
    // Postgres numeric(4,3) comes back as a string; coercing it through Number
    // would render 1.250 as 1.25 and make an untouched field look edited.
    assert.match(reader, /typeScaleRatio: r\.type_scale_ratio === null \|\| r\.type_scale_ratio === undefined/);
  });
});

describe('E. only §4.5’s vocabulary is offered', () => {
  test('every select offers exactly what the column accepts', () => {
    // SELECTS is defined above the component, so this reads FORMS rather than
    // the bounded component slice — and drops the leading key, which the same
    // pattern matches.
    const offered = (name: string) => {
      const i = FORMS.indexOf(`['${name}'`);
      assert.ok(i > 0, `${name} has no picker`);
      const block = FORMS.slice(i, FORMS.indexOf(']],', i));
      return [...block.matchAll(/\['(\w+)', '/g)].map((m) => m[1] ?? '').filter((k) => k !== name);
    };
    assert.deepEqual(offered('radiusStyle').sort(), ['pill', 'rounded', 'sharp', 'soft']);
    assert.deepEqual(offered('navigationStyle').sort(), ['bottom_tabs', 'hybrid', 'side_nav', 'top_bar']);
  });

  test('and the columns still accept exactly those', () => {
    assert.match(TOKENS, /radius_style\s+text check \(radius_style is null or radius_style in \('sharp', 'soft', 'rounded', 'pill'\)\)/);
    assert.match(TOKENS, /navigation_style\s+text check \(navigation_style is null or navigation_style in \('top_bar', 'side_nav', 'bottom_tabs', 'hybrid'\)\)/);
  });

  test('there is no free-form field for a design system to arrive through', () => {
    // §4.5's boundary, at the surface: no textarea that could take a token
    // dump, and no field the schema has no column for.
    assert.doesNotMatch(form, /<textarea/);
    assert.doesNotMatch(form, /name="extras"|name="tokens"|name="customCss"/);
  });

  test('and the form says the scope out loud', () => {
    assert.match(FORMS, /Only what Phase 3 needs to communicate the direction\./);
  });
});

describe('F. it is wired, and the door has a caller', () => {
  test('both doors are called', () => {
    assert.match(recordSvc, /\.rpc\('record_design_token_set', \{/);
    assert.match(finalSvc, /\.rpc\('finalize_design_token_set', \{/);
  });

  test('the form is on the page, under the direction it belongs to', () => {
    assert.match(PAGE, /<TokenSetForm\s*\n\s*projectId=\{projectId\}\s*\n\s*themeOptionId=\{t\.id\}/);
    assert.match(PAGE, /current=\{tokenSets\.find\(\(ts\) => ts\.themeOptionId === t\.id\) \?\? null\}/);
  });

  test('and both actions refresh the page the result shows on', () => {
    for (const fn of ['recordDesignTokenSetAction', 'finalizeDesignTokenSetAction']) {
      const block = ACTIONS.slice(ACTIONS.indexOf(`export async function ${fn}`));
      assert.match(block.slice(0, block.indexOf('\n}')), /revalidatePath\(`\/projects\/\$\{projectId\}\/design`\)/);
    }
  });
});
