// ═══════════════════════════════════════════════════════════════════════════
// A second agent can be reached.
//
// ADM-82 granted thirteen agents. Twelve were installed disabled, and enabling
// any of them would have changed nothing: the job runner named one agent in a
// module-level constant, so there was no queue to feed the others from.
//
// This drives the whole path for the second one, against the real app: a
// maintenance ticket is raised → `support_ticket.created` is emitted where the
// row lands → the dispatcher turns it into a `maintenance.triage` job → the
// runner claims it, resolves `support` from the registry, and applies the same
// autonomy gate the first agent passes through.
//
// The model call itself is not asserted — no provider is configured here, and
// the honest end of this path in CI is "the agent was reached and reported
// that it has no provider". That is exactly the failure the first agent
// spent 33 runs producing, and it is recorded the same way.
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

// `jwt: true` because one thing this script proves needs a PERSON. A handover
// is accepted only through `decide_approval`, which refuses a caller with no
// `auth.uid()` — deliberately, since accepting on a client's behalf is the
// forgery that guard exists to stop. Everything else here runs as the service
// role, the way the runner does.
const target = await resolveTarget(fail, { cron: true, anon: false, jwt: true });
announceTarget(target, 'work reaches the agent it names');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-dispatch';
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

async function asUser(token, method, schema, path, body) {
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
  return { ok: res.ok, status: res.status, json: parse(text), text };
}

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

/** One tick of the cron route — the same entry point Vercel calls. */
async function tick() {
  const res = await fetch(`${target.app}/api/jobs/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.cronSecret}` },
    cache: 'no-store',
  });
  return { status: res.status, json: parse(await res.text()) };
}

const created = { projects: [], clients: [], items: [], policies: [], leads: [], versions: [], users: [] };

try {
  console.log('\n  A. both halves of the roster are honest');

  const agents = await rest('GET', 'ai', 'agents?select=key,enabled,disabled_reason&order=key');
  const rows = Array.isArray(agents.json) ? agents.json : [];
  const enabled = rows.filter((a) => a.enabled).map((a) => a.key);
  check(
    enabled.includes('requirement_collector') && enabled.includes('support'),
    'the agents with a workflow are enabled',
    enabled.join(', '),
  );
  check(
    rows.filter((a) => !a.enabled).every((a) => (a.disabled_reason ?? '').trim() !== ''),
    'and every disabled one still says why it cannot run',
    `${rows.filter((a) => !a.enabled).length} disabled`,
  );

  console.log('\n  B. a ticket is raised, and the event lands with it');

  const client = one(
    await rest('POST', 'core', 'client_accounts', { organization_id: ORG, name: `${MARKER} client` }),
  );
  created.clients.push(client.id);

  const project = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: client.id,
      name: `${MARKER} ${randomUUID().slice(0, 8)}`, status: 'completed',
    }),
  );
  created.projects.push(project.id);

  const lead = one(
    await rest('POST', 'crm', 'leads', {
      organization_id: ORG, title: `${MARKER} storefront`, source: 'web_form', status: 'new',
    }),
  );
  created.leads.push(lead.id);

  // `enforce_post_handover` refuses a maintenance item on a project that was
  // never delivered — maintenance is what comes AFTER handover, and an item
  // filed before it is delivery work in the wrong place. Through
  // `deliver_handover`, because `handovers_guard` refuses a status written
  // around it.
  const handover = one(
    await rest('POST', 'projects', 'handovers', { organization_id: ORG, project_id: project.id }),
  );
  await rest('POST', 'projects', 'handover_items', {
    organization_id: ORG, handover_id: handover.id, kind: 'repository', label: 'Repo',
  });
  const policy = await rest(
    'GET', 'approvals',
    `approval_policies?organization_id=eq.${ORG}&subject_type=eq.handover&min_amount_minor=eq.0&select=id`,
  );
  if (Array.isArray(policy.json) && policy.json.length === 0) {
    const written = one(
      await rest('POST', 'approvals', 'approval_policies', {
        organization_id: ORG, subject_type: 'handover', min_amount_minor: 0,
        required_role: 'ops_admin', sla_hours: 48, audience: 'client',
      }),
    );
    if (written?.id) created.policies.push(written.id);
  }
  const delivered = one(
    await rest('POST', 'projects', 'rpc/deliver_handover', { p_handover_id: handover.id }),
  );
  check(delivered?.outcome === 'delivered', 'the project has been handed over', delivered?.outcome);

  const ticket = one(
    await rest('POST', 'projects', 'maintenance_items', {
      organization_id: ORG, client_account_id: client.id, project_id: project.id,
      title: `${MARKER} the checkout page fails on Safari`,
      description: 'Since the last release, tapping Pay on Safari 17 does nothing and the console shows a null reference.',
      status: 'open',
    }),
  );
  check(Boolean(ticket?.id), 'the ticket exists', ticket?.id ? '' : JSON.stringify(ticket).slice(0, 140));
  if (ticket?.id) created.items.push(ticket.id);

  const events = await rest(
    'GET', 'core',
    `outbox_events?subject_id=eq.${ticket.id}&select=id,type,subject_type`,
  );
  const evented = Array.isArray(events.json) ? events.json : [];
  check(
    evented.some((e) => e.type === 'support_ticket.created'),
    'SupportTicketCreated is emitted where the row lands — Doc 23 §7',
    evented.map((e) => e.type).join(', ') || 'nothing',
  );
  check(
    evented.length > 0 && evented.every((e) => e.subject_type === 'maintenance_item'),
    'and names the ticket, so the agent does not have to guess its subject',
    `${evented.length} event(s)`,
  );

  console.log('\n  C. one tick turns it into work for the agent that was named');

  const first = await tick();
  check(first.status === 200, 'the tick answers', `HTTP ${first.status}`);

  // The SAME tick may already have run it: the outbox is dispatched before the
  // claim, so a job enqueued at the top of a tick is claimable at the bottom of
  // it. A first draft ignored this tick's own answer and looked only at later
  // ones, then reported that no tick had dispatched to an agent while the run
  // row it went on to assert was sitting there.
  let outcome = first.json?.agent ? first.json : null;

  const job = one(
    await rest('GET', 'core', `jobs?kind=eq.maintenance.triage&select=id,kind,status,payload,attempts,last_error&order=created_at.desc&limit=1`),
  );
  check(Boolean(job?.id), 'a maintenance.triage job was enqueued from the event');
  check(
    Boolean(ticket?.id) && job?.payload?.subjectId === ticket.id,
    'carrying the ticket it is about',
    String(job?.payload?.subjectId),
  );

  console.log('\n  D. and the runner reaches the SUPPORT agent, not the only one it used to know');

  // Ticks until the triage job is claimed: the runner takes one agent job per
  // invocation and requirement.extract is tried first, so a queued extraction
  // would otherwise be mistaken for the triage job never being reached.
  for (let i = 0; i < 6 && !outcome; i += 1) {
    const t = await tick();
    if (t.json?.agent) outcome = t.json;
  }

  check(Boolean(outcome), 'the tick reports which agent it dispatched to', outcome?.agent ?? 'none');
  check(outcome?.agent === 'support', 'and it is support', outcome?.agent);

  const run = one(
    await rest('GET', 'ai', `agent_runs?agent_key=eq.support&subject_id=eq.${ticket.id}&select=id,status,error,subject_type&order=created_at.desc&limit=1`),
  );
  check(Boolean(run?.id), 'an agent run exists for it', run?.status ?? 'none');
  check(
    run?.subject_type === 'projects.maintenance_item',
    'against the ticket, not the conversation the other agent reads',
    run?.subject_type,
  );

  // With no provider configured, the honest end of this path is a recorded
  // failure naming the reason — the same one the first agent produced 33 times
  // before anybody could see it.
  check(
    run?.status === 'succeeded' || (run?.error ?? '').length > 0,
    'and it either did the work or said in writing why it could not',
    run?.status === 'succeeded' ? 'succeeded' : (run?.error ?? '').slice(0, 60),
  );

  // ── D2 ──────────────────────────────────────────────────────────────────
  console.log('\n  D2. and the decision that waited nine days for a caller');

  // ADM-16: "The breakdown from approved requirements into modules, features
  // and tasks is automatic." `projects.break_down_requirement` was written for
  // it the same day and never called. This drives the seam that was missing:
  // a person accepts a requirement, and the plan follows.
  // The plan needs somewhere to go. `break_down_requirement` refuses a version
  // whose conversation names a different lead from the project's opportunity —
  // "which would otherwise produce a plausible breakdown of the wrong client's
  // scope" — so the engagement has to be real, not implied.
  const opportunity = one(
    await rest('POST', 'sales', 'opportunities', {
      organization_id: ORG, lead_id: lead.id, name: `${MARKER} storefront`,
      stage: 'discovery', value_minor: 0, currency: 'INR',
    }),
  );
  const planProject = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: client.id, opportunity_id: opportunity.id,
      name: `${MARKER} plan ${randomUUID().slice(0, 8)}`, status: 'planning',
    }),
  );
  check(Boolean(planProject?.id), 'a project exists for that engagement', planProject?.id ? '' : JSON.stringify(planProject).slice(0, 160));
  if (planProject?.id) created.projects.push(planProject.id);

  const conv = one(
    await rest('POST', 'crm', 'conversations', {
      organization_id: ORG, lead_id: lead.id, channel: 'whatsapp', status: 'active',
    }),
  );
  check(Boolean(conv?.id), 'a conversation exists to hold it', conv?.id ? '' : JSON.stringify(conv).slice(0,160));
  const versionRes = await rest('POST', 'crm', 'rpc/insert_requirement_version', {
      p_organization_id: ORG, p_conversation_id: conv.id, p_source: 'agent',
      p_status: 'proposed', p_payload: { summary: 'A storefront with a cart and checkout.' },
      p_source_message_count: 4,
  });
  const version = one(versionRes);
  if (version?.version_id ?? version?.id) created.versions.push(version.version_id ?? version.id);
  const versionId = version?.version_id ?? version?.id ?? null;
  check(Boolean(versionId), 'a proposed requirement exists', versionId ? '' : JSON.stringify(versionRes.json).slice(0, 240));

  const beforeAccept = await rest(
    'GET', 'core', `outbox_events?subject_id=eq.${versionId}&select=type`,
  );
  check(
    (Array.isArray(beforeAccept.json) ? beforeAccept.json : []).length === 0,
    'and proposing it announces nothing — the acceptance is the event, not the proposal',
  );

  await rest('PATCH', 'crm', `requirement_versions?id=eq.${versionId}`, { status: 'accepted' });
  const accepted = await rest(
    'GET', 'core', `outbox_events?subject_id=eq.${versionId}&select=type,subject_type`,
  );
  const acceptedTypes = (Array.isArray(accepted.json) ? accepted.json : []).map((e) => e.type);
  check(
    acceptedTypes.includes('requirement.accepted'),
    'ScopeApproved is emitted when a person accepts it — Doc 23 §7',
    acceptedTypes.join(', ') || 'nothing',
  );

  let planned = null;
  for (let i = 0; i < 6 && !planned; i += 1) {
    const t = await tick();
    if (t.json?.agent === 'project_manager') planned = t.json;
  }
  check(Boolean(planned), 'and a tick dispatches it to the project manager', planned?.agent ?? 'none');

  const planRun = one(
    await rest('GET', 'ai', `agent_runs?agent_key=eq.project_manager&subject_id=eq.${versionId}&select=id,status,error,subject_type&order=created_at.desc&limit=1`),
  );
  check(Boolean(planRun?.id), 'a run exists against the requirement version', planRun?.status ?? planned?.reason ?? 'none');
  check(
    planRun?.subject_type === 'crm.requirement_version',
    'naming the version it planned from',
    planRun?.subject_type,
  );
  check(
    planRun?.status === 'succeeded' || (planRun?.error ?? '').length > 0,
    'and it either produced the plan or said in writing why it could not',
    planRun?.status === 'succeeded' ? 'succeeded' : (planRun?.error ?? '').slice(0, 60),
  );

  // ── D2b ─────────────────────────────────────────────────────────────────
  console.log('\n  D2b. an L2 agent runs — the first one the work-aware gate lets through');

  const opened = one(
    await rest('POST', 'projects', 'rpc/open_scope_version', { p_project_id: planProject.id }),
  );
  for (const [i, [title, inclusion]] of [
    ['Customer app', 'included'],
    ['Admin panel', 'included'],
    ['Vendor portal', 'excluded'],
  ].entries()) {
    await rest('POST', 'projects', 'scope_items', {
      organization_id: ORG, scope_version_id: opened.scope_version_id,
      title, inclusion, position: i,
    });
  }
  const included = one(
    await rest('GET', 'projects', `scope_items?scope_version_id=eq.${opened.scope_version_id}&inclusion=eq.included&select=id&limit=1`),
  );

  const frozen = one(
    await rest('POST', 'projects', 'rpc/freeze_scope_version', { p_scope_version_id: opened.scope_version_id }),
  );
  check(frozen?.outcome === 'frozen', 'a scope baseline is agreed', frozen?.outcome);

  // Ticked until the DESIGNER's run for this baseline exists, not until any
  // designer tick comes back. `scope.frozen` has two subscribers now, so a
  // tick may claim the QA plan instead and "a designer ran" stops being the
  // same statement as "this baseline was designed".
  let designRun = null;
  for (let i = 0; i < 8 && !designRun; i += 1) {
    await tick();
    designRun = one(
      await rest('GET', 'ai', `agent_runs?agent_key=eq.ui_designer&subject_id=eq.${opened.scope_version_id}&select=id,status,error,work_class&order=created_at.desc&limit=1`),
    );
  }
  check(Boolean(designRun), 'ScopeFrozen dispatches to the designer', designRun ? 'ui_designer' : 'none');

  check(Boolean(designRun?.id), 'an L2 agent recorded a run at all', designRun?.status ?? 'none');
  check(
    designRun?.work_class === 'draft',
    'checked as ADM-61 §2 draft work, which is why it was allowed',
    designRun?.work_class ?? 'none',
  );
  check(
    designRun?.status === 'succeeded' || (designRun?.error ?? '').length > 0,
    'and it either produced the inventory or said why it could not',
    designRun?.status === 'succeeded' ? 'succeeded' : (designRun?.error ?? '').slice(0, 60),
  );

  // ── D2d ─────────────────────────────────────────────────────────────────
  console.log('\n  D2d. one baseline, two agents — and QA plans without judging');

  const qaRun = await (async () => {
    let r = null;
    for (let i = 0; i < 8 && !r; i += 1) {
      await tick();
      r = one(
        await rest('GET', 'ai', `agent_runs?agent_key=eq.quality_assurance&subject_id=eq.${opened.scope_version_id}&select=id,status,error,work_class&order=created_at.desc&limit=1`),
      );
    }
    return r;
  })();
  check(Boolean(qaRun), 'the SAME event also reaches QA — Doc 14 §5', qaRun ? 'quality_assurance' : 'none');
  check(
    qaRun?.work_class === 'draft',
    'as ADM-61 §2 draft work, not a verdict',
    qaRun?.work_class ?? 'none',
  );

  // Everything Doc 14 puts under somebody else's authority has no column
  // here, so there is no guard to bypass — asked at the row, because a
  // service layer that never runs cannot refuse anything.
  const gate = await rest('PATCH', 'qa', `test_plans?scope_version_id=eq.${opened.scope_version_id}`, {
    readiness_score: 92,
  });
  check(
    !gate.ok && /readiness_score/.test(JSON.stringify(gate.json)),
    'a plan cannot carry a readiness score — Doc 14 §19 is the Admin\'s',
    gate.ok ? 'IT WAS ACCEPTED' : `${gate.status}`,
  );

  const verdict = await rest('PATCH', 'qa', `test_plans?scope_version_id=eq.${opened.scope_version_id}`, {
    gate_passed: true,
  });
  check(
    !verdict.ok && /gate_passed/.test(JSON.stringify(verdict.json)),
    'and cannot say a gate passed — Doc 14 §21 is deterministic policy',
    verdict.ok ? 'IT WAS ACCEPTED' : `${verdict.status}`,
  );

  // Doc 14 §3: "QA tests the approved baseline, not an agent's interpretation
  // of what the project was supposed to be." Written here rather than left to
  // the run, because with no provider configured no plan is drafted at all
  // and "nothing wrong was planned" would pass by never happening.
  const ownPlan = one(
    await rest('POST', 'qa', 'test_plans', {
      organization_id: ORG,
      project_id: planProject.id,
      scope_version_id: opened.scope_version_id,
      drafted_by_agent: 'quality_assurance',
    }),
  );
  check(Boolean(ownPlan?.id), 'a plan can be written against the frozen baseline', ownPlan?.id ? '' : JSON.stringify(ownPlan).slice(0, 140));

  const invented = await rest('POST', 'qa', 'test_plan_items', {
    organization_id: ORG, plan_id: ownPlan.id,
    scope_item_id: '00000000-0000-4000-8000-0000000000ff',
    category: 'functional', reason: 'a feature nobody agreed to',
  });
  check(!invented.ok, 'and cannot test a scope item that does not exist', invented.ok ? 'IT WAS ACCEPTED' : `${invented.status}`);

  const madeUp = await rest('POST', 'qa', 'test_plan_items', {
    organization_id: ORG, plan_id: ownPlan.id,
    scope_item_id: included.id, category: 'vibes', reason: 'looks fine',
  });
  check(
    !madeUp.ok && /category/.test(JSON.stringify(madeUp.json)),
    'and cannot invent a twelfth testing category — Doc 14 §6 names eleven',
    madeUp.ok ? 'IT WAS ACCEPTED' : `${madeUp.status}`,
  );

  const twice = await rest('POST', 'qa', 'test_plans', {
    organization_id: ORG, project_id: planProject.id,
    scope_version_id: opened.scope_version_id, drafted_by_agent: 'quality_assurance',
  });
  check(!twice.ok, 'and one baseline has one plan, not two answers', twice.ok ? 'IT WAS ACCEPTED' : `${twice.status}`);

  // ── D2f ─────────────────────────────────────────────────────────────────
  console.log('\n  D2f. the package says what it owes, and a person owes it');

  // Its own handover, left `preparing`. The fixture's was delivered before
  // any of these sections ran, and a delivered package's checklist is a
  // checklist for a decision already made — which the workflow says, and
  // which is why using it here would have proved nothing.
  // A project of its own, because `handovers_open_project_key` allows one open
  // package per project and the fixture's is already delivered.
  const packProject = one(
    await rest('POST', 'projects', 'projects', {
      organization_id: ORG, client_account_id: client.id,
      name: `${MARKER} package ${randomUUID().slice(0, 8)}`, status: 'completed',
    }),
  );
  created.projects.push(packProject.id);

  const packing = one(
    await rest('POST', 'projects', 'handovers', { organization_id: ORG, project_id: packProject.id }),
  );
  check(Boolean(packing?.id), 'a package is opened', packing?.id ? '' : JSON.stringify(packing).slice(0, 200));

  const opening = await rest('GET', 'core', `outbox_events?subject_id=eq.${packing?.id ?? 'none'}&select=type`);
  check(
    (Array.isArray(opening.json) ? opening.json : []).some((e) => e.type === 'handover.preparing'),
    'opening a package asks for its contents — Doc 17 §9',
    (opening.json ?? []).map((e) => e.type).join(', ') || 'nothing',
  );

  let packRun = null;
  for (let i = 0; i < 10 && !packRun; i += 1) {
    await tick();
    packRun = one(
      await rest('GET', 'ai', `agent_runs?agent_key=eq.handover&subject_id=eq.${packing.id}&select=id,status,work_class&order=created_at.desc&limit=1`),
    );
  }
  check(Boolean(packRun), 'the handover agent is dispatched to list them', packRun ? 'handover' : 'none');
  check(
    packRun?.work_class === 'draft',
    'as ADM-61 §2 draft work — delivering is §3, and stays with a person',
    packRun?.work_class ?? 'none',
  );

  // At the row, because with no provider nothing is listed and every claim
  // below would pass by never happening.
  const owed = one(
    await rest('POST', 'projects', 'handover_requirements', {
      organization_id: ORG, handover_id: packing.id,
      kind: 'documentation', label: 'Admin guide',
      reason: 'The client operates the booking desk themselves.',
      drafted_by_agent: 'handover',
    }),
  );
  check(Boolean(owed?.id), 'a requirement can be listed', owed?.id ? '' : JSON.stringify(owed).slice(0, 140));

  const withArtifact = await rest('PATCH', 'projects', `handover_requirements?id=eq.${owed.id}`, {
    reference: 'https://drive.example/guide.pdf',
  });
  check(
    !withArtifact.ok && /reference/.test(JSON.stringify(withArtifact.json)),
    'and cannot carry the thing itself — §9 transfers are a person\'s',
    withArtifact.ok ? 'IT WAS ACCEPTED' : `${withArtifact.status}`,
  );

  const secret = await rest('PATCH', 'projects', `handover_requirements?id=eq.${owed.id}`, {
    transfer_method: 'emailed the password',
  });
  check(
    !secret.ok && /transfer_method/.test(JSON.stringify(secret.json)),
    'nor how it was transferred — ADM-61 §5 forbids writing a credential',
    secret.ok ? 'IT WAS ACCEPTED' : `${secret.status}`,
  );

  // And the whole point of listing them. Until now `deliver_handover` could
  // refuse only an EMPTY package, so one item satisfied it as completely as
  // fifteen.
  await rest('POST', 'projects', 'handover_items', {
    organization_id: ORG, handover_id: packing.id, kind: 'repository',
    label: 'Repo', reference: 'git@example:client/app.git',
  });
  // Asked for the REFUSAL, not merely for the absence of a delivery. The
  // trigger raises, so `outcome` is undefined either way — and "undefined is
  // not 'delivered'" would also be true of a call that never reached the
  // database at all.
  const short = await rest('POST', 'projects', 'rpc/deliver_handover', { p_handover_id: packing.id });
  check(
    !short.ok && /still owes: documentation/.test(JSON.stringify(short.json)),
    'a package that is not empty but is not complete says what it still owes — Doc 17 §3',
    short.ok ? 'IT WAS DELIVERED' : (short.json?.message ?? '').slice(0, 70),
  );

  const stillPreparing = one(
    await rest('GET', 'projects', `handovers?id=eq.${packing.id}&select=status`),
  );
  check(stillPreparing?.status === 'preparing', 'and nothing moved', stillPreparing?.status);

  await rest('POST', 'projects', 'handover_items', {
    organization_id: ORG, handover_id: packing.id, kind: 'documentation',
    label: 'Admin guide', reference: 'https://drive.example/guide.pdf',
  });
  const complete = one(
    await rest('POST', 'projects', 'rpc/deliver_handover', { p_handover_id: packing.id }),
  );
  check(
    complete?.outcome === 'delivered',
    'and the same package delivers once it holds what it owed',
    complete?.outcome ?? 'no outcome',
  );

  // ── D2e ─────────────────────────────────────────────────────────────────
  console.log('\n  D2e. the client accepts, and somebody prepares the conversation');

  // A person, because `decide_approval` refuses a caller with no identity —
  // accepting on a client's behalf is the forgery that guard exists to stop.
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
  created.users.push(authUser.id);
  await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
  await rest('POST', 'core', 'memberships', {
    organization_id: ORG, user_id: authUser.id, role: 'owner', status: 'active',
  });
  const owner = mint(authUser.id, 'owner');

  const pending = one(
    await rest('GET', 'projects', `handovers?id=eq.${handover.id}&select=approval_request_id`),
  );
  await asUser(owner, 'POST', 'approvals', 'rpc/decide_approval', {
    p_request_id: pending?.approval_request_id,
    p_decision: 'approved',
    p_evidence_ref: 'wamid.ZZTEST-CLIENT-ACCEPTED',
  });
  const synced = await rest('POST', 'projects', 'rpc/sync_handover_acceptance', {
    p_handover_id: handover.id,
  });
  check(synced.json === 'accepted', 'the client accepts the handover', `returned ${synced.json}`);

  const day0 = await rest('GET', 'core', `outbox_events?subject_id=eq.${handover.id}&select=type`);
  check(
    (Array.isArray(day0.json) ? day0.json : []).some((e) => e.type === 'handover.accepted'),
    'and Day 0 is an event now, not only an audit row — Doc 17 §17',
    (day0.json ?? []).map((e) => e.type).join(', ') || 'nothing',
  );

  let successRun = null;
  for (let i = 0; i < 10 && !successRun; i += 1) {
    await tick();
    successRun = one(
      await rest('GET', 'ai', `agent_runs?agent_key=eq.customer_success&subject_id=eq.${handover.id}&select=id,status,error,work_class&order=created_at.desc&limit=1`),
    );
  }
  check(Boolean(successRun), 'customer success is dispatched to prepare the check-in', successRun ? 'customer_success' : 'none');
  check(
    successRun?.work_class === 'internal_plan',
    'as ADM-61 §2 internal work — §22 puts the check-in ITSELF behind a person',
    successRun?.work_class ?? 'none',
  );

  // Written at the row, because with no provider configured no brief is
  // drafted and every claim below would pass by never happening.
  const ownBrief = one(
    await rest('POST', 'crm', 'check_in_briefs', {
      organization_id: ORG, project_id: project.id, handover_id: handover.id,
      drafted_by_agent: 'customer_success',
    }),
  );
  check(Boolean(ownBrief?.id), 'a brief can be written against the accepted handover', ownBrief?.id ? '' : JSON.stringify(ownBrief).slice(0, 140));

  const promised = await rest('PATCH', 'crm', `check_in_briefs?id=eq.${ownBrief.id}`, {
    amount_minor: 0,
  });
  check(
    !promised.ok && /amount_minor/.test(JSON.stringify(promised.json)),
    'and cannot carry an amount — ADM-22, and §18\'s "never promise free work"',
    promised.ok ? 'IT WAS ACCEPTED' : `${promised.status}`,
  );

  const scored = await rest('PATCH', 'crm', `check_in_briefs?id=eq.${ownBrief.id}`, {
    health_score: 80,
  });
  check(
    !scored.ok && /health_score/.test(JSON.stringify(scored.json)),
    'and cannot score the client — Doc 17 §24 weights are the Admin\'s',
    scored.ok ? 'IT WAS ACCEPTED' : `${scored.status}`,
  );

  const madeUpKind = await rest('POST', 'crm', 'check_in_points', {
    organization_id: ORG, brief_id: ownBrief.id, kind: 'offer_a_discount', note: 'they seem keen',
  });
  check(
    !madeUpKind.ok && /kind/.test(JSON.stringify(madeUpKind.json)),
    'a point is one of §18\'s seven kinds, and nothing else',
    madeUpKind.ok ? 'IT WAS ACCEPTED' : `${madeUpKind.status}`,
  );

  const foreignItem = await rest('POST', 'crm', 'check_in_points', {
    organization_id: ORG, brief_id: ownBrief.id, kind: 'unresolved_issue',
    note: 'about something that does not exist',
    maintenance_item_id: '00000000-0000-4000-8000-0000000000ee',
  });
  check(!foreignItem.ok, 'and cannot cite a support item that does not exist', foreignItem.ok ? 'IT WAS ACCEPTED' : `${foreignItem.status}`);

  const realPoint = await rest('POST', 'crm', 'check_in_points', {
    organization_id: ORG, brief_id: ownBrief.id, kind: 'unresolved_issue',
    note: 'The Safari checkout defect is still open — confirm whether it is blocking them.',
    maintenance_item_id: ticket.id,
  });
  check(realPoint.ok, 'but can cite the one this project actually raised', realPoint.ok ? '' : `${realPoint.status}`);

  // The same rule, on a different subject and at a different stage. The
  // message case is swept while the work is still pending; this one is swept
  // after it ran, which is exactly the difference that showed the first
  // version of the rule was reasoning about the WORK rather than the SUBJECT.
  const doomed = one(
    await rest('POST', 'projects', 'handovers', { organization_id: ORG, project_id: project.id }),
  );
  await rest('POST', 'core', 'outbox_events', {
    organization_id: ORG, type: 'handover.accepted',
    subject_type: 'handover', subject_id: doomed.id,
    payload: { project_id: project.id },
    published_at: new Date().toISOString(),
  });
  const raised = one(
    await rest('GET', 'core', `outbox_events?subject_id=eq.${doomed.id}&select=id`),
  );
  check(Boolean(raised?.id), 'a published request exists about a handover', raised?.id ? '' : 'nothing');

  await rest('DELETE', 'projects', `handovers?id=eq.${doomed.id}`);
  const swept = await rest('GET', 'core', `outbox_events?id=eq.${raised.id}&select=id`);
  check(
    (swept.json ?? []).length === 0,
    'and deleting the handover sweeps it even though it had already been published',
    `${(swept.json ?? []).length} left`,
  );

  const secondBrief = await rest('POST', 'crm', 'check_in_briefs', {
    organization_id: ORG, project_id: project.id, handover_id: handover.id,
    drafted_by_agent: 'customer_success',
  });
  check(!secondBrief.ok, 'and one handover is one conversation, not two', secondBrief.ok ? 'IT WAS ACCEPTED' : `${secondBrief.status}`);

  // ── D2c ─────────────────────────────────────────────────────────────────
  console.log('\n  D2c. a client message is read, and reading it acts on nothing');

  const clientMsg = one(
    await rest('POST', 'crm', 'conversation_messages', {
      organization_id: ORG, conversation_id: conv.id, seq: 99,
      author_type: 'client', body: 'Yes that looks good, please go ahead.',
    }),
  );
  check(Boolean(clientMsg?.id), 'a client message arrives', clientMsg?.id ? '' : JSON.stringify(clientMsg).slice(0, 140));

  const asked = await rest('GET', 'core', `outbox_events?subject_id=eq.${clientMsg.id}&select=type`);
  check(
    (Array.isArray(asked.json) ? asked.json : []).some((e) => e.type === 'message.received'),
    'and asks to be read — Doc 08 §12',
    (asked.json ?? []).map((e) => e.type).join(', ') || 'nothing',
  );

  // Ticked until the run for THIS message exists, not until any sales tick
  // comes back: earlier sections leave their own conversation messages behind,
  // each of which also asks to be read, so "a sales agent ran" is true long
  // before this one has. Alone, the first tick is always this job; in the
  // chain it is whichever message was queued first.
  let intentRun = null;
  for (let i = 0; i < 12 && !intentRun; i += 1) {
    await tick();
    intentRun = one(
      await rest('GET', 'ai', `agent_runs?agent_key=eq.sales&subject_id=eq.${clientMsg.id}&select=status,error,work_class&order=created_at.desc&limit=1`),
    );
  }
  check(Boolean(intentRun), 'the sales agent is dispatched to read it', intentRun ? 'sales' : 'none');
  check(intentRun?.work_class === 'internal_plan', 'as ADM-61 §2 internal work', intentRun?.work_class ?? 'none');

  // The message plainly says yes. Whatever the model calls it, nothing may have
  // moved — business rules §5: a client's word is never a fact.
  const after = one(
    await rest('GET', 'crm', `conversation_messages?id=eq.${clientMsg.id}&select=intent,intent_by_agent`),
  );
  const leadAfter = one(await rest('GET', 'crm', `leads?id=eq.${lead.id}&select=status`));
  check(leadAfter?.status === 'new', 'the lead did not move because a message said yes', leadAfter?.status);

  // And a label, once written, is what was read at the time.
  //
  // Labelled here rather than waiting for the agent, because with no provider
  // configured the agent labels nothing — and a check that only runs when the
  // model answers is a check that passes by being skipped. The freeze rule is
  // the trigger's, not the workflow's, so exercising it directly is exercising
  // the thing that holds it.
  const labelled = await rest('PATCH', 'crm', `conversation_messages?id=eq.${clientMsg.id}`, {
    intent: after?.intent ?? 'acceptance',
  });
  check(labelled.ok, 'a message can be labelled once', labelled.ok ? '' : `${labelled.status}`);

  const relabel = await rest('PATCH', 'crm', `conversation_messages?id=eq.${clientMsg.id}`, {
    intent: 'not_interested',
  });
  check(
    !relabel.ok && /what was read at the time/.test(JSON.stringify(relabel.json)),
    'and cannot be changed afterwards to mean something else',
    relabel.ok ? 'IT WAS ACCEPTED' : `${relabel.status}`,
  );

  // Doc 08 §12 names 22 intents and no others. `z.enum` refuses an off-list
  // label at the service boundary, but this is the layer that holds it for a
  // write that never passes through the service — so it is asked here, at the
  // row, where dropping the constraint is the only way to make it pass.
  const second = one(
    await rest('POST', 'crm', 'conversation_messages', {
      organization_id: ORG, conversation_id: conv.id, seq: 100,
      author_type: 'client', body: 'One more thing.',
    }),
  );
  const offList = await rest('PATCH', 'crm', `conversation_messages?id=eq.${second.id}`, {
    intent: 'sounds_keen',
  });
  check(
    !offList.ok && /intent_check/.test(JSON.stringify(offList.json)),
    'and a reading outside §12\'s 22 is not a reading at all',
    offList.ok ? 'IT WAS ACCEPTED' : `${offList.status}`,
  );

  // A message that is gone withdraws the request to read it. Proved here and
  // not only by verify-milestone-unlock's sweep noticing the leak 56 scripts
  // later — that sweep says something leaked, this says what the rule is.
  const third = one(
    await rest('POST', 'crm', 'conversation_messages', {
      organization_id: ORG, conversation_id: conv.id, seq: 101,
      author_type: 'client', body: 'Never mind.',
    }),
  );
  const askedFor = one(
    await rest('GET', 'core', `outbox_events?subject_id=eq.${third.id}&type=eq.message.received&select=id`),
  );
  check(Boolean(askedFor?.id), 'a third message asks to be read', askedFor?.id ? '' : 'nothing');

  // The delete's own outcome is checked, not only its aftermath. A refused
  // DELETE and a trigger that does nothing leave the identical rows behind,
  // and the first draft of this reported a `uuid = text` error inside the
  // trigger as "the withdrawal did not happen".
  const removed = await rest('DELETE', 'crm', `conversation_messages?id=eq.${third.id}`);
  check(removed.ok, 'the message can be deleted', removed.ok ? '' : JSON.stringify(removed.json).slice(0, 160));

  const gone = await rest('GET', 'core', `outbox_events?id=eq.${askedFor.id}&select=id`);
  const jobGone = await rest(
    'GET', 'core',
    `jobs?dedupe_key=eq.${encodeURIComponent(`evt:${askedFor.id}:sales:readIntent`)}&select=id,status`,
  );
  check(
    (gone.json ?? []).length === 0 && (jobGone.json ?? []).length === 0,
    'and deleting it takes the request and the job with it',
    `${(gone.json ?? []).length} event(s), ${(jobGone.json ?? []).length} job(s) left`,
  );

  const stillNew = one(await rest('GET', 'crm', `leads?id=eq.${lead.id}&select=status`));
  check(
    stillNew?.status === 'new',
    'and labelling it `acceptance` still moved nothing — business rules §5',
    stillNew?.status,
  );

  // ── D3 ──────────────────────────────────────────────────────────────────
  console.log('\n  D3. and the gate now asks WHICH WORK, not only which level');

  // ADM-61 §2 lets an L2 agent act alone on four kinds of work and §3 makes it
  // bring three others to the internal group. The guard could not tell them
  // apart, so one path's argument refused seven agents. Driven against the
  // real trigger, because a level-only refusal and a work-aware one look
  // identical from the application.
  const asL2 = async (workClass) => {
    await rest('PATCH', 'ai', 'agents?key=eq.upsell', { enabled: true, disabled_reason: null });
    const r = await rest('POST', 'ai', 'agent_runs', {
      organization_id: ORG, agent_key: 'upsell', trigger: 'zztest-gate',
      subject_type: 'test', subject_id: ticket.id, status: 'running',
      ...(workClass === null ? {} : { work_class: workClass }),
    });
    const id = one(r)?.id;
    if (id) await rest('DELETE', 'ai', `agent_runs?id=eq.${id}`);
    await rest('PATCH', 'ai', 'agents?key=eq.upsell', {
      enabled: false, disabled_reason: 'Layer 3 of ADM-82. Activation is a separate decision under the same grant.',
    });
    return r;
  };

  for (const work of ['read', 'draft', 'internal_plan', 'breakdown']) {
    const r = await asL2(work);
    check(r.ok, `an L2 agent may act alone on ${work} — ADM-61 §2`, r.ok ? '' : `${r.status} ${JSON.stringify(r.json).slice(0, 90)}`);
  }

  for (const work of ['client_facing', 'money', 'delivery_approval']) {
    const r = await asL2(work);
    check(
      !r.ok && /internal group/.test(JSON.stringify(r.json)),
      `and must bring ${work} to the internal group — ADM-61 §3`,
      r.ok ? 'IT WAS ACCEPTED' : `${r.status}`,
    );
  }

  const classless = await asL2(null);
  check(
    !classless.ok && /what kind of work/.test(JSON.stringify(classless.json)),
    'a run that does not say what kind of work it is cannot be checked, so it is refused',
    classless.ok ? 'IT WAS ACCEPTED' : `${classless.status}`,
  );

  const live = one(
    await rest('GET', 'ai', `agent_runs?agent_key=eq.support&select=work_class&order=created_at.desc&limit=1`),
  );
  check(
    live?.work_class === 'internal_plan',
    'and a real run records the class it was checked against',
    live?.work_class ?? 'none',
  );

  console.log('\n  E. the boundary the second agent runs behind is the first one’s');

  const disabled = one(
    await rest('GET', 'ai', 'agents?key=eq.upsell&select=key,enabled,autonomy_level'),
  );
  check(disabled?.enabled === false, 'an agent with no workflow is still disabled', `upsell enabled=${disabled?.enabled}`);

  const forced = await rest('POST', 'ai', 'agent_runs', {
    organization_id: ORG, agent_key: 'upsell', trigger: 'manual',
    subject_type: 'test', subject_id: ticket.id, status: 'running',
  });
  check(
    !forced.ok && /disabled/.test(JSON.stringify(forced.json)),
    'and the database refuses a run for it even so',
    forced.ok ? 'IT WAS ACCEPTED' : `${forced.status}`,
  );
} finally {
  // An approval request emits `approval.requested` (G-110), and this script
  // raises one to deliver a handover. `verify-milestone-unlock` asserts the
  // deployment holds zero outbox events and zero jobs, so an event left here
  // becomes that script's failure the moment anything drives the runner.
  // Deleted by subject type rather than by id, because approval requests are
  // cancelled and never deleted — there is no id list to walk.
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.approval_request');
  for (const id of created.items) {
    await rest('DELETE', 'core', `jobs?payload->>subjectId=eq.${id}`);
    await rest('DELETE', 'core', `outbox_events?subject_id=eq.${id}`);
  }
  for (const id of created.projects) {
    await rest('DELETE', 'core', `outbox_events?payload->>project_id=eq.${id}`);
    await rest('DELETE', 'projects', `projects?id=eq.${id}`);
  }
  // The plan.breakdown job this run queued. Left behind, it is counted by
  // `db:verify:claims`, which asserts a claim of one takes one — and four
  // leftover jobs make that read as four. Found by running the chain twice
  // without resetting between, which is how CI would never see it and a
  // developer always would.
  for (const id of created.versions) {
    await rest('DELETE', 'core', `jobs?payload->>subjectId=eq.${id}`);
  }
  // The scope baseline's own job and events go with the project cascade, but
  // the job payload names the scope version rather than the project.
  await rest('DELETE', 'core', 'jobs?kind=eq.ui.inventory&status=in.(succeeded,queued,dead)');
  await rest('DELETE', 'core', 'jobs?kind=eq.qa.plan&status=in.(succeeded,queued,dead)');
  await rest('DELETE', 'core', 'jobs?kind=eq.success.checkin&status=in.(succeeded,queued,dead)');
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.handover');
  // The owner minted to accept the handover. An auth user is not deleted by
  // any cascade this script owns, and one left behind is a real principal.
  for (const id of created.users) {
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      cache: 'no-store',
    }).catch(() => {});
  }
  await rest('DELETE', 'core', 'jobs?kind=eq.message.intent&status=in.(succeeded,queued,dead)');
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.conversation_message');
  // The requirement-version events name the version, and the version goes with
  // the lead — so they are swept by subject type before the cascade removes the
  // rows that would identify them.
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.requirement_version');
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.clients) await rest('DELETE', 'core', `client_accounts?id=eq.${id}`);
  // This script drives the runner, and the runner drains EVERYBODY's queues.
  // A tick here materialises any outbox event another script left behind, into
  // a job that script cannot know about — so the jobs those ticks created are
  // this one's to remove. Scoped to the two kinds a tick can produce from
  // reference state rather than a blanket sweep, which would delete work
  // somebody else queued deliberately.
  for (const kind of ['approval.announce', 'followup.deliver']) {
    await rest('DELETE', 'core', `jobs?kind=eq.${kind}&status=eq.succeeded`);
  }
  for (const id of created.policies) await rest('DELETE', 'approvals', `approval_policies?id=eq.${id}`);
}

if (failures > 0) {
  console.error(`\n  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n  All checks passed.\n');
