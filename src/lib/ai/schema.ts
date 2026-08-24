/**
 * The keywords a constrained decoder refuses, and the walk that removes them.
 *
 * Lived in `modules/crm/schema.ts` while requirement extraction was the only
 * structured-output call in the system. It was never about requirements: it is
 * about what the DECODER can express, so it belongs beside the provider port
 * rather than beside one caller's payload.
 *
 * Moved when a second agent needed it, and moving it was not optional —
 * a module's own `schema.ts` is closed to other modules by ARCHITECTURE.md §3.2, so
 * `projects` could not have imported it from `crm` at all. The rule pointed at
 * the right home.
 */

/**
 * Keywords a constrained decoder refuses, stripped on the way out.
 *
 * Not guessed — read from the provider's own refusal, once the error carried
 * one: *"output_config.format.schema: For 'array' type, property 'maxItems' is
 * not supported"*. Constrained decoding builds a grammar from the schema, and
 * an array-length bound is not expressible in one; the decoder rejects the
 * whole request rather than ignoring the keyword. `minItems` is not in the
 * refusal because nothing here emits it — it is listed for the same reason and
 * so the next `.min()` on an array does not repeat this outage.
 *
 * `$schema` is the dialect identifier Zod stamps at the root: right for a
 * document a JSON Schema library validates, pointless for one handed to a
 * decoder that implements a defined subset. It carries no constraint.
 *
 * The numeric bounds joined the list the same way the array bounds did — from
 * the provider's own refusal, this time found by the OWNER, live, on the
 * first formula-priced quotation (G-164): *"output_config.format.schema: For
 * 'integer' type, properties maximum, minimum are not supported"*. The
 * `priceRupees` field's `.min(0).max(2_500_000)` emitted exactly those, the
 * scope job died at the model call, and the local model stub — which
 * validates nothing — had waved the schema through every verification run.
 * The exclusive variants and `multipleOf` are listed unrefused, for the same
 * reason `minItems` was: the same grammar cannot express them, and the next
 * `.positive()` or `.step()` must not repeat this outage. Nothing is lost by
 * stripping: Zod's own `safeParse` enforces the real bounds on the way back
 * in, and the prompt carries them in prose on the way out.
 */
const UNSUPPORTED_BY_DECODER = [
  '$schema',
  'maxItems',
  'minItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
] as const;

/**
 * Removes those keywords wherever they appear as schema *keywords* — never as
 * a property *name*.
 *
 * The distinction is the whole reason this walks the document instead of
 * deleting by key: `properties` is a map of user-chosen names to schemas, so a
 * field legitimately called `maxItems` lives there and must survive. Recursion
 * therefore follows the places a schema can appear and nowhere else.
 *
 * Exported because that distinction is the part worth testing directly, and
 * because it is not specific to requirements: any schema handed to constrained
 * decoding needs the same treatment.
 */
export function decoderSafeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(decoderSafeSchema);
  if (typeof node !== 'object' || node === null) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((UNSUPPORTED_BY_DECODER as readonly string[]).includes(key)) continue;

    // A map of names to schemas: recurse into the values, never the keys.
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      const inner = value as Record<string, unknown>;
      out[key] = Object.fromEntries(
        Object.entries(inner).map(([name, sub]) => [name, decoderSafeSchema(sub)]),
      );
      continue;
    }

    // A schema, or a list of them.
    if (key === 'items' || key === 'additionalProperties' || key === 'not') {
      out[key] = decoderSafeSchema(value);
      continue;
    }
    if (key === 'anyOf' || key === 'allOf' || key === 'oneOf' || key === 'prefixItems') {
      out[key] = Array.isArray(value) ? value.map(decoderSafeSchema) : decoderSafeSchema(value);
      continue;
    }

    // Everything else is data: `required` is a list of names, `enum` a list of
    // values. Copied through untouched.
    out[key] = value;
  }
  return out;
}

/**
 * JSON Schema handed to the provider for constrained decoding. Derived from
 * the Zod schema so the two cannot drift.
 *
 * **What is lost, stated rather than left to be found:** the `.max(50)` on the
 * three arrays no longer reaches the model, so nothing stops it proposing a
 * fifty-first scope item. `requirementPayloadSchema` still refuses one —
 * ARCHITECTURE.md §6.6 makes Zod, not the provider, the thing that decides
 * whether model output is admissible — so the bound holds; it is enforced
 * after the call instead of during it, and an over-long answer costs an
 * extraction rather than being silently truncated. That is the honest trade
 * against sending a schema the decoder refuses outright, which is what made
 * every extraction fail.
 */
