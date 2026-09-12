import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * A function that ends halfway — a defect found while writing G-228, and the
 * guard that would have caught it.
 *
 * ── what happened ─────────────────────────────────────────────────────────
 *
 * G-230 carried `core.set_organization_setting` forward, which this repository
 * does deliberately: regenerating from an older copy is how a function
 * silently reverts, the lesson G-126 and D16 both paid for. The carry-forward
 * was performed with a shell command whose double-quoted argument contained
 * `$$` — and the shell substituted its own **process id** before the text ever
 * reached the file.
 *
 * The result was a `$$;` in the MIDDLE of the function body. Postgres would
 * have ended the function there and failed on the orphaned SQL after it.
 *
 * ── why nothing caught it ─────────────────────────────────────────────────
 *
 * Every test of that migration matched text with a regular expression, and all
 * of the text was still present — just in two pieces, with a terminator
 * between them. `npm run check` was green. The failure was waiting for
 * `supabase db reset` in CI, because no Postgres was reachable locally.
 *
 * A regex over source can only say a string is present. It cannot say the file
 * is a program. An odd number of `$$` markers says a body was left open or
 * terminated early, which is the whole of that failure and is nearly free to
 * check — for every migration, including the ones nobody is editing.
 *
 * Uses `sqlCode`, which is the repository's own SQL stripper, rather than a
 * second opinion written here: G-188 already paid for a hand-rolled stripper
 * that mangled a string literal, and a guard whose scanner is wrong reports on
 * files that are fine.
 */

const MIGRATIONS = fileURLToPath(new URL('../supabase/migrations', import.meta.url));
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

const markers = (name: string) =>
  (sqlCode(readFileSync(`${MIGRATIONS}/${name}`, 'utf8')).match(/\$\$/g) ?? []).length;

describe('every migration is a program, not a pile of matching strings', () => {
  test(`the scan found migrations to check (${files.length})`, () => {
    // The scan breaking silently is the one way this file becomes decorative —
    // the species `a-pin-that-cannot-fail` exists to refuse.
    assert.ok(files.length > 200, `only ${files.length} migrations found — the scan broke`);
  });

  test('at least one of them actually contains a function body', () => {
    // Guards the guard: if `sqlCode` ever stripped `$$` along with comments,
    // every count would be zero and every file would pass as trivially even.
    assert.ok(
      files.some((f) => markers(f) > 0),
      'no migration contains a dollar-quoted body — the stripper ate them',
    );
  });

  for (const file of files) {
    test(`${file} closes every dollar-quoted body it opens`, () => {
      const count = markers(file);

      assert.equal(
        count % 2,
        0,
        `${count} \`$$\` markers. An odd count means a function body is left open or ` +
          'terminated early — and the text still matches every regex written about it.',
      );
    });
  }
});
