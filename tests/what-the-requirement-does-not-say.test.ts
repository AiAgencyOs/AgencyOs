import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * What the requirement does not say — Doc 09 §11, closing a granular gap.
 *
 * §11 names seven things a requirement extraction should track; the payload
 * only ever had four (summary, scopeItems, constraints, openQuestions). Four
 * distinctions the spec names were structurally absent from the data model:
 * confirmed scope vs. an assumption filling a silence, a nice-to-have the
 * client has not committed to, an explicit exclusion (not simply something
 * never mentioned), and a design reference the client pointed to. This adds
 * all four as optional, defaulted fields — no migration, since payload is a
 * generic jsonb column — and wires the extraction prompt to actually ask for
 * them, so the schema addition is not left unpopulated.
 */

describe('A. the schema carries all four, and stays optional for old rows', () => {
  test('every field §11 names is on the schema', async () => {
    const { requirementPayloadSchema } = await import('../src/modules/crm/schema.ts');
    const shape = requirementPayloadSchema.shape;

    assert.ok('assumptions' in shape, 'assumptions is missing');
    assert.ok('niceToHaves' in shape, 'niceToHaves is missing');
    assert.ok('exclusions' in shape, 'exclusions is missing');
    assert.ok('designReferences' in shape, 'designReferences is missing');
  });

  test('a requirement_versions row written before this field existed still parses', async () => {
    const { requirementPayloadSchema } = await import('../src/modules/crm/schema.ts');

    // The exact shape a pre-existing stored payload has: none of the four new
    // keys at all, not even as empty arrays.
    const historical = {
      summary: 'A booking site for a salon',
      scopeItems: [{ title: 'Booking calendar' }],
      constraints: [],
      openQuestions: [],
    };

    const result = requirementPayloadSchema.safeParse(historical);
    assert.equal(result.success, true, 'a historical payload without the new keys must still parse');
    if (result.success) {
      assert.deepEqual(result.data.assumptions, []);
      assert.deepEqual(result.data.niceToHaves, []);
      assert.deepEqual(result.data.exclusions, []);
      assert.deepEqual(result.data.designReferences, []);
    }
  });

  test('a fresh extraction can populate all four', async () => {
    const { requirementPayloadSchema } = await import('../src/modules/crm/schema.ts');

    const fresh = {
      summary: 'A booking site for a salon',
      scopeItems: [{ title: 'Booking calendar' }],
      constraints: [],
      openQuestions: [],
      assumptions: ['No multi-location support needed'],
      niceToHaves: ['A loyalty points system'],
      exclusions: ['No native mobile app'],
      designReferences: ['https://example.com/inspiration'],
    };

    const result = requirementPayloadSchema.safeParse(fresh);
    assert.equal(result.success, true);
  });
});

describe('B. the extraction prompt actually asks for the distinction, not just the schema', () => {
  test('the prompt tells the model assumptions are not scopeItems', async () => {
    const workflows = await import('fs').then((fs) =>
      fs.readFileSync(new URL('../app/api/jobs/run/workflows.ts', import.meta.url), 'utf8'),
    );

    assert.match(workflows, /assumptions are things you are filling in because the client did not say/);
    assert.match(workflows, /keep these out of scopeItems/);
  });

  test('the prompt distinguishes an exclusion from something simply unmentioned', () => {
    // Re-read here rather than reuse the import above, so this test fails on
    // its own if the specific sentence is edited or removed.
    return import('fs').then((fs) => {
      const workflows = fs.readFileSync(new URL('../app/api/jobs/run/workflows.ts', import.meta.url), 'utf8');
      assert.match(workflows, /not simply things never mentioned/);
    });
  });
});

describe('C. the lead page renders what the schema now carries, not just what it always has', () => {
  test('the requirement card shows all four new fields, not only scopeItems and openQuestions', async () => {
    const fs = await import('fs');
    const page = fs.readFileSync(
      new URL('../app/(internal)/leads/[leadId]/page.tsx', import.meta.url),
      'utf8',
    );

    assert.match(page, /parsed\.data\.assumptions\.length/);
    assert.match(page, /parsed\.data\.niceToHaves\.length/);
    assert.match(page, /parsed\.data\.exclusions\.length/);
    assert.match(page, /parsed\.data\.designReferences\.length/);
  });
});
