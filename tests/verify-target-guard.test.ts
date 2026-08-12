import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Gap G-083 — nothing stopped a verification run driving a production app.
 *
 * `scripts/verify-target.mjs` has always been careful about which database the
 * *scripts* write to: it refuses to run against a target they were not pointed
 * at. But four of them then drive the running **application** as well — planting
 * a job and asking `/api/jobs/run` to work it, posting a signed webhook and
 * waiting for the row to appear — and nothing checked that the application was
 * talking to the same place.
 *
 * That is not theoretical; it happened during this audit. `next build` inlines
 * `NEXT_PUBLIC_SUPABASE_URL`, so a build run without the verify environment
 * sourced produces an app aimed at whatever `.env.local` holds, which in a
 * working copy is usually a real project. The only reason nothing landed there
 * is that the local service key did not match the remote URL, so every call the
 * app made failed with `Invalid API key`. With a matching pair it would have
 * drained a production queue.
 *
 * The guard is a fingerprint of the database URL, served by /api/health and
 * compared before any fixture is planted. Proved end to end by rebuilding the
 * app against a different database and watching all four scripts refuse.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) => readFileSync(new URL(relative, new URL(root, 'file:')), 'utf8');

const health = read('app/api/health/route.ts');
const verifyTarget = read('scripts/verify-target.mjs');

/** The four that drive the running application rather than only the schema. */
const APP_DRIVEN = [
  'scripts/verify-milestone-unlock.mjs',
  'scripts/verify-job-reaper.mjs',
  'scripts/verify-whatsapp-webhook.mjs',
  'scripts/verify-requirement-proposal.mjs',
];

// ═══════════════════════════════════════════════════════════════════════════
// A. The app says which database it is using
// ═══════════════════════════════════════════════════════════════════════════

describe('A. /api/health reports a target', () => {
  test('it is derived from the database URL', () => {
    assert.match(health, /target: createHash\('sha256'\)/);
    assert.match(health, /\.update\(clientEnv\.NEXT_PUBLIC_SUPABASE_URL\)/);
  });

  test('and it is a fingerprint, not the URL itself', () => {
    // The URL is already in the client bundle — NEXT_PUBLIC_ is shipped to
    // browsers — so this adds no new public fact either way. A hash is the
    // conservative choice and is all the comparison needs.
    const at = health.indexOf('target: createHash');
    assert.ok(at > 0);
    const field = health.slice(at, at + 220);
    assert.match(field, /\.digest\('hex'\)/);
    assert.match(field, /\.slice\(0, 12\)/);
  });

  test('the fingerprint is stable and short enough to compare by eye', () => {
    const fingerprint = createHash('sha256')
      .update('http://127.0.0.1:54321')
      .digest('hex')
      .slice(0, 12);
    assert.equal(fingerprint.length, 12);
    assert.match(fingerprint, /^[0-9a-f]{12}$/);
  });

  test('no key or secret is reported alongside it', () => {
    const at = health.indexOf('target: createHash');
    const field = health.slice(at, at + 220);
    assert.doesNotMatch(field, /SERVICE_ROLE|ANON_KEY|SECRET/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The guard, and what it refuses
// ═══════════════════════════════════════════════════════════════════════════

describe('B. assertAppTarget', () => {
  test('compares the app against the script own target', () => {
    assert.match(verifyTarget, /export async function assertAppTarget/);
    assert.match(verifyTarget, /createHash\('sha256'\)\.update\(target\.url\)/);
    assert.match(verifyTarget, /body\.target !== fingerprint/);
  });

  test('an app that cannot say is refused, not assumed compatible', () => {
    // "I could not tell" and "they match" are different answers, and this
    // exists precisely for the case where the answer is not obvious. An older
    // build with no `target` field is exactly the build most likely to be the
    // stale one.
    assert.match(verifyTarget, /typeof body\?\.target !== 'string'/);
    const at = verifyTarget.indexOf("typeof body?.target !== 'string'");
    assert.match(verifyTarget.slice(at, at + 400), /fail\(/);
  });

  test('an unreachable app is refused too, and refusing is the first thing it does', () => {
    const at = verifyTarget.indexOf('export async function assertAppTarget');
    const body = verifyTarget.slice(at);
    const c = body.indexOf('} catch (error) {');
    assert.ok(c > 0, 'the fetch is no longer guarded');

    // `fail(` must be the first statement in the handler. Asserting only that
    // the message exists somewhere would pass with an early `return` in front
    // of it, which is exactly how an unreachable app would be waved through.
    assert.match(body.slice(c), /\} catch \(error\) \{\s*fail\(/);
    assert.match(body.slice(c, c + 400), /could not reach/);
  });

  test('and the refusal says how to fix it', () => {
    // The cause is always the same and is not obvious: NEXT_PUBLIC_ is inlined
    // at build time, so sourcing the environment before `npm run start` is not
    // enough — the build has to be redone.
    const at = verifyTarget.indexOf('export async function assertAppTarget');
    const body = verifyTarget.slice(at);
    assert.match(body, /inlined/);
    assert.match(body, /Rebuild/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Every script that drives the app uses it
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the scripts that need it call it', () => {
  for (const path of APP_DRIVEN) {
    test(`${path.replace('scripts/', '')} checks before it plants anything`, () => {
      const source = read(path);
      assert.match(source, /assertAppTarget/, 'this script drives the app but does not check its target');

      // Before the first write, not merely present somewhere in the file.
      const guard = source.indexOf('await assertAppTarget');
      assert.ok(guard > 0, 'assertAppTarget is imported but never awaited');

      // Pinned to the preflight, immediately after the target is announced.
      //
      // Textual position cannot answer this on its own: every one of these
      // scripts defines helpers containing `await insert(` long before it
      // calls one, so "the first write in the file" is a function body, not an
      // execution. What *is* a reliable ordering fact is that announceTarget
      // runs first — it is the run's opening line — so a guard adjacent to it
      // runs before anything else does.
      const announce = source.indexOf('announceTarget(target);');
      assert.ok(announce > 0, 'the run no longer announces its target');
      assert.ok(
        guard > announce && guard - announce < 300,
        `the target check has drifted away from the preflight (announce ${announce}, guard ${guard})`,
      );
    });
  }

  test('and the schema-only scripts do not, because they drive no app', () => {
    // verify-schema and verify-first-owner talk to PostgREST alone, so there
    // is no second target to disagree with. verify-first-owner has its own,
    // stricter refusal: it declines any non-isolated target outright.
    assert.doesNotMatch(read('scripts/verify-schema.mjs'), /assertAppTarget/);
    assert.match(read('scripts/verify-first-owner.mjs'), /target\.isolated/);
  });
});
