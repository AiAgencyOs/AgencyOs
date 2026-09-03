import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * The internal pages open locally — G-205 (audit TS-B).
 *
 * `core.custom_access_token_hook` has stamped `organization_id` and `role`
 * onto the token since migration 011, and on the deployed project a dashboard
 * step points GoTrue at it. **Locally nothing did.** So a browser session
 * carried no role claim, `requireInternal()` refused, and every internal page
 * redirected to `/no-access`.
 *
 * Twelve changes in a row had to say *"not visually verified"* for that one
 * reason — and no verification script ever noticed, because they mint their
 * tokens by hand and never go through GoTrue at all. A gap that only the
 * unautomated path could see is exactly the gap that survives longest.
 *
 * ── this file pins configuration, and that is the artifact ────────────────
 *
 * There is no behaviour here to execute: the change IS three blocks of
 * `supabase/config.toml` and one email template. A test that pins them is
 * pinning the thing itself, not a proxy for it — and each of the three failed
 * in a different, silent way before it was right, which is why all three are
 * named separately with what went wrong.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const CONFIG = read('supabase/config.toml');

describe('A. the three things the local stack was missing', () => {
  test('the hook is pointed at the function that has existed since migration 011', () => {
    assert.match(CONFIG, /\[auth\.hook\.custom_access_token\]\s*\nenabled = true\s*\nuri = "pg-functions:\/\/postgres\/core\/custom_access_token_hook"/);
  });

  test('the app’s own callback is on the redirect allow-list', () => {
    // Without it GoTrue silently falls back to `site_url`: the link lands on
    // the app ROOT with the token unspent, the callback never runs, and the
    // sign-in fails for no visible reason.
    assert.match(CONFIG, /"http:\/\/localhost:3000\/auth\/callback"/);
    assert.match(CONFIG, /"http:\/\/127\.0\.0\.1:3000\/auth\/callback"/);
  });

  test('and the magic-link email emits the shape the callback documents', () => {
    // The DEFAULT template sends `{{ .ConfirmationURL }}`, which routes
    // through /auth/v1/verify and arrives with neither `code` nor
    // `token_hash`. The callback then answers "Missing sign-in credentials",
    // which is correct and says nothing about the template being the cause.
    assert.match(CONFIG, /\[auth\.email\.template\.magic_link\][\s\S]{0,200}?content_path = "\.\/supabase\/templates\/magic-link\.html"/);
    const template = read('supabase/templates/magic-link.html');
    assert.match(template, /\{\{ \.SiteURL \}\}\/auth\/callback\?token_hash=\{\{ \.TokenHash \}\}&amp;type=magiclink/);
  });

  test('the callback still documents exactly those two shapes', () => {
    // If this docblock changes, the template above is wrong and nothing else
    // would say so.
    const callback = read('app/auth/callback/route.ts');
    assert.match(callback, /OAuth \(PKCE\) → \?code=\.\.\./);
    assert.match(callback, /Magic link {3}→ \?token_hash=\.\.\.&type=magiclink/);
  });
});

describe('B. and a way in that is one command', () => {
  test('the helper refuses to run against anything but a local stack', () => {
    // It creates a user and reads a mailbox. Neither belongs on a deployment.
    const script = read('scripts/sign-in-locally.mjs');
    assert.match(script, /This is for a LOCAL stack/);
    assert.match(script, /!target\.url\.includes\('127\.0\.0\.1'\) && !target\.url\.includes\('localhost'\)/);
  });

  test('it is idempotent — running it twice makes no second owner', () => {
    const script = read('scripts/sign-in-locally.mjs');
    assert.match(script, /reusing \$\{EMAIL\}/);
    assert.match(script, /already a \$\{membership\.json\[0\]\.role\}/);
  });

  test('and it says what to check when no link arrives', () => {
    // The failure it is most likely to hit is the template one, and that
    // failure is silent everywhere else.
    const script = read('scripts/sign-in-locally.mjs');
    assert.match(script, /the DEFAULT one routes through \/auth\/v1\/verify/i);
  });

  test('the membership is named as what the claim comes from', () => {
    // A user with no membership signs in perfectly well and is refused by
    // every internal page — the behaviour, not a bug.
    const script = read('scripts/sign-in-locally.mjs');
    assert.match(script, /The claim comes from `core\.memberships`, not from the user/);
  });
});
