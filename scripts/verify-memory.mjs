// ═══════════════════════════════════════════════════════════════════════════
// Memory that cannot promote itself.
//
// Doc 05 §35: "Never store a model-generated assumption as a verified client
// fact without provenance." §18 defines the ladder — explicit, verified,
// inferred, temporary, stale, conflicted — and then the sentence that makes it
// a rule: "Only EXPLICIT/VERIFIED information should normally drive important
// business decisions without additional validation."
//
// Two of those are structural here and both are asserted against real
// Postgres: a claim to come from somewhere must say where, and an AGENT may
// never write `verified`. The second is the memory version of a producer
// verifying its own work.
// ═══════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: false });
announceTarget(target, 'a model-derived guess cannot become a client fact');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0;
function check(condition, description, detail = '') {
  console.log(`  ${condition ? '✓' : '✗'} ${description}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures += 1;
}

const otherOrgs = [];

const parse = (t) => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return t;
  }
};

async function rest(method, path, body, schema = 'ai') {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      // G-189's section needs one row in `core`, and a helper that can only
      // reach one schema is a helper that invites a second copy of itself.
      'Content-Profile': schema,
      'Accept-Profile': schema,
      Prefer: 'return=representation',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const remember = (over) =>
  rest('POST', 'memory_records', {
    organization_id: ORG,
    scope: 'organization',
    kind: 'preference',
    fact: 'The client prefers WhatsApp over email.',
    ...over,
  });

const written = [];

try {
  console.log('\n  A. a claim to come from somewhere must say where');

  const bare = await remember({ confidence: 'explicit' });
  check(
    !bare.ok && /provenance/.test(JSON.stringify(bare.json)),
    'explicit with no source is refused',
    bare.ok ? 'IT WAS ACCEPTED' : `${bare.status}`,
  );

  const bareVerified = await remember({ confidence: 'verified' });
  check(
    !bareVerified.ok && /provenance/.test(JSON.stringify(bareVerified.json)),
    'and so is verified',
    bareVerified.ok ? 'IT WAS ACCEPTED' : `${bareVerified.status}`,
  );

  const sourced = one(
    await remember({
      confidence: 'explicit',
      source_kind: 'crm.conversation_messages',
      source_id: randomUUID(),
    }),
  );
  check(Boolean(sourced?.id), 'with provenance it is accepted');
  if (sourced?.id) written.push(sourced.id);

  const guess = one(await remember({ confidence: 'inferred', fact: 'They are probably price-sensitive.' }));
  check(Boolean(guess?.id), 'an inference needs no source, because it claims none');
  if (guess?.id) written.push(guess.id);

  console.log('\n  B. an agent may not confirm its own inference');

  const agentVerified = await remember({
    confidence: 'verified',
    source_kind: 'ai.agent_runs',
    source_id: randomUUID(),
    authored_by_agent: 'requirement_collector',
  });
  check(
    !agentVerified.ok && /memory_agent_cannot_verify|cannot_verify/.test(JSON.stringify(agentVerified.json)),
    'even WITH provenance, an agent cannot write `verified`',
    agentVerified.ok ? 'IT WAS ACCEPTED' : `${agentVerified.status}`,
  );

  const agentGuess = one(
    await remember({
      confidence: 'inferred',
      fact: 'The client seems to want a vendor portal.',
      authored_by_agent: 'requirement_collector',
    }),
  );
  check(Boolean(agentGuess?.id), 'an agent may infer, which is the whole of what it may do');
  if (agentGuess?.id) written.push(agentGuess.id);

  const promote = await rest('PATCH', `memory_records?id=eq.${agentGuess.id}`, {
    confidence: 'explicit',
  });
  check(
    !promote.ok && /cannot become explicit/.test(JSON.stringify(promote.json)),
    'nor promote it afterwards — a client states a fact, an agent infers one',
    promote.ok ? 'IT WAS ACCEPTED' : `${promote.status}`,
  );

  console.log('\n  C. a correction supersedes, it does not overwrite');

  const corrected = one(
    await remember({
      confidence: 'explicit',
      fact: 'The client prefers email after all.',
      source_kind: 'crm.conversation_messages',
      source_id: randomUUID(),
    }),
  );
  if (corrected?.id) written.push(corrected.id);

  const supersede = await rest('PATCH', `memory_records?id=eq.${sourced.id}`, {
    superseded_by: corrected.id,
  });
  check(supersede.ok, 'the old fact is superseded by the new one', supersede.ok ? '' : `${supersede.status}`);

  const unsupersede = await rest('PATCH', `memory_records?id=eq.${sourced.id}`, { superseded_by: null });
  check(
    !unsupersede.ok && /stays superseded/.test(JSON.stringify(unsupersede.json)),
    'and cannot be un-superseded',
    unsupersede.ok ? 'IT WAS ACCEPTED' : `${unsupersede.status}`,
  );

  const editHistory = await rest('PATCH', `memory_records?id=eq.${sourced.id}`, {
    fact: 'Actually they never said that.',
  });
  check(
    !editHistory.ok && /history/.test(JSON.stringify(editHistory.json)),
    'nor edited — it is history now',
    editHistory.ok ? 'IT WAS ACCEPTED' : `${editHistory.status}`,
  );

  const deleted = await rest('DELETE', `memory_records?id=eq.${guess.id}`);
  check(
    !deleted.ok && /never deleted/.test(JSON.stringify(deleted.json)),
    'and no memory is deleted at all',
    deleted.ok ? 'IT WAS ACCEPTED' : `${deleted.status}`,
  );

  console.log('\n  D. recall returns what may be relied on, in that order');

  const recalled = await rest('POST', 'rpc/recall', { p_scope: 'organization', p_limit: 50 });
  const rows = Array.isArray(recalled.json) ? recalled.json : [];
  check(recalled.ok, 'recall answers for a scope', recalled.ok ? `${rows.length} rows` : `${recalled.status}`);

  check(
    !rows.some((r) => r.id === sourced.id),
    'a superseded memory is never returned',
    rows.some((r) => r.id === sourced.id) ? 'IT CAME BACK' : '',
  );

  const order = rows.map((r) => r.confidence);
  const rank = { explicit: 0, verified: 1, conflicted: 2, inferred: 3, temporary: 4, stale: 5 };
  check(
    order.every((c, i) => i === 0 || rank[order[i - 1]] <= rank[c]),
    'what a client said outranks what a model guessed',
    order.join(' → '),
  );

  console.log('\n  E. an expired memory stops being context');

  const expired = one(
    await remember({
      confidence: 'temporary',
      kind: 'task_note',
      fact: 'Waiting on the logo for this stage only.',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }),
  );
  if (expired?.id) written.push(expired.id);

  const after = await rest('POST', 'rpc/recall', { p_scope: 'organization', p_limit: 50 });
  check(
    !(Array.isArray(after.json) ? after.json : []).some((r) => r.id === expired.id),
    'it is stored, and it is not recalled',
  );

  // ── G-189: the recall names its tenant ─────────────────────────────────
  //
  // `ai.recall` is SECURITY INVOKER and filters by scope, never by
  // organization: RLS is its tenancy, which is right for a signed-in caller.
  // The job runner is not one — it reads this with the SERVICE ROLE, which
  // bypasses RLS — and the LIMIT is applied by the database before the caller
  // sees a row. So on a deployment with a second agency, the eight memories
  // the drafting prompt asks for were mostly somebody else's, and this
  // agency's own decisions fell off the end.
  //
  // Reproduced here rather than argued: ten memories for another agency, ten
  // for this one, and the two calls compared.
  console.log('\n  G-189 — the recall names its tenant');
  const other = one(await rest('POST', 'organizations', {
    name: 'zztest-memory other agency', slug: `zztest-memory-${randomUUID().slice(0, 8)}`,
  }, 'core'));
  check(Boolean(other?.id), 'a second agency exists to be confused with', String(other?.id).slice(0, 8));
  otherOrgs.push(other?.id);

  for (let i = 0; i < 10; i += 1) {
    const theirs = one(await rest('POST', 'memory_records', {
      organization_id: other?.id, scope: 'organization', scope_id: null,
      kind: 'pricing_decision', confidence: 'explicit',
      source_kind: 'sales.proposal', source_id: randomUUID(),
      fact: `zztest-memory another agency approved ₹99,000 as drafted (${i}).`,
    }));
    if (theirs?.id) written.push(theirs.id);
    const mine = one(await rest('POST', 'memory_records', {
      organization_id: ORG, scope: 'organization', scope_id: null,
      kind: 'pricing_decision', confidence: 'explicit',
      source_kind: 'sales.proposal', source_id: randomUUID(),
      fact: `zztest-memory this agency approved ₹45,000 as drafted (${i}).`,
    }));
    if (mine?.id) written.push(mine.id);
  }

  const unscoped = (await rest('POST', 'rpc/recall', { p_scope: 'organization', p_limit: 8 })).json ?? [];
  check(
    unscoped.some((r) => r.organization_id !== ORG),
    'unscoped, the service role is handed other agencies’ memories — the reason the parameter exists',
    `${unscoped.filter((r) => r.organization_id !== ORG).length} of ${unscoped.length} belong to somebody else`,
  );

  const scoped = (await rest('POST', 'rpc/recall', {
    p_scope: 'organization', p_limit: 8, p_organization_id: ORG,
  })).json ?? [];
  check(
    scoped.length === 8 && scoped.every((r) => r.organization_id === ORG),
    'scoped, all eight are this agency’s — the limit is spent on rows it can use',
    `${scoped.filter((r) => r.organization_id === ORG).length}/${scoped.length}`,
  );
  check(
    scoped.every((r) => !String(r.fact).includes('another agency')),
    'and not one of them is another agency’s decision',
  );

  // ── G-199 ────────────────────────────────────────────────────────────────
  //
  // A returning client is remembered (Doc 05 §4).
  //
  // The `client` scope has existed since this table was created and had never
  // held a row. Everything the agency knew was attached to a LEAD, and a lead
  // ends — so a client who came back met an agency that had forgotten them.
  //
  // Winning the deal is what makes somebody a client, and §18 says a VERIFIED
  // fact is one "confirmed by an authoritative business process". The win is
  // that process, so the promotion is a trigger on that transition: it cannot
  // be reached through language, which is what this table was built around.
  console.log('\n  G-199 — winning a deal is what makes a client remembered');

  const rc = { contact: null, lead: null, opp: null };
  rc.contact = one(await rest('POST', 'contacts', {
    organization_id: ORG, full_name: 'zztest-memory returning client',
    phone: `+9197${String(Date.now()).slice(-8)}`,
  }, 'crm'))?.id;
  rc.lead = one(await rest('POST', 'leads', {
    organization_id: ORG, contact_id: rc.contact, title: 'zztest-memory first project',
    source: 'whatsapp', source_ref: `zztest-memory:${randomUUID().slice(0, 8)}`, status: 'new',
  }, 'crm'))?.id;
  check(Boolean(rc.lead), 'a lead exists, with a contact behind it', rc.lead ? 'planted' : 'refused');

  // Three lead memories, and the difference between them is the whole test:
  // what the client SAID, what a model GUESSED, and one that was corrected.
  const said = one(await rest('POST', 'memory_records', {
    organization_id: ORG, scope: 'lead', scope_id: rc.lead,
    kind: 'business', confidence: 'explicit',
    source_kind: 'crm.conversation_message', source_id: randomUUID(),
    fact: 'zztest-memory they run three tiffin kitchens in Pune.',
    authored_by_agent: 'sales',
  }));
  written.push(said?.id);
  const guessed = one(await rest('POST', 'memory_records', {
    organization_id: ORG, scope: 'lead', scope_id: rc.lead,
    kind: 'budget_band', confidence: 'inferred',
    fact: 'zztest-memory they can probably afford a larger build.',
    authored_by_agent: 'sales',
  }));
  written.push(guessed?.id);
  check(Boolean(said?.id) && Boolean(guessed?.id), 'one thing they said, one thing a model guessed');

  const noneYet = await rest('GET', `memory_records?scope=eq.client&scope_id=eq.${rc.contact}&select=id`);
  check((noneYet.json ?? []).length === 0, 'and nothing is known about them as a CLIENT yet', `${(noneYet.json ?? []).length} row(s)`);

  rc.opp = one(await rest('POST', 'opportunities', {
    organization_id: ORG, lead_id: rc.lead, name: 'zztest-memory tiffin ordering app', stage: 'discovery',
  }, 'sales'))?.id;
  check(Boolean(rc.opp), 'a deal is opened on it', rc.opp ? 'opened' : 'refused');

  // Nothing yet: the deal exists and has not been won.
  const stillNone = await rest('GET', `memory_records?scope=eq.client&scope_id=eq.${rc.contact}&select=id`);
  check((stillNone.json ?? []).length === 0, 'an OPEN deal remembers nothing — it is the win that matters', `${(stillNone.json ?? []).length} row(s)`);

  const won = await rest('PATCH', `opportunities?id=eq.${rc.opp}`, {
    stage: 'won', closed_at: new Date().toISOString(),
  }, 'sales');
  check(won.ok, 'the deal is won', `HTTP ${won.status}`);

  const clientFacts = (await rest('GET',
    `memory_records?scope=eq.client&scope_id=eq.${rc.contact}&select=kind,fact,confidence,source_kind,authored_by_agent`)).json ?? [];
  for (const row of (await rest('GET', `memory_records?scope=eq.client&scope_id=eq.${rc.contact}&select=id`)).json ?? []) {
    written.push(row.id);
  }

  const becameAClient = clientFacts.find((f) => f.kind === 'became_a_client');
  check(Boolean(becameAClient), 'the win itself becomes a client fact', becameAClient ? String(becameAClient.fact).slice(0, 52) : 'nothing written');
  check(
    becameAClient?.confidence === 'verified' && becameAClient?.authored_by_agent === null,
    'VERIFIED, and authored by no agent — the transition is the authority, not a model',
    `${becameAClient?.confidence}/${becameAClient?.authored_by_agent}`,
  );
  check(
    becameAClient?.source_kind === 'sales.opportunity',
    'pointing at the deal it was confirmed by',
    String(becameAClient?.source_kind),
  );

  const carried = clientFacts.find((f) => f.kind === 'business');
  check(Boolean(carried), 'and what the client SAID is carried across', carried ? String(carried.fact).slice(0, 46) : 'not carried');
  check(
    carried?.confidence === 'explicit' && carried?.authored_by_agent === 'sales',
    'at its own confidence and with its own author — winning does not make a sentence truer',
    `${carried?.confidence}/${carried?.authored_by_agent}`,
  );

  // The twin, and the one Doc 05 §35 is actually about.
  check(
    !clientFacts.some((f) => f.confidence === 'inferred'),
    'while a model’s GUESS is left behind — carrying one is how a guess becomes a permanent client fact',
    clientFacts.map((f) => f.confidence).join(', '),
  );

  /**
   * Once, on the TRANSITION — and this needs a fact the win never saw.
   *
   * The first version of this check only touched the won deal again and
   * counted rows, which the idempotency guard satisfies on its own: two
   * controls, one test, and removing the transition check changed nothing
   * observable. So a NEW lead fact is recorded after the win, and then the
   * deal is touched. The promotion happened once, at the win; a later
   * unrelated write must not sweep in something learned since.
   */
  const afterTheWin = one(await rest('POST', 'memory_records', {
    organization_id: ORG, scope: 'lead', scope_id: rc.lead,
    kind: 'preference', confidence: 'explicit',
    source_kind: 'crm.conversation_message', source_id: randomUUID(),
    fact: 'zztest-memory they said afterwards that they prefer evening calls.',
    authored_by_agent: 'sales',
  }));
  written.push(afterTheWin?.id);
  check(Boolean(afterTheWin?.id), 'something is learned about the lead AFTER the win');

  await rest('PATCH', `opportunities?id=eq.${rc.opp}`, { name: 'zztest-memory tiffin ordering app (v2)' }, 'sales');
  await rest('PATCH', `opportunities?id=eq.${rc.opp}`, { stage: 'won' }, 'sales');
  const afterTouching = (await rest('GET',
    `memory_records?scope=eq.client&scope_id=eq.${rc.contact}&select=id,fact`)).json ?? [];
  check(
    afterTouching.length === clientFacts.length,
    'and touching the won deal again writes nothing more — the transition, not the state',
    `${clientFacts.length} → ${afterTouching.length} row(s)`,
  );
  check(
    !afterTouching.some((f) => String(f.fact).includes('prefer evening calls')),
    'not even the thing learned since — a promotion happens at the win, not on every later write',
    afterTouching.some((f) => String(f.fact).includes('prefer evening calls')) ? 'swept in' : 'left on the lead',
  );

  // And the point of all of it: the SECOND lead starts knowing them.
  const recalledClient = await rest('POST', 'rpc/recall', {
    p_scope: 'client', p_scope_id: rc.contact, p_limit: 8, p_organization_id: ORG,
  });
  check(
    (recalledClient.json ?? []).length === clientFacts.length,
    'a recall for this client returns what the agency remembers about them',
    `${(recalledClient.json ?? []).length} of ${clientFacts.length}`,
  );

  await rest('DELETE', `opportunities?id=eq.${rc.opp}`, undefined, 'sales');
  await rest('DELETE', `leads?id=eq.${rc.lead}`, undefined, 'crm');
  await rest('DELETE', `contacts?id=eq.${rc.contact}`, undefined, 'crm');


} finally {
  // Deliberately not deleted — the table refuses it, which is the point of
  // check C. Superseded into a marker instead, so a re-run is clean and the
  // history stays intact.
  for (const id of written) {
    await rest('PATCH', `memory_records?id=eq.${id}`, { kind: 'zztest-memory' }).catch(() => {});
  }
  /**
   * The second agency goes, and its memories cascade with it — G-190.
   *
   * Not `.catch(() => {})`. The first version swallowed the refusal this
   * cleanup was hitting (the trigger refused every DELETE, cascade included),
   * left the organization behind, and two later scripts in the CI chain failed
   * on the residue. A cleanup that cannot fail is a cleanup nobody can see
   * failing.
   */
  for (const id of otherOrgs.filter(Boolean)) {
    const gone = await rest('DELETE', `organizations?id=eq.${id}`, undefined, 'core');
    check(gone.ok, 'the second agency is removed, and its memories with it', `HTTP ${gone.status}`);
  }
  const left = await rest('GET', 'organizations?slug=like.zztest-memory-*&select=id', undefined, 'core');
  check(
    (left.json ?? []).length === 0,
    'nothing of it is left for the next script in the chain to trip over',
    `${(left.json ?? []).length} organization(s)`,
  );
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
