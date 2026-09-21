import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The message is ready to copy — PM §10, §11; G-291.
 *
 * G-290 built `render_design_message` and left it with **no caller** — the
 * exact defect the five units before it removed, recreated in the same
 * session. This is its reader and its surface.
 *
 * **The refusals are the useful half.** §10's rule is that a message must not
 * claim what the state does not support, so three of the four steps can be
 * unavailable. *"Not yet — no revised option has been delivered and approved"*
 * is more use to a PM than a missing button.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QUERIES = read('src/modules/projects/queries.ts');
// The message templates section moved to the Final selection route when the
// decision trail split across four pages.
const PAGE = read('app/(internal)/projects/[projectId]/design/final/page.tsx');
const WORDS = read('supabase/migrations/20260920170000_task_one_says_it_is_done.sql');

const reader = (() => {
  const start = QUERIES.indexOf('export async function readDesignMessages');
  assert.ok(start > 0, 'readDesignMessages does not exist');
  const next = QUERIES.indexOf('\nexport ', start + 1);
  return QUERIES.slice(start, next > 0 ? next : undefined);
})();

describe('A. the door G-290 built now has a caller', () => {
  test('the reader calls it', () => {
    assert.match(reader, /\.rpc\('render_design_message', \{/);
  });

  test('and the page calls the reader', () => {
    assert.match(PAGE, /const messages = await readDesignMessages\(phase\.id\);/);
    assert.match(PAGE, /\{messages\.map\(\(m\) => \(/);
  });

  test('every step §11 names, plus the completion step G-309 adds, is asked for', () => {
    const steps = [...QUERIES.matchAll(/\{ key: '(\w+)', label: /g)].map((m) => m[1] ?? '').sort();
    assert.deepEqual(steps, [
      'final_confirmation',
      'phase_three_start',
      'revision_ready',
      'task_one_complete',
      'theme_review',
    ]);
  });

  test('and the five the door accepts are exactly those', () => {
    // If the two lists drifted, a step would render as "this system has no
    // wording for it" while the wording sat in the migration.
    assert.match(WORDS, /check \(step_key in \('phase_three_start', 'theme_review',\s*\n\s*'revision_ready', 'final_confirmation',\s*\n\s*'task_one_complete'\)\)/);
  });
});

describe('B. a step that cannot be sent says why, in a PM’s words', () => {
  test('every refusal the door can give has a sentence', () => {
    // A bare outcome code on a page is a thing to go and look up.
    for (const outcome of ['nothing_approved', 'no_revision_ready', 'not_selected_yet', 'not_locked_yet']) {
      assert.match(QUERIES, new RegExp(`${outcome}: '`), `${outcome} has no sentence`);
    }
  });

  test('and each explains the state, not the rule’s name', () => {
    assert.match(QUERIES, /no revised option has been delivered and approved, so this would claim something that has not happened/);
    assert.match(QUERIES, /the client has not picked a direction, so there is nothing to confirm/);
  });

  test('a blocked step renders its reason rather than vanishing', () => {
    // An absent row would read as "nothing to do here", which is a different
    // and wrong statement.
    assert.match(PAGE, /\) : \(\s*\n\s*<p className="max-w-2xl text-\[13px\] text-muted">\{m\.blockedReason\}<\/p>/);
    assert.match(QUERIES, /\*\*The refusals are the useful half\.\*\*/);
  });

  test('and every step comes back, sendable or not', () => {
    // The reader maps over the step list, not over what the door answered.
    assert.match(reader, /return MESSAGE_STEPS\.map\(\(step, i\) => \{/);
  });
});

describe('C. a failed read is not a "not ready"', () => {
  test('each render is G-054 guarded, named per step', () => {
    // A step that showed "not available" because the database did not answer
    // would tell a PM their project is not ready when nobody knows.
    assert.match(reader, /if \(error\) unreadable\(`readDesignMessages\.\$\{step\.key\}`, error\);/);
    assert.match(reader, /would tell a PM their project is not ready when\s*\n?\s*\/\/ nobody knows whether it is/);
  });

  test('all steps are fetched together', () => {
    assert.match(reader, /await Promise\.all\(\s*\n\s*MESSAGE_STEPS\.map/);
  });
});

describe('D. it offers the words; it does not send them', () => {
  test('the page says to copy and send it yourself', () => {
    assert.match(PAGE, /Copy this and send it yourself — AgencyOS has no channel configured\./);
    assert.match(PAGE, /Record what\s*\n?\s*you sent above\./);
  });

  test('and nothing here contacts anybody', () => {
    assert.doesNotMatch(reader, /send|dispatch|fetch\(/i);
  });

  test('the section says why a step may be missing, not just that it is', () => {
    assert.match(PAGE, /A step that would claim something that has not happened is not offered/);
  });
});

describe('E. the wording is shown as the door rendered it', () => {
  test('the body is not re-templated on the page', () => {
    // Every variable is filled by the door from live state. A second pass here
    // would be a second opinion about what is true.
    // The placeholder pattern specifically — a bare /\{\{/ also matches JSX's
    // own `style={{…}}`, which is not a template at all.
    assert.doesNotMatch(PAGE, /\{\{[a-z_]+\}\}/);
    assert.doesNotMatch(PAGE, /m\.body\.replace|m\.body\.slice/);
  });

  test('and it renders whitespace as written, because a template may carry it', () => {
    assert.match(PAGE, /whitespace-pre-wrap/);
  });
});
