/**
 * Reading JSON out of what a model said.
 *
 * A model asked for JSON is not always a model that returned only JSON: a gateway that ignores the output schema, or a model that
 * decided to be helpful, wraps the object in a markdown fence or adds a sentence before it. Found live against a real model: the
 * Project Planning Agent failed every attempt with "not valid JSON" while the answer was perfectly good JSON inside ```json fences.
 *
 * Tolerance goes exactly this far and no further:
 *   1. the text IS JSON,
 *   2. the text is one fenced block of JSON,
 *   3. the text has ONE balanced top-level object or array in it (prose around it is ignored).
 * Anything else - two separate objects, an unterminated object, no JSON at all - is a failure, never a guess. The caller still
 * validates the result against its schema; a parsed value is not an accepted one.
 */

export type ModelJson = { ok: true; json: unknown } | { ok: false };

const FENCE = /^\s*```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?\s*```\s*$/;

function tryParse(text: string): ModelJson {
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The single balanced `{...}` or `[...]` in the text, honouring strings and escapes; null when there is none or more than one. */
function onlyBalancedValue(text: string): string | null {
  let found: string | null = null;
  let i = 0;
  while (i < text.length) {
    const open = text[i];
    if (open !== '{' && open !== '[') {
      i += 1;
      continue;
    }
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) return null; // unterminated
    if (found !== null) return null; // a second value: ambiguous, so not a guess
    found = text.slice(i, end + 1);
    i = end + 1;
  }
  return found;
}

export function parseModelJson(text: string): ModelJson {
  const strict = tryParse(text);
  if (strict.ok) return strict;
  const fenced = FENCE.exec(text);
  if (fenced?.[1]) {
    const inner = tryParse(fenced[1]);
    if (inner.ok) return inner;
  }
  const only = onlyBalancedValue(text);
  return only === null ? { ok: false } : tryParse(only);
}
