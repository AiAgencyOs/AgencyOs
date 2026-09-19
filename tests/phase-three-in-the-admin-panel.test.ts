import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Phase 3 in the Admin Panel — Master §8, §10; G-286.
 *
 * G-277 through G-285 built eleven tables, nine doors and the whole gate order
 * — and rendered **none of it**. Every table is internal-only with no write
 * policy, so the entire phase was visible to somebody with a database client
 * and to nobody else. That is the dominant defect class in this repository,
 * and this was its largest instance.
 *
 * §8's sentence is the requirement: *"Admin must be able to inspect not only
 * the final selected UI, but the **complete decision trail**"* — and it marks
 * one row *very important*: *"which UI samples were sent to this client?"*,
 * **without reading WhatsApp manually.**
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const PAGE = read('app/(internal)/projects/[projectId]/design/page.tsx');
const QUERIES = read('src/modules/projects/queries.ts');
const PANEL = read('app/(internal)/projects/[projectId]/phase-two-panel.tsx');

const reader = (() => {
  const start = QUERIES.indexOf('export async function readDesignTrail');
  assert.ok(start > 0, 'readDesignTrail does not exist');
  // Bounded at the next export. An open-ended slice swallowed the function
  // G-287 appended after it and counted its reads as this one's.
  const next = QUERIES.indexOf('\nexport ', start + 1);
  return QUERIES.slice(start, next > 0 ? next : undefined);
})();

describe('A. §8’s areas are all present', () => {
  test('every table the phase writes is read', () => {
    // Eleven units built these; a trail missing one is a trail with a hole in
    // exactly the place somebody is looking.
    for (const table of ['phase_three', 'screen_baselines', 'theme_options', 'color_options',
                         'design_reviews', 'admin_design_decisions', 'client_design_shares',
                         'client_design_decisions', 'design_revisions', 'phase_three_handoffs']) {
      assert.match(reader, new RegExp(`\\.from\\('${table}'\\)`), `${table} is not read`);
    }
  });

  test('and each §8 area has a heading a person can find', () => {
    for (const title of ['Overview', 'Screen baseline', 'Theme and colour options',
                         'Internal review', 'Admin decisions', 'What was sent to the client',
                         'What the client said', 'Revision history',
                         'Final direction and Phase 4 handoff', 'Design cost and usage']) {
      assert.match(PAGE, new RegExp(`title="${title}"`), `${title} has no section`);
    }
  });

  test('the row §8 marks *very important* is answered without WhatsApp', () => {
    // G-282 froze the share as a snapshot so this question would have an
    // answer here. This is where it gets asked.
    assert.match(PAGE, /without reading WhatsApp/);
    assert.match(reader, /\.from\('client_design_shares'\)[\s\S]{0,200}?shared_options/);
  });

  test('cost and usage is named rather than quietly omitted', () => {
    // §8 asks for it "where available". Nothing has run, and a section that
    // simply was not there would read as an oversight rather than a state.
    assert.match(PAGE, /No design generation has run on this deployment/);
  });
});

describe('B. it is one read, not thirteen', () => {
  test('the trail is fetched together', () => {
    // Thirteen panels each firing their own query would show thirteen moments
    // of the same project, and a decision trail whose rows disagree about when
    // they were taken is not a trail.
    assert.match(reader, /await Promise\.all\(\[/);
    assert.match(QUERIES, /rows disagree about when they were taken is not a trail/);
  });

  test('and the trail is one reader, fetched alongside the roster', () => {
    // G-287 added the reviewer picker, which needs the roster. Two reads, but
    // still one moment: they are awaited together rather than in sequence.
    assert.match(PAGE, /const \[trail, roster\] = await Promise\.all\(\[readDesignTrail\(projectId\), listInternalRoster\(\)\]\);/);
    assert.equal((PAGE.match(/\b(readDesignTrail|listInternalRoster)\(/g) ?? []).length, 2);
    // Counting total awaits was a brittle proxy — it broke the first time a
    // legitimate read was added (G-291's messages), which is not the thing
    // this test is about. What it means is: the TRAIL is one read, and no read
    // happens per row.
    assert.equal((PAGE.match(/\breadDesignTrail\(/g) ?? []).length, 1);
    assert.doesNotMatch(PAGE, /\.map\([^)]*\)\s*=>\s*await |await [a-z]\w*\([^)]*\)\s*\)\s*\)/);
  });
});

describe('C. a failed read never renders as an empty phase', () => {
  test('every error is raised, none swallowed', () => {
    // G-054. A trail that rendered "the client has not replied" on a failed
    // read would state something about a client that nobody checked.
    const errs = reader.match(/if \(\w*[Ee]rror\) unreadable\(/g) ?? [];
    assert.ok(errs.length >= 10, `only ${errs.length} reads are guarded`);
    assert.equal(
      (reader.match(/error: \w*[Ee]rror/g) ?? []).length,
      (reader.match(/unreadable\(/g) ?? []).length,
      'a read was destructured whose error is never raised',
    );
  });

  test('each failure is named separately', () => {
    // They share one Promise.all; one label for all of them would tell the log
    // that "the trail" failed and not which part of it.
    for (const label of ['readDesignTrail.phase', 'readDesignTrail.themes',
                         'readDesignTrail.clientDecisions', 'readDesignTrail.handoff',
                         'readDesignTrail.colors']) {
      assert.match(reader, new RegExp(`unreadable\\('${label.replace('.', '\\.')}'`), `${label} is not named`);
    }
  });

  test('and the reader is exercised by the behavioural half, not only the structural one', () => {
    // The structural sweep would pass on a reader that swallowed a failure on
    // its early-return path.
    assert.match(read('tests/read-failure-semantics.test.ts'), /projects\.readDesignTrail/);
  });
});

describe('D. it shows the trail and takes no decisions', () => {
  test('the page itself stays a Server Component', () => {
    // G-287 added §10's two queues as client components imported into it. The
    // page reads and decides what to offer; it holds no interactive state.
    assert.doesNotMatch(PAGE, /'use client'/);
    assert.doesNotMatch(PAGE, /useActionState|<form /);
  });

  test('and the set of doors with a surface is exactly the decided one', () => {
    // G-287 added the two review gates; G-288 the client loop. The lock is
    // still absent on purpose — it is the completion gate and belongs with the
    // handoff. Asserting the SET, so a seventh form cannot appear unnoticed.
    assert.deepEqual(
      [...PAGE.matchAll(/<(\w+Form)\b/g)].map((m) => m[1] ?? '').filter((v, i, a) => a.indexOf(v) === i).sort(),
      ['AdminDecisionForm', 'AssignReviewerForm', 'InternalReviewForm', 'LockDirectionForm',
       'OpenRevisionForm', 'RecordClientReplyForm', 'RecordSampleForm', 'RecordShareForm',
       'TokenSetForm'],
    );
  });

  test('it recomputes no rule the database already holds', () => {
    // Reading a stored status to decide what to OFFER is not re-derivation —
    // G-288 filters the share picker on `adminStatus` for the same reason the
    // badge renders it. What is forbidden is reaching a CONCLUSION the
    // database owns: inferring approval as a verdict, or deriving the revision
    // ceiling here rather than reading the stored count and limit.
    assert.doesNotMatch(PAGE, /adminStatus === 'approved' \? '|revisionCount >= |revisionCount > /);
    assert.match(PAGE, /a second opinion on a rule the database already holds/);
    // The counts are printed as stored, never compared.
    assert.match(PAGE, /\{phase\.revisionCount\} of \{phase\.revisionLimit\}/);
  });

  test('readiness is read as stored, never inferred from the Figma field', () => {
    assert.match(PAGE, /trail\.handoff\.phaseFourReady \? 'Phase 4 ready' : 'not Phase 4 ready'/);
    assert.doesNotMatch(PAGE, /figmaNodeId \? 'Phase 4 ready'/);
  });

  test('and the client’s words are shown as written', () => {
    // Not summarised, not truncated. An interpretation nobody can see the
    // source of is this system's opinion about a client.
    assert.match(PAGE, /\{c\.clientWords\}/);
    assert.doesNotMatch(PAGE, /clientWords\.slice|clientWords\.substring/);
  });
});

describe('E. it is reachable', () => {
  test('the Phase 2 panel links to it', () => {
    // The panel claimed "Phase 3 has been handed the work" for three units
    // before that was true anywhere a person could look.
    assert.match(PANEL, /\/projects\/\$\{projectId\}\/design/);
  });

  test('and the page refuses a reader without permission', () => {
    assert.match(PAGE, /await requireInternal\(`\/projects\/\$\{projectId\}\/design`\)/);
    assert.match(PAGE, /if \(!can\(context\.role, 'project\.read'\)\) redirect\('\/dashboard'\)/);
  });

  test('a project that does not exist is a 404, not an empty trail', () => {
    assert.match(PAGE, /if \(!project\) notFound\(\);/);
  });

  test('and a project with no Phase 3 says so rather than rendering empty sections', () => {
    assert.match(PAGE, /Phase 3 has not started for this project\./);
  });
});

describe('F. the generated database types match the schema they describe', () => {
  test('every table the reader selects from is typed', () => {
    // `db:types` needs Docker, which is not running here, so these were
    // generated from the live schema on a scratch Postgres and spliced in —
    // the same shape the phase_three entry already had.
    const types = read('src/lib/db/types.ts');
    for (const table of ['screen_baselines', 'theme_options', 'color_options', 'design_reviews',
                         'admin_design_decisions', 'client_design_shares', 'client_design_decisions',
                         'design_revisions', 'phase_three_handoffs']) {
      assert.match(types, new RegExp(`^ {6}${table}: \\{$`, 'm'), `${table} is not in types.ts`);
    }
  });

  test('and the columns G-278 added to `screens` are no longer missing', () => {
    // types.ts had been stale since that unit; nothing read them, so nothing
    // failed.
    const types = read('src/lib/db/types.ts');
    for (const col of ['required_sections', 'dependencies', 'baseline_version']) {
      assert.match(types, new RegExp(`^ {10}${col}: `, 'm'), `screens.${col} is not typed`);
    }
  });
});
