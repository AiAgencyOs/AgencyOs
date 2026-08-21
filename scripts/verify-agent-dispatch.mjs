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

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: false });
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

const created = { projects: [], clients: [], items: [], policies: [] };

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
