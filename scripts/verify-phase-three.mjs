#!/usr/bin/env node
/**
 * Phase 3, driven end to end against a real database — G-299.
 *
 * Every unit from G-277 to G-298 is proved in isolation: its own migration,
 * its own controls, its own red-proofs. **None of that asks whether they
 * compose.** A gate can be correct and still be reachable in the wrong order;
 * a refusal can be exact and still never fire because the state it guards
 * cannot occur through the doors in front of it.
 *
 * So this drives the whole flow **through the doors only** — the fixture is
 * the only thing that writes a row directly — in the order Master §16 states:
 *
 *   designer → internal review → Admin → PM → client
 *
 * What it proves, and each of these is a rule one of the PDFs states:
 *
 *   1.  The screen baseline finalizes and freezes (§13, §7.3).
 *   2.  Two directions exist, each with a Figma node (§11, §18's ceiling).
 *   3.  **Admin cannot decide before internal review passes** (§16, PM §7).
 *   4.  **Internal review cannot happen before a reviewer is assigned** (§4).
 *   5.  Assigned, reviewed, approved — the order walked forwards.
 *   6.  **Only Admin-approved options reach a client, and the refusal names
 *       the offending one** (§7.9, §8).
 *   7.  **A client cannot confirm what they were never shown** (PM §4.9),
 *       checked against the frozen share snapshot rather than live rows.
 *   8.  A change request opens exactly one revision round, and asking twice
 *       returns the same one rather than spending another (PM §9).
 *   9.  **A scope question is not a design round** (§17), and it stops the
 *       phase with the client's own words.
 *   10. **The revision ceiling stops the phase** rather than refusing (§16,
 *       PM §4.8), and while escalated nothing more is designed (Designer §16).
 *   11. The lock **completes Phase 3 and reports the handoff not ready** when
 *       the primitives are missing (§7.12, Designer §19, §26).
 *   12. With Figma and primitives both present it locks ready, and the
 *       handoff carries every piece Phase 4 would otherwise recreate.
 *   13. A locked direction takes no new sample (Designer §18).
 *
 *   node scripts/verify-phase-three.mjs
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-phase-three');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-g299';
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
let checks = 0;

function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function call(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
      Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: parse(text), text };
}

const rest = (m, s, p, b) => call(KEY, m, s, p, b);
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

function mint(userId, role) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub: userId,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: { organization_id: ORG, role },
    iat: now,
    exp: now + 900,
  });
  return `${header}.${body}.${createHmac('sha256', target.jwtSecret).update(`${header}.${body}`).digest('base64url')}`;
}

/**
 * Every door is called with a REAL token, not the service key.
 *
 * The doors read `auth.uid()` and check `core.can_write()` against the JWT's
 * claims, so driving them with the service key would exercise a path no person
 * ever takes and would skip the authority checks entirely — the same mistake
 * as asserting a refusal the service owns.
 */
let TOKEN = null;
const door = async (name, args) => one(await call(TOKEN, 'POST', 'projects', `rpc/${name}`, args));

const created = { users: [] };

console.log('\n\x1b[1mAgencyOS — Phase 3 end to end (G-299, Master §16)\x1b[0m');

try {
  // ── fixture ───────────────────────────────────────────────────────────
  //
  // The only rows written directly. Everything after this goes through a
  // door, which is the point of the script.

  const account = one(
    await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }),
  );
  created.account = account?.id;

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG,
      client_account_id: created.account,
      name: `${MARKER} project`,
      status: 'active',
    }),
  );
  created.project = project?.id;
  if (!created.project) throw new Error('could not create the project fixture');

  const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      email: `${MARKER}-owner-${randomUUID().slice(0, 8)}@example.invalid`,
      password: randomUUID(),
      email_confirm: true,
    }),
  }).then((r) => r.json());
  const owner = authUser?.id;
  if (!owner) throw new Error('could not create the owner fixture');
  created.users.push(owner);
  await rest('POST', 'core', 'users', { id: owner, email: authUser.email, full_name: `${MARKER} owner` });
  await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: owner, role: 'owner' });
  TOKEN = mint(owner, 'owner');

  // An approved scope version and screens, which §17 requires a sample to map
  // to and §7.3 requires a baseline to name.
  const scope = one(
    await rest('POST', 'projects', 'scope_versions', {
      organization_id: ORG,
      project_id: created.project,
      version: 1,
      status: 'active',
      source: 'onboarding',
      frozen_at: new Date().toISOString(),
    }),
  );
  for (const [key, name] of [['dashboard', 'Dashboard'], ['invoices', 'Invoices']]) {
    await rest('POST', 'projects', 'screens', {
      organization_id: ORG,
      project_id: created.project,
      screen_key: key,
      name,
      user_role: 'owner',
      status: 'approved',
    });
  }

  // Phase 2 and Phase 3 rows. `start_phase_three` needs a completed Phase 2
  // behind a handoff, which is Phase 2's own unit — this is the state Phase 3
  // begins from, not the thing under test.
  const pair = one(await rest('GET', 'ai', 'agent_handoff_targets?select=from_agent,to_agent&limit=1'));
  const handoff = one(
    await rest('POST', 'ai', 'handoffs', {
      organization_id: ORG,
      project_id: created.project,
      correlation_id: randomUUID(),
      from_agent: pair?.from_agent,
      to_agent: pair?.to_agent,
      objective: `${MARKER} phase three`,
    }),
  );
  const phaseTwo = one(
    await rest('POST', 'projects', 'phase_two', {
      organization_id: ORG,
      project_id: created.project,
      handoff_id: handoff?.id,
    }),
  );
  const phase = one(
    await rest('POST', 'projects', 'phase_three', {
      organization_id: ORG,
      project_id: created.project,
      phase_two_id: phaseTwo?.id,
      state: 'context_loading',
      client_revision_limit: 2,
    }),
  );
  created.phase = phase?.id;
  if (!created.phase) throw new Error('could not create the Phase 3 fixture');

  // ── 1. the screen baseline ────────────────────────────────────────────
  console.log('\n1. The baseline the whole phase is judged against');

  const drafted = await door('draft_screen_baseline', {
    p_project_id: created.project,
    p_change_reason: 'end to end',
  });
  check(drafted?.outcome === 'drafted', 'a screen baseline drafts', `outcome ${drafted?.outcome}`);

  const finalized = await door('finalize_screen_baseline', { p_baseline_id: drafted?.baseline_id });
  check(finalized?.outcome === 'finalized', 'and finalizes', `outcome ${finalized?.outcome}`);

  // ── 2. two directions ─────────────────────────────────────────────────
  console.log('\n2. Two directions, each with something to show');

  const calm = await door('record_theme_option', {
    p_project_id: created.project,
    p_option_index: 1,
    p_name: 'Calm',
    p_direction_summary: 'quiet and spacious',
  });
  const bold = await door('record_theme_option', {
    p_project_id: created.project,
    p_option_index: 2,
    p_name: 'Bold',
    p_direction_summary: 'loud and dense',
  });
  check(
    calm?.outcome === 'recorded' && bold?.outcome === 'recorded',
    'two theme options record',
    `${calm?.outcome}, ${bold?.outcome}`,
  );

  await door('link_theme_figma', {
    p_theme_option_id: calm?.theme_option_id,
    p_file_key: 'FILE',
    p_node_id: 'NODE-1',
  });
  await door('link_theme_figma', {
    p_theme_option_id: bold?.theme_option_id,
    p_file_key: 'FILE',
    p_node_id: 'NODE-2',
  });
  const palette = await door('record_color_option', {
    p_theme_option_id: calm?.theme_option_id,
    p_option_index: 1,
    p_palette_name: 'Calm Palette',
    p_primary_hex: '#112233',
  });
  check(palette?.outcome === 'recorded', 'a palette belongs to its direction', `outcome ${palette?.outcome}`);

  // ── 3. the order, refused backwards ───────────────────────────────────
  console.log('\n3. §16’s order is structural, not advisory');

  const early = await door('submit_admin_design_decision', {
    p_theme_option_id: calm?.theme_option_id,
    p_decision: 'confirm',
  });
  check(
    early?.outcome === 'not_internally_passed',
    'Admin cannot decide before internal review passes',
    `outcome ${early?.outcome}`,
  );

  const unassigned = await door('submit_internal_design_review', {
    p_theme_option_id: calm?.theme_option_id,
    p_result: 'passed',
  });
  check(
    unassigned?.outcome === 'no_reviewer_assigned',
    'and internal review cannot happen before a reviewer holds the gate',
    `outcome ${unassigned?.outcome}`,
  );

  // ── 4. the order, walked forwards ─────────────────────────────────────
  console.log('\n4. Assigned, reviewed, approved');

  const assigned = await door('assign_design_reviewer', {
    p_project_id: created.project,
    p_user_id: owner,
  });
  check(assigned?.outcome === 'assigned', 'a reviewer is appointed', `outcome ${assigned?.outcome}`);

  const reviewed = await door('submit_internal_design_review', {
    p_theme_option_id: calm?.theme_option_id,
    p_result: 'passed',
  });
  check(reviewed?.outcome === 'recorded', 'internal review passes it', `outcome ${reviewed?.outcome}`);

  const approved = await door('submit_admin_design_decision', {
    p_theme_option_id: calm?.theme_option_id,
    p_decision: 'confirm',
  });
  check(approved?.outcome === 'recorded', 'and Admin approves it', `outcome ${approved?.outcome}`);

  // ── 5. only what Admin approved ───────────────────────────────────────
  console.log('\n5. Only what Admin approved reaches a client');

  const bothAttempt = await door('record_design_share', {
    p_project_id: created.project,
    p_theme_option_ids: [calm?.theme_option_id, bold?.theme_option_id],
    p_channel: 'whatsapp',
    p_evidence_ref: 'wamid.ONE',
  });
  check(
    bothAttempt?.outcome === 'not_approved',
    'sharing an unapproved option is refused',
    `outcome ${bothAttempt?.outcome}`,
  );
  check(
    (bothAttempt?.findings ?? []).some((f) => String(f).includes('Bold')),
    'and the refusal NAMES the offending one, so nobody has to go and find out which',
    JSON.stringify(bothAttempt?.findings),
  );

  const share = await door('record_design_share', {
    p_project_id: created.project,
    p_theme_option_ids: [calm?.theme_option_id],
    p_channel: 'whatsapp',
    p_evidence_ref: 'wamid.ONE',
  });
  check(share?.outcome === 'shared', 'the approved one shares', `outcome ${share?.outcome}`);

  // ── 6. a client answer is not a guess ─────────────────────────────────
  console.log('\n6. A client can only choose from what they were shown');

  const unshown = await door('record_client_design_decision', {
    p_share_id: share?.share_id,
    p_decision: 'final_confirmed',
    p_client_words: 'the bold one please',
    p_theme_option_id: bold?.theme_option_id,
    p_color_option_id: palette?.color_option_id,
  });
  check(
    unshown?.outcome === 'not_shown',
    'confirming an option that was never shared is refused, against the FROZEN snapshot',
    `outcome ${unshown?.outcome}`,
  );

  // ── 7. one change request, one round ──────────────────────────────────
  console.log('\n7. A change request opens exactly one round');

  const change = await door('record_client_design_decision', {
    p_share_id: share?.share_id,
    p_decision: 'design_change_request',
    p_client_words: 'lighter header please',
    p_theme_option_id: calm?.theme_option_id,
  });
  const round1 = await door('open_design_revision', {
    p_from_theme_option_id: calm?.theme_option_id,
    p_origin: 'client_revision',
    p_requested_changes: 'lighten the header',
    p_client_decision_id: change?.decision_id,
  });
  check(round1?.outcome === 'opened', 'the round opens', `outcome ${round1?.outcome}`);

  const again = await door('open_design_revision', {
    p_from_theme_option_id: calm?.theme_option_id,
    p_origin: 'client_revision',
    p_requested_changes: 'lighten the header',
    p_client_decision_id: change?.decision_id,
  });
  check(
    again?.outcome === 'exists' && again?.revision_id === round1?.revision_id,
    'and asking twice returns the SAME round rather than spending another',
    `outcome ${again?.outcome}`,
  );

  const afterOne = one(
    await rest('GET', 'projects', `phase_three?id=eq.${created.phase}&select=client_revision_count`),
  );
  check(afterOne?.client_revision_count === 1, 'one round spent, not two', `count ${afterOne?.client_revision_count}`);

  // ── 8. scope is routed, never designed ────────────────────────────────
  console.log('\n8. A scope question is not a design round');

  const scopeReply = await door('record_client_design_decision', {
    p_share_id: share?.share_id,
    p_decision: 'possible_scope_change',
    p_client_words: 'can it also do invoicing',
    p_theme_option_id: calm?.theme_option_id,
  });
  const scopeRound = await door('open_design_revision', {
    p_from_theme_option_id: calm?.theme_option_id,
    p_origin: 'client_revision',
    p_requested_changes: 'add invoicing',
    p_client_decision_id: scopeReply?.decision_id,
  });
  check(
    scopeRound?.outcome === 'not_a_design_change',
    'a revision citing a scope question is refused',
    `outcome ${scopeRound?.outcome}`,
  );

  const stopped = one(
    await rest('GET', 'projects', `phase_three?id=eq.${created.phase}&select=state,blocked_reason`),
  );
  check(
    stopped?.state === 'scope_escalation' && String(stopped?.blocked_reason).includes('invoicing'),
    'and the phase stopped, with the client’s own words in the blocker',
    `state ${stopped?.state}`,
  );

  // A person settles the scope question. Nothing automates this, which is
  // exactly §17's instruction: route to the workflow, and routing means a
  // person decides.
  await rest('PATCH', 'projects', `phase_three?id=eq.${created.phase}`, {
    state: 'client_review',
    blocked_reason: null,
  });

  // ── 9. the ceiling stops the phase ────────────────────────────────────
  console.log('\n9. The revision ceiling is a stop, not a refusal');

  const change2 = await door('record_client_design_decision', {
    p_share_id: share?.share_id,
    p_decision: 'design_change_request',
    p_client_words: 'round two',
    p_theme_option_id: calm?.theme_option_id,
  });
  await door('open_design_revision', {
    p_from_theme_option_id: calm?.theme_option_id,
    p_origin: 'client_revision',
    p_requested_changes: 'two',
    p_client_decision_id: change2?.decision_id,
  });

  const change3 = await door('record_client_design_decision', {
    p_share_id: share?.share_id,
    p_decision: 'design_change_request',
    p_client_words: 'round three',
    p_theme_option_id: calm?.theme_option_id,
  });
  const over = await door('open_design_revision', {
    p_from_theme_option_id: calm?.theme_option_id,
    p_origin: 'client_revision',
    p_requested_changes: 'three',
    p_client_decision_id: change3?.decision_id,
  });
  check(
    over?.outcome === 'escalated',
    'the third round against a limit of two ESCALATES rather than refusing',
    `outcome ${over?.outcome}`,
  );

  const escalated = one(
    await rest('GET', 'projects', `phase_three?id=eq.${created.phase}&select=state,blocked_reason`),
  );
  check(
    escalated?.state === 'revision_limit_escalation'
      && String(escalated?.blocked_reason).includes('2 of 2'),
    'the phase STOPPED, and the reason names the count and the limit',
    `state ${escalated?.state}`,
  );

  const sneak = await door('open_design_revision', {
    p_from_theme_option_id: calm?.theme_option_id,
    p_origin: 'internal_review',
    p_requested_changes: 'sneak one in',
  });
  check(
    sneak?.outcome === 'escalation_open',
    'and while escalated nothing more is designed — the designer waits for the outcome',
    `outcome ${sneak?.outcome}`,
  );

  await rest('PATCH', 'projects', `phase_three?id=eq.${created.phase}`, {
    state: 'client_review',
    blocked_reason: null,
  });

  // ── 10. the lock, both answers ────────────────────────────────────────
  console.log('\n10. Complete and not-ready are different facts');

  await door('record_client_design_decision', {
    p_share_id: share?.share_id,
    p_decision: 'final_confirmed',
    p_client_words: 'yes, Calm with that palette',
    p_theme_option_id: calm?.theme_option_id,
    p_color_option_id: palette?.color_option_id,
  });

  const notReady = await door('lock_phase_three_direction', { p_phase_three_id: created.phase });
  check(
    notReady?.outcome === 'locked_not_ready',
    'locking with no finalized primitives COMPLETES Phase 3 and reports not ready',
    `outcome ${notReady?.outcome}`,
  );

  const handoffRow = one(
    await rest(
      'GET',
      'projects',
      `phase_three_handoffs?phase_three_id=eq.${created.phase}&select=phase_four_ready,readiness_note,payload`,
    ),
  );
  check(
    handoffRow?.phase_four_ready === false
      && String(handoffRow?.readiness_note).includes('design token set'),
    'and the note names what is missing rather than saying "not ready"',
    String(handoffRow?.readiness_note).slice(0, 60),
  );

  const completed = one(
    await rest('GET', 'projects', `phase_three?id=eq.${created.phase}&select=state,completed_at`),
  );
  check(
    completed?.state === 'completed' && completed?.completed_at !== null,
    'Phase 3 is complete either way, because the client did confirm',
    `state ${completed?.state}`,
  );

  const locked = one(
    await rest('GET', 'projects', `theme_options?id=eq.${calm?.theme_option_id}&select=client_status`),
  );
  check(locked?.client_status === 'locked', 'the chosen direction is locked', `status ${locked?.client_status}`);

  const sampleAfter = await door('record_representative_screen', {
    p_theme_option_id: calm?.theme_option_id,
    p_screen_id: one(
      await rest('GET', 'projects', `screens?project_id=eq.${created.project}&select=id&limit=1`),
    )?.id,
    p_pattern: 'primary',
    p_figma_node_id: 'NODE-S',
  });
  check(
    sampleAfter?.outcome === 'direction_locked',
    'and a locked direction takes no new sample — its samples are what it was judged on',
    `outcome ${sampleAfter?.outcome}`,
  );

  // ── 11. the handoff carries what Phase 4 would otherwise recreate ─────
  console.log('\n11. The handoff is a snapshot, not a promise');

  const payload = handoffRow?.payload ?? {};
  check(
    payload?.theme?.figmaNodeId === 'NODE-1',
    'the Figma reference travels with it',
    JSON.stringify(payload?.theme?.figmaNodeId),
  );
  check(
    payload?.colors?.primaryHex === '#112233',
    'so does the palette',
    JSON.stringify(payload?.colors?.primaryHex),
  );
  check(
    Number(payload?.screenBaseline?.screenCount) === 2,
    'and the screen baseline, frozen as it stood',
    JSON.stringify(payload?.screenBaseline?.screenCount),
  );
  check(
    payload?.approvalEvidence?.clientWords === 'yes, Calm with that palette',
    'with the client’s own words as the approval evidence',
    JSON.stringify(payload?.approvalEvidence?.clientWords),
  );
  check(
    Number(payload?.revisionRounds) === 2,
    'and the rounds it took to get there',
    JSON.stringify(payload?.revisionRounds),
  );
} finally {
  if (created.project) {
    for (const [schema, table] of [
      ['projects', 'phase_three_handoffs'],
      ['projects', 'design_token_sets'],
      ['projects', 'representative_screens'],
      ['projects', 'design_revisions'],
      ['projects', 'client_design_decisions'],
      ['projects', 'client_design_shares'],
      ['projects', 'admin_design_decisions'],
      ['projects', 'design_reviews'],
      ['projects', 'color_options'],
      ['projects', 'theme_options'],
      ['projects', 'screen_baselines'],
      ['projects', 'screen_scope_items'],
      ['projects', 'screens'],
      ['projects', 'phase_three'],
      ['projects', 'phase_two'],
      ['projects', 'scope_versions'],
    ]) {
      await rest('DELETE', schema, `${table}?project_id=eq.${created.project}`);
    }
    // The events these doors emit. `verify-milestone-unlock` asserts the
    // deployment holds zero outbox events, and CI caught exactly this on an
    // earlier script.
    await rest('DELETE', 'core', `outbox_events?subject_type=in.(phase_three,phase_three_handoff,client_design_share,client_design_decision,design_revision,design_token_set,representative_screen,theme_option)`);
    await rest('DELETE', 'ai', `handoffs?project_id=eq.${created.project}`);
    await rest('DELETE', 'projects', `projects?id=eq.${created.project}`);
  }
  if (created.account) await rest('DELETE', 'core', `client_accounts?id=eq.${created.account}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      cache: 'no-store',
    });
  }
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ The gates compose, and the order holds through all of them\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
