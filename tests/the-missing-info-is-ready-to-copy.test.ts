import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The missing info is ready to copy — PM §4.2, G-266, ADM-109; G-309.
 *
 * `outstanding_client_requests` (G-266) says WHICH item is still worth
 * asking. Until now the onboarding page showed only its internal label —
 * "Ask next: GST/Non-GST confirmation" — and left composing an actual message
 * to a PM, every time, for every project. This mirrors Phase 3's
 * `render_design_message`: render the words from live backend state, refuse
 * rather than invent them when there is nothing to ask, and stop there.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QUERIES = read('src/modules/projects/queries.ts');
const PAGE = read('app/(internal)/projects/[projectId]/page.tsx');
const DOOR = read('supabase/migrations/20260920180000_the_missing_info_is_ready_to_copy.sql');

const reader = (() => {
  const start = QUERIES.indexOf('export async function readMissingInfoMessage');
  assert.ok(start > 0, 'readMissingInfoMessage does not exist');
  const next = QUERIES.indexOf('\nexport ', start + 1);
  return QUERIES.slice(start, next > 0 ? next : undefined);
})();

describe('A. the door has a caller', () => {
  test('the reader calls render_missing_info_message', () => {
    assert.match(reader, /\.rpc\('render_missing_info_message', \{ p_project_id: projectId \}\)/);
  });

  test('and the page calls the reader beside readNextQuestions', () => {
    assert.match(PAGE, /const questions = await readNextQuestions\(projectId\);/);
    assert.match(PAGE, /const missingInfoMessage = await readMissingInfoMessage\(projectId\);/);
  });

  test('and only renders when there is an ask-next item', () => {
    assert.match(PAGE, /\{questions\.outstanding\.find\(\(q\) => q\.askNext\) \? \(/);
    assert.match(PAGE, /\{missingInfoMessage\.body \? \(/);
  });
});

describe('B. a refusal says why, not just that there is nothing', () => {
  test('every refusal the door can give has a sentence', () => {
    for (const outcome of ['nothing_to_ask', 'unknown_project']) {
      assert.match(QUERIES, new RegExp(`${outcome}: '`), `${outcome} has no sentence`);
    }
  });

  test('a failed read is not "nothing to ask" (G-054)', () => {
    assert.match(reader, /if \(error\) unreadable\('readMissingInfoMessage', error\);/);
  });
});

describe('C. it offers the words; it does not send them', () => {
  test('the page says to copy and send it yourself', () => {
    assert.match(PAGE, /Copy this and send it yourself — AgencyOS has no channel configured\./);
  });

  test('and nothing here contacts anybody', () => {
    assert.doesNotMatch(reader, /send|dispatch|fetch\(/i);
  });

  test('the door itself never sends either', () => {
    assert.doesNotMatch(DOOR, /whatsapp|http|fetch/i);
  });
});

describe('D. the door refuses rather than invents', () => {
  test('no actor, no project and nothing askable are each their own outcome', () => {
    assert.match(DOOR, /'no_actor'::text/);
    assert.match(DOOR, /'unknown_project'::text/);
    assert.match(DOOR, /'nothing_to_ask'::text/);
  });

  test('it reads the ask-next item from outstanding_client_requests rather than recomputing it', () => {
    assert.match(DOOR, /from projects\.outstanding_client_requests\(p_project_id\) r\s*\n\s*where r\.ask_next/);
  });

  test('it does not touch ADM-109’s open half', () => {
    assert.match(DOOR, /does NOT touch ADM-109's open half/);
  });
});
