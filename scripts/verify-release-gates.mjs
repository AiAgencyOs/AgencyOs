// ═══════════════════════════════════════════════════════════════════════════
// Evidence is not confidence.
//
// Doc 14 §31 lists nine ways a system lies to itself about being ready. Three
// of them are about the same missing thing, and all three are asserted here
// against real Postgres:
//
//   "Never use agent confidence as evidence."
//   "Skipped tests are not passes."
//   "Do not approve a build different from the tested build."
//
// And one more, which is the shape of the whole reading: a gate nobody has
// configured must report `undecided`, never `pass`. A readiness report that
// resolves the unknown in its own favour is how false production readiness
// happens, which is what §31 exists to prevent.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
announceTarget(target, 'a build is ready when the evidence says so');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-gates';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
function check(condition, description, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const parse = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return t;
  }
};

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': schema,
      'Accept-Profile': schema,
      Prefer: 'return=representation',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const run = (projectId, deliverableId, over = {}) =>
  rest('POST', 'qa', 'test_runs', {
    organization_id: ORG,
    project_id: projectId,
    deliverable_id: deliverableId,
    suite: 'functional',
    total: 100,
    passed: 100,
    failed: 0,
    skipped: 0,
    evidence_url: 'https://ci.example/run/1',
    ...over,
  });

const gates = async (projectId) => {
  const r = await rest('POST', 'qa', 'rpc/release_gates', { p_project_id: projectId });
  const rows = Array.isArray(r.json) ? r.json : [];
  return Object.fromEntries(rows.map((g) => [g.gate, g]));
};

const created = { projects: [], accounts: [] };

try {
  const account = one(
    await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }),
  );
  created.accounts.push(account.id);

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG,
      client_account_id: account.id,
      name: `${MARKER} ${randomUUID().slice(0, 8)}`,
      status: 'planning',
    }),
  );
  created.projects.push(project.id);

  // ── A ──────────────────────────────────────────────────────────────────
  console.log('\n  A. with nothing recorded, nothing passes by default');

  const empty = await gates(project.id);
  check(empty.build_exists?.state === 'fail', 'no build is a failed gate, not a missing one', empty.build_exists?.state);
  check(
    empty.critical_tests_pass?.state === 'undecided',
    'and tests with no build are UNDECIDED — a gate with no evidence has not been met, it has not been asked',
    empty.critical_tests_pass?.state,
  );
  const configurable = ['security_gates', 'performance_gates', 'migration_validation',
                        'deployment_config_valid', 'rollback_plan', 'client_acceptance'];
  check(
    configurable.every((g) => empty[g]?.state === 'undecided'),
    'every gate AgencyOS records nothing for says so out loud',
    configurable.map((g) => `${g}:${empty[g]?.state}`).filter((s) => !s.endsWith('undecided')).join(', ') || 'all undecided',
  );
  check(
    !Object.values(empty).some((g) => typeof g.state === 'number'),
    'and no score is computed — Doc 14 §19 leaves the weights to the Admin Policy Engine',
  );

  // ── B ──────────────────────────────────────────────────────────────────
  console.log('\n  B. evidence names the exact build it was run against');

  const design = one(
    await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: project.id, p_kind: 'design', p_title: `${MARKER} design`,
    }),
  );
  const onDesign = await run(project.id, design.deliverable_id);
  check(
    !onDesign.ok && /a design is reviewed and a build is tested/.test(JSON.stringify(onDesign.json)),
    'a test run cannot name a design',
    onDesign.ok ? 'IT WAS ACCEPTED' : `${onDesign.status}`,
  );

  const floating = await rest('POST', 'qa', 'test_runs', {
    organization_id: ORG, project_id: project.id, suite: 'functional',
    total: 10, passed: 10, failed: 0, skipped: 0,
  });
  check(
    !floating.ok,
    'and cannot name nothing at all — evidence that names no build is evidence for anything',
    floating.ok ? 'IT WAS ACCEPTED' : `${floating.status}`,
  );

  const buildV1 = one(
    await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: project.id, p_kind: 'build', p_title: `${MARKER} build`,
      p_artifact_url: 'https://builds.example/v1.apk',
    }),
  );
  const good = await run(project.id, buildV1.deliverable_id);
  check(good.ok, 'a run against the build is recorded', good.ok ? '' : `${good.status}`);

  // ── C ──────────────────────────────────────────────────────────────────
  console.log('\n  C. skipped tests are not passes');

  const lying = await run(project.id, buildV1.deliverable_id, {
    suite: 'regression', total: 100, passed: 100, failed: 0, skipped: 30,
  });
  check(
    !lying.ok && /test_runs_counts_add_up/.test(JSON.stringify(lying.json)),
    '100 passed of 100 with 30 skipped does not add up, and the fold IS the lie',
    lying.ok ? 'IT WAS ACCEPTED' : `${lying.status}`,
  );

  await run(project.id, buildV1.deliverable_id, {
    suite: 'regression', total: 100, passed: 70, failed: 0, skipped: 30,
  });
  const withSkips = await gates(project.id);
  check(
    withSkips.critical_tests_pass?.state === 'fail',
    'an honestly-reported skip still fails the gate — Doc 14 §31',
    withSkips.critical_tests_pass?.detail,
  );

  // ── D ──────────────────────────────────────────────────────────────────
  console.log('\n  D. an agent may not be its own evidence');

  const bare = await run(project.id, buildV1.deliverable_id, {
    suite: 'smoke', executed_by_agent: 'quality_assurance', evidence_url: null,
  });
  check(
    !bare.ok && /agent_evidence_is_external/.test(JSON.stringify(bare.json)),
    'an agent-authored run with nothing behind it is refused',
    bare.ok ? 'IT WAS ACCEPTED' : `${bare.status}`,
  );

  const sourced = await run(project.id, buildV1.deliverable_id, {
    suite: 'smoke', executed_by_agent: 'quality_assurance',
    evidence_url: 'https://ci.example/run/smoke-7',
  });
  check(sourced.ok, 'with a re-checkable artefact it is evidence', sourced.ok ? '' : `${sourced.status}`);

  const manual = await run(project.id, buildV1.deliverable_id, {
    suite: 'compatibility', total: 5, passed: 5, evidence_url: null,
  });
  check(manual.ok, 'and a human recording a manual run still may — Doc 14 §18 admits manual testing', manual.ok ? '' : `${manual.status}`);

  // ── E ──────────────────────────────────────────────────────────────────
  console.log('\n  E. a run is evidence, so it is never rewritten');

  // TWO LAYERS, and this deliberately asserts only that the write is refused
  // rather than WHICH layer refused it. The table grants no UPDATE and no
  // DELETE, so PostgREST answers 403 before any trigger runs; matching the
  // trigger's wording here would be asserting a refusal a different layer
  // owns, which is a false test even when the outcome is right. The trigger
  // is the second line, for a future migration that grants UPDATE without
  // noticing — the red-proof grants it and watches the trigger refuse anyway.
  const runId = one(sourced)?.id;
  const edited = await rest('PATCH', 'qa', `test_runs?id=eq.${runId}`, { failed: 0, passed: 100, total: 100 });
  check(
    !edited.ok,
    'the numbers cannot be corrected afterwards; the honest repair is another run',
    edited.ok ? 'IT WAS ACCEPTED' : `refused ${edited.status}`,
  );
  const dropped = await rest('DELETE', 'qa', `test_runs?id=eq.${runId}`);
  check(!dropped.ok, 'nor deleted', dropped.ok ? 'IT WAS ACCEPTED' : `refused ${dropped.status}`);

  const stillThere = await rest('GET', 'qa', `test_runs?id=eq.${runId}&select=id,passed,failed`);
  check(
    Array.isArray(stillThere.json) && stillThere.json.length === 1,
    'and the original row is still exactly what it said',
    `${one(stillThere)?.passed} passed / ${one(stillThere)?.failed} failed`,
  );

  // ── F ──────────────────────────────────────────────────────────────────
  console.log('\n  F. a new build starts with no evidence, rather than inheriting the last one');

  const buildV2 = one(
    await rest('POST', 'projects', 'rpc/add_deliverable', {
      p_project_id: project.id, p_kind: 'build', p_title: `${MARKER} build 2`,
      p_artifact_url: 'https://builds.example/v2.apk',
    }),
  );
  const afterV2 = await gates(project.id);
  check(
    afterV2.critical_tests_pass?.state === 'undecided',
    'v1 passing says nothing about v2 — "do not approve a build different from the tested build"',
    afterV2.critical_tests_pass?.detail,
  );
  check(afterV2.build_exists?.detail === 'v2', 'the gates read the newest build', afterV2.build_exists?.detail);

  await run(project.id, buildV2.deliverable_id, { suite: 'functional', total: 120, passed: 120 });
  const passing = await gates(project.id);
  check(
    passing.critical_tests_pass?.state === 'pass',
    'and once v2 has its own clean evidence, it passes',
    passing.critical_tests_pass?.detail,
  );
  check(passing.artifact_identified?.state === 'pass', 'the artifact is identified', passing.artifact_identified?.state);
  check(passing.no_unresolved_s0_s1?.state === 'pass', 'and no blocker or major is open', passing.no_unresolved_s0_s1?.detail);

  // ── G ──────────────────────────────────────────────────────────────────
  console.log('\n  G. a defect nobody fixed still fails the gate');

  const raised = await rest('POST', 'qa', 'defects', {
    organization_id: ORG, project_id: project.id, deliverable_id: buildV2.deliverable_id,
    title: `${MARKER} crash on launch`, severity: 'blocker', status: 'open',
    reproduction: 'Open the app on a cold start.',
  });
  check(raised.ok, 'a blocker is raised against the tested build', raised.ok ? '' : `${raised.status}`);
  const withDefect = await gates(project.id);
  check(
    withDefect.no_unresolved_s0_s1?.state === 'fail',
    'a clean test suite does not cancel an open blocker — §31: critical defects cannot be hidden inside an average',
    withDefect.no_unresolved_s0_s1?.detail,
  );
  check(
    withDefect.critical_tests_pass?.state === 'pass',
    'and the two gates answer independently, rather than being averaged into one number',
    withDefect.critical_tests_pass?.state,
  );
} finally {
  for (const id of created.projects) await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  for (const id of created.accounts) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
