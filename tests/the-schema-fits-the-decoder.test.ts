import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Every wire schema fits the decoder's subset — G-164.
 *
 * Found by the OWNER, live, on the first formula-priced quotation: the
 * `priceRupees` bounds emitted `minimum`/`maximum`, Anthropic's constrained
 * decoder refuses those on integers, and the scope job died at the model
 * call — *"For 'integer' type, properties maximum, minimum are not
 * supported."* The local model stub validates nothing, so every verification
 * run had waved the schema through: the wire shape was a fact no test held.
 *
 * These tests hold it now, for the WHOLE fleet: every `*JsonSchema` the
 * runner hands to the provider is walked for keywords the decoder refuses,
 * with the same keyword-vs-property-name discipline `decoderSafeSchema`
 * itself keeps. The roster is written by hand and then CHECKED against the
 * runner's source (the PR #277 pattern), so a new workflow's schema cannot
 * join the fleet without joining this walk.
 */

import {
  checkInBriefJsonSchema,
  clientReplyJsonSchema,
  followUpDraftJsonSchema,
  imageReadingJsonSchema,
  messageIntentJsonSchema,
  qualificationCoverageJsonSchema,
  requirementJsonSchema,
  conversationSummaryJsonSchema,
} from '../src/modules/crm/schema.ts';
import { testPlanJsonSchema } from '../src/modules/qa/schema.ts';
import { objectionReadingJsonSchema, quotationScopeJsonSchema } from '../src/modules/sales/schema.ts';
import {
  breakdownJsonSchema,
  handoverPackageJsonSchema,
  maintenanceTriageJsonSchema,
  screenInventoryJsonSchema,
} from '../src/modules/projects/schema.ts';
import { decoderSafeSchema } from '../src/lib/ai/schema.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

/** The provider's refusals, verbatim, plus their unrefused siblings. */
const FORBIDDEN = [
  '$schema',
  'maxItems',
  'minItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
];

/** Walks schema positions only — a property NAMED `minimum` is legal. */
function forbiddenKeywords(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => forbiddenKeywords(n, `${path}[${i}]`));
  if (typeof node !== 'object' || node === null) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (FORBIDDEN.includes(key)) found.push(`${path}.${key}`);
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        found.push(...forbiddenKeywords(sub, `${path}.${key}.${name}`));
      }
      continue;
    }
    if (['items', 'additionalProperties', 'not', 'anyOf', 'allOf', 'oneOf', 'prefixItems'].includes(key)) {
      found.push(...forbiddenKeywords(value, `${path}.${key}`));
    }
  }
  return found;
}

const FLEET: Record<string, () => unknown> = {
  checkInBriefJsonSchema,
  clientReplyJsonSchema,
  followUpDraftJsonSchema,
  imageReadingJsonSchema,
  messageIntentJsonSchema,
  qualificationCoverageJsonSchema,
  requirementJsonSchema,
  testPlanJsonSchema,
  objectionReadingJsonSchema,
  quotationScopeJsonSchema,
  breakdownJsonSchema,
  handoverPackageJsonSchema,
  maintenanceTriageJsonSchema,
  screenInventoryJsonSchema,
  // G-198 — the rolling conversation summary. One field, and it walks the
  // fleet like every other wired schema: a shape the decoder refuses is a
  // model call that fails in production and nowhere else.
  conversationSummaryJsonSchema,
};

describe('A. the fleet walk', () => {
  test('the hand-written roster matches what the runner actually wires', () => {
    const runner = read('app/api/jobs/run/workflows.ts');
    const wired = new Set(
      [...runner.matchAll(/jsonSchema: (\w+JsonSchema)/g)].map((m) => m[1] ?? ''),
    );
    assert.ok(wired.size > 0, 'the runner wires no schemas — the scan is broken');
    assert.deepEqual(
      [...wired].sort(),
      Object.keys(FLEET).sort(),
      'a workflow schema joined or left the fleet without joining this walk',
    );
  });

  test('no wire schema carries a keyword the decoder refuses', () => {
    for (const [name, fn] of Object.entries(FLEET)) {
      const found = forbiddenKeywords(fn());
      assert.deepEqual(found, [], `${name} would be refused at the model call: ${found.join(', ')}`);
    }
  });
});

describe('B. the stripper itself', () => {
  test('numeric bounds are stripped as keywords', () => {
    const cleaned = decoderSafeSchema({
      type: 'object',
      properties: {
        priceRupees: { type: 'integer', minimum: 0, maximum: 2_500_000, multipleOf: 1 },
      },
    }) as { properties: { priceRupees: Record<string, unknown> } };
    assert.deepEqual(cleaned.properties.priceRupees, { type: 'integer' });
  });

  test('…but a property NAMED after a keyword survives — the walk’s whole reason', () => {
    const cleaned = decoderSafeSchema({
      type: 'object',
      properties: { minimum: { type: 'string' }, maximum: { type: 'string' } },
    }) as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(cleaned.properties).sort(), ['maximum', 'minimum']);
  });

  test('the live quotation schema comes out clean end to end', () => {
    // The exact schema whose bounds killed the job in production: its
    // exported form must already be decoder-safe, bounds enforced by Zod on
    // the way back in instead.
    assert.deepEqual(forbiddenKeywords(quotationScopeJsonSchema()), []);
    const item = (quotationScopeJsonSchema() as { properties: { items: { items: { properties: Record<string, unknown> } } } })
      .properties.items.items.properties;
    assert.ok('priceRupees' in item, 'the price field itself must survive the strip');
  });
});
