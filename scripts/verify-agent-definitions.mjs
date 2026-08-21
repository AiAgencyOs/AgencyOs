#!/usr/bin/env node
/**
 * Agent definitions, verified against a real database — and stamped.
 *
 * Gap G-130. ADM-83 granted `ai.agents.definition_version` and
 * `last_validated_at`, and **nothing has ever written either of them**. Every
 * row in every environment reads `null`, which the column comment defines as
 * *never validated*. They were fields carrying a fact no producer produced.
 *
 * ── why a static check could not do this ──────────────────────────────────
 *
 * `check-record` §14 already proves the **seed** matches the registry, and
 * says in its own comment why that is not enough:
 *
 *   "A drifted production row is a different problem, and one the
 *    `last_validated_at` column exists to make visible."
 *
 * The seed is what an environment *starts* from. `ai.agents.enabled` is an
 * UPDATE by design — turning an agent on is deliberately not a deploy — so a
 * live row can diverge from the registry without any diff to review. That is
 * the case this script exists for, and it needs a live database to see it.
 *
 * ── what `definition_version` is ──────────────────────────────────────────
 *
 * The column comment fixes the meaning: *"Which revision of
 * src/modules/agents/registry.ts this row was last validated against."* So it
 * is a hash of that file, not of one agent's fields — twelve hex characters of
 * its SHA-256. A git SHA was rejected because it moves on every unrelated
 * commit, which would report drift where none exists and train a reader to
 * ignore the column.
 *
 * Reformatting the file changes the hash without changing meaning. That is
 * correct rather than a flaw: it means *revalidate*, not *broken*, and a
 * revalidation costs one run of this script.
 *
 * ── what it refuses to do ─────────────────────────────────────────────────
 *
 * **It never stamps a row it could not verify.** A stamp is a claim that the
 * row was checked and agreed; writing one for a drifted row would put a
 * validation claim on the exact row that needs attention, which is worse than
 * the null it replaces. Drifted rows are reported and left alone.
 *
 * It also never *fixes* drift. An enabled agent with no definition is a
 * deployment question — whether the row is wrong or the registry is — and
 * guessing either way silently changes what an operator's system does.
 *
 *   node scripts/verify-agent-definitions.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

// Drives the database directly and never calls the job runner, so no
// CRON_SECRET is required — the same posture as verify-agent-autonomy.
const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'verify-agent-definitions');

const URL_BASE = target.url;
const KEY = target.serviceKey;

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

async function rest(method, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: method === 'PATCH' ? 'return=representation' : 'return=representation',
      'Accept-Profile': 'ai',
      'Content-Profile': 'ai',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ── the registry, and the revision every stamp will name ───────────────────

const REGISTRY_PATH = 'src/modules/agents/registry.ts';
const registrySource = readFileSync(REGISTRY_PATH, 'utf8');
const VERSION = createHash('sha256').update(registrySource).digest('hex').slice(0, 12);

// The same expression check-record §14 uses, deliberately: two parsers reading
// one file with different rules is a disagreement waiting to happen.
const defined = new Set(
  [...registrySource.matchAll(/^\s*key:\s*'([a-z][a-z0-9_]{2,48})'/gm)].map((m) => m[1]),
);

if (defined.size === 0) {
  fail(
    `no agent definitions were found in ${REGISTRY_PATH} — the parser drifted, and a check that finds nothing would stamp every row against an empty registry`,
  );
}

console.log(`\n  registry ${REGISTRY_PATH} → version ${VERSION} (${defined.size} defined)\n`);

// ── the live rows ──────────────────────────────────────────────────────────

const read = await rest('GET', 'agents?select=key,enabled,autonomy_level,definition_version,last_validated_at');
if (read.status !== 200 || !Array.isArray(read.json)) {
  fail(`could not read ai.agents (HTTP ${read.status}): ${read.text.slice(0, 200)}`);
}

const rows = read.json;
check(rows.length > 0, `ai.agents has rows to validate (${rows.length})`);

// ── 1. every ENABLED row must have a definition ────────────────────────────
//
// The rule G-125 established, enforced here against the live table rather than
// the seed. A disabled row may lack one: ADM-82 folded lead_qualifier and
// proposal_drafter into the sales agent and preserved their rows deliberately.

const enabled = rows.filter((r) => r.enabled);
const undefinedEnabled = enabled.filter((r) => !defined.has(r.key));

check(
  undefinedEnabled.length === 0,
  `every enabled agent has a definition (${enabled.length} enabled)`,
  undefinedEnabled.length > 0
    ? `${undefinedEnabled.map((r) => r.key).join(', ')} enabled in the database and absent from the registry`
    : '',
);

// ── 1b. and every DEFINITION must have a row ───────────────────────────────
//
// The converse, and the half that was missing here as it was missing from
// check-record §14. Both asked whether every enabled row has a definition;
// neither asked whether every definition has a row.
//
// It was not hypothetical. `quality_assurance` was defined in the registry,
// relied on by the verification contract, and absent from the production
// database for as long as the roster lived in `supabase/seed.sql` — which
// `db reset` applies and `db push` does not. `verdictFor` refuses a verdict
// from an undefined agent, so on production the completion contract could not
// have been exercised at all, and nothing said so.

const present = new Set(rows.map((r) => r.key));
const unregistered = [...defined].filter((k) => !present.has(k));

check(
  unregistered.length === 0,
  `every defined agent has a live row (${defined.size} defined)`,
  unregistered.length > 0
    ? `${unregistered.join(', ')} defined in the registry and absent from this database — a definition alone cannot be reached`
    : '',
);

// ── 2. the handoff mirror still matches ────────────────────────────────────
//
// check-record §16 proves the seed matches the registry. This proves the live
// table does, which is the half an UPDATE can break.

const declaredPairs = new Set(
  [...registrySource.matchAll(/key:\s*'([a-z][a-z0-9_]{2,48})'[\s\S]*?handoffTargets:\s*\[([^\]]*)\]/g)].flatMap(
    (m) => [...m[2].matchAll(/'([a-z][a-z0-9_]{2,48})'/g)].map((t) => `${m[1]}→${t[1]}`),
  ),
);

const mirror = await rest('GET', 'agent_handoff_targets?select=from_agent,to_agent');
if (mirror.status === 200 && Array.isArray(mirror.json)) {
  const livePairs = new Set(mirror.json.map((p) => `${p.from_agent}→${p.to_agent}`));
  const missing = [...declaredPairs].filter((p) => !livePairs.has(p));
  const extra = [...livePairs].filter((p) => !declaredPairs.has(p));
  check(
    missing.length === 0 && extra.length === 0,
    `the live handoff mirror matches the registry (${livePairs.size} pairs)`,
    [missing.length ? `missing: ${missing.join(', ')}` : '', extra.length ? `extra: ${extra.join(', ')}` : '']
      .filter(Boolean)
      .join('; '),
  );
} else {
  check(false, 'the live handoff mirror is readable', `HTTP ${mirror.status}`);
}

// The verifier mirror, under the same discipline: ai.agent_verifiers feeds
// the handoff completion guard, so a drifted row quietly changes who may
// declare work done. verifiedBy: null means no row — nothing verifies the
// verifier (ADM-83).
const declaredVerifiers = new Set(
  [...registrySource.matchAll(/key:\s*'([a-z][a-z0-9_]{2,48})'[\s\S]*?verifiedBy:\s*(?:'([a-z][a-z0-9_]{2,48})'|null)/g)]
    .filter((m) => m[2])
    .map((m) => `${m[1]}→${m[2]}`),
);

const verifierMirror = await rest('GET', 'agent_verifiers?select=producer,verifier');
if (verifierMirror.status === 200 && Array.isArray(verifierMirror.json)) {
  const livePairs = new Set(verifierMirror.json.map((p) => `${p.producer}→${p.verifier}`));
  const missing = [...declaredVerifiers].filter((p) => !livePairs.has(p));
  const extra = [...livePairs].filter((p) => !declaredVerifiers.has(p));
  check(
    missing.length === 0 && extra.length === 0,
    `the live verifier mirror matches the registry (${livePairs.size} pairs)`,
    [missing.length ? `missing: ${missing.join(', ')}` : '', extra.length ? `extra: ${extra.join(', ')}` : '']
      .filter(Boolean)
      .join('; '),
  );
} else {
  check(false, 'the live verifier mirror is readable', `HTTP ${verifierMirror.status}`);
}

// ── 3. stamp only what verified ────────────────────────────────────────────
//
// A stamp is a claim that this row was checked against that revision and
// agreed. Writing one for a drifted row would put a validation claim on the
// row most needing attention.

if (failures > 0) {
  console.error(
    `\n\x1b[31m✖ ${failures} of ${checks} checks failed — nothing was stamped\x1b[0m\n` +
      '  A validation stamp on a row that did not validate is worse than the null it replaces.\n',
  );
  process.exit(1);
}

const stampable = rows.filter((r) => defined.has(r.key));
const skipped = rows.filter((r) => !defined.has(r.key));

let stamped = 0;
for (const row of stampable) {
  const res = await rest('PATCH', `agents?key=eq.${encodeURIComponent(row.key)}`, {
    definition_version: VERSION,
    last_validated_at: new Date().toISOString(),
  });
  if (res.status >= 200 && res.status < 300) {
    stamped += 1;
  } else {
    check(false, `stamped ${row.key}`, `HTTP ${res.status}: ${res.text.slice(0, 160)}`);
  }
}

check(stamped === stampable.length, `stamped every validated row (${stamped}/${stampable.length})`);

// The constraint ADM-83 granted: a version and a time, or neither. Read back
// rather than assumed — a PATCH that silently wrote one half would otherwise
// be reported as success by the status code alone.
const after = await rest('GET', 'agents?select=key,definition_version,last_validated_at');
if (after.status === 200 && Array.isArray(after.json)) {
  const halves = after.json.filter(
    (r) => (r.definition_version === null) !== (r.last_validated_at === null),
  );
  check(halves.length === 0, 'no row claims validation with only half a claim', halves.map((r) => r.key).join(', '));

  const wrong = after.json.filter(
    (r) => defined.has(r.key) && r.definition_version !== VERSION,
  );
  check(wrong.length === 0, `every defined row now names revision ${VERSION}`, wrong.map((r) => r.key).join(', '));
}

if (skipped.length > 0) {
  console.log(
    `\n  ${skipped.length} row(s) left unstamped, correctly: ${skipped.map((r) => r.key).join(', ')}\n` +
      '  The registry does not describe them, so there is no revision to validate them against.\n' +
      '  ADM-82 folded these into the sales agent and preserved the rows deliberately.',
  );
}

if (failures === 0) {
  console.log(`\n\x1b[32m✔ ${checks} checks passed — agent definitions validated at ${VERSION}\x1b[0m\n`);
  process.exit(0);
}

console.error(`\n\x1b[31m✖ ${failures} of ${checks} checks failed\x1b[0m\n`);
process.exit(1);
