/**
 * Take a region of a source file, and stop at its end.
 *
 * This exists because the same mistake was made 189 times, and bit four times
 * in a single session before anybody counted them.
 *
 * The shape was `const block = SOURCE.slice(SOURCE.indexOf('marker'))`. It is
 * **correct when written** — the marker names a function, a form, a section,
 * and at that moment there is nothing below it worth excluding. It becomes
 * wrong the day the next unit appends a function, a form or a section to the
 * same file: whatever is appended silently joins the region, changing every
 * count taken over it and every `doesNotMatch` asserted about it.
 *
 * **The dangerous direction is the silent one.** Four of these surfaced as
 * failing tests, which is the lucky case — a count went from three to four, a
 * `<select>` appended later failed a "no picker" assertion. The unlucky case
 * is an absence assertion that the swallowed code happens to satisfy: the test
 * stays green while the region it names no longer holds the property. Nothing
 * distinguishes the two from outside.
 *
 * ── what this does ────────────────────────────────────────────────────
 *
 * `region(SOURCE, 'marker')` returns the text from `marker` to the next
 * structural boundary — the next top-level declaration, block or SQL
 * statement. `region(SOURCE, 'marker', 'until')` uses the end the caller
 * names, for a region whose shape the boundaries below do not describe.
 *
 * Three things are asserted rather than assumed, because each of them has
 * silently restored the old behaviour at least once:
 *
 *   • the start marker EXISTS — `indexOf` returning −1 makes `slice(-1)` the
 *     last character of the file, and an assertion over one character passes
 *     an absence check every time;
 *   • the region is NOT EMPTY;
 *   • the region is SHORTER than the whole file, so a region that swallowed
 *     everything is a failure rather than a pass.
 *
 * A named `until` that is not found is a failure too. Silently falling back to
 * the end of the file is exactly the behaviour this module exists to remove,
 * and it is the failure mode a reader is least likely to suspect.
 */

/**
 * Where a region ends when the caller does not say.
 *
 * Deliberately structural and deliberately short: each entry begins at a line
 * start, so a boundary word inside a string or an expression does not cut a
 * region in half. TypeScript and SQL are both here because the sources these
 * tests read are both.
 */
const BOUNDARIES = [
  '\nexport ',
  '\nconst ',
  '\nlet ',
  '\nfunction ',
  '\nasync function ',
  '\nclass ',
  '\ndescribe(',
  '\ntest(',
  '\ncreate or replace function',
  '\ncreate function',
  '\ncreate table',
  '\ncreate index',
  '\ncreate policy',
  '\ncreate trigger',
  '\ncomment on ',
  '\ngrant ',
  '\nrevoke ',
  '\nalter table',
  '\ninsert into',
  '\nnotify ',
  '\ndo $$',
];

/**
 * "To the end of the file, and I have read it."
 *
 * A region genuinely can be the last one in a file — the final handler, the
 * final function in a migration. Passing this says the author checked that,
 * rather than leaving `slice` open by habit, and it is greppable: every use is
 * a place to look when the file it reads grows a new section below.
 *
 * It is not a licence. If anything is appended below such a region, the region
 * swallows it exactly as before — the difference is that somebody chose it.
 */
export const TO_END = '\u0000region:to-the-end\u0000';

export function region(source: string, start: string, until?: string): string {
  const i = source.indexOf(start);
  if (i < 0) throw new Error(`region: start marker not found — ${JSON.stringify(start)}`);

  const from = i + start.length;
  let end = -1;

  if (until === TO_END) {
    end = -1;
  } else if (until !== undefined) {
    end = source.indexOf(until, from);
    if (end < 0) {
      throw new Error(
        `region: end marker not found after ${JSON.stringify(start)} — ${JSON.stringify(until)}. ` +
          'Falling back to the end of the file is the behaviour this helper exists to remove.',
      );
    }
  } else {
    for (const b of BOUNDARIES) {
      const j = source.indexOf(b, from);
      if (j >= 0 && (end < 0 || j < end)) end = j;
    }
  }

  const cut = source.slice(i, end >= 0 ? end : undefined);
  if (cut.length === 0) throw new Error(`region: empty region at ${JSON.stringify(start)}`);
  if (cut.length >= source.length) {
    throw new Error(`region: ${JSON.stringify(start)} did not bound anything — the region is the whole file`);
  }
  return cut;
}
