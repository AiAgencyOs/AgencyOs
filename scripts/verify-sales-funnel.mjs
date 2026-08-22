/**
 * Where the leads are lost — Document 09 §37, and the Sales Dashboard of §30.
 *
 * The funnel is a set of counts, and a count is the easiest thing in software
 * to get confidently wrong. So this plants a cohort whose every stage is known
 * by construction and checks the function reports exactly it:
 *
 *   A. an empty window reports zero, and no rate at all
 *   B. a planted cohort is counted stage by stage
 *   C. two-way means two-way — a client writing twice is not "engaged"
 *   D. only what a PERSON accepted counts as requirements
 *   E. only a proposal actually SENT counts as quoted
 *   F. the stages are not nested, and an out-of-order pair is visible
 *   G. the window excludes what is outside it
 *   H. a soft-deleted lead is not counted
 *   I. one tenant cannot see another's funnel
 *
 *   node scripts/verify-sales-funnel.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false });
await announceTarget(target, 'where the leads are lost');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const MARKER = `zztest-funnel-${randomUUID().slice(0, 8)}`;

let failures = 0;
let checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}

const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return t; } };

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
    },
    cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: parse(text), text };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const funnel = async (org = ORG, from = '2000-01-01T00:00:00Z', to = '2099-01-01T00:00:00Z') =>
  one(await rest('POST', 'crm', 'rpc/sales_funnel', {
    p_organization_id: org, p_from: from, p_to: to,
  }));

console.log('\n\x1b[1mAgencyOS — where the leads are lost\x1b[0m');

const made = { leads: [], contacts: [], conversations: [], opportunities: [] };

async function plantLead(title) {
  const contact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: ORG, full_name: `${MARKER} ${title}`, phone: `+9199${String(Date.now()).slice(-8)}${made.contacts.length}`,
  }));
  made.contacts.push(contact.id);
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, contact_id: contact.id, title: `${MARKER} ${title}`,
    source: 'whatsapp', source_ref: `${MARKER}:${title}:${randomUUID().slice(0, 6)}`, status: 'new',
  }));
  made.leads.push(lead.id);
  const conv = one(await rest('POST', 'crm', 'conversations', {
    organization_id: ORG, lead_id: lead.id, contact_id: contact.id,
    channel: 'whatsapp', external_ref: `${MARKER}:conv:${randomUUID().slice(0, 8)}`, status: 'active',
  }));
  made.conversations.push(conv.id);
  return { lead, conv, contact };
}

let seq = 0;
const say = (conv, author, body, minutesAgo) =>
  rest('POST', 'crm', 'conversation_messages', {
    organization_id: ORG, conversation_id: conv.id, seq: seq++, author_type: author, body,
    external_ref: `${MARKER}:m:${randomUUID().slice(0, 8)}`,
    occurred_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });

try {
  // ── A ────────────────────────────────────────────────────────────────────
  console.log('\nA. An empty window reports nothing, and does not call it zero percent');
  const empty = await funnel(ORG, '1990-01-01T00:00:00Z', '1990-02-01T00:00:00Z');
  check(empty?.leads === 0, 'no leads in the window', `${empty?.leads}`);
  check(empty?.hours_to_first_reply === null, 'and no average time — an average of no rows is not zero', String(empty?.hours_to_first_reply));

  const before = await funnel();

  // ── B ────────────────────────────────────────────────────────────────────
  console.log('\nB. A planted cohort is counted stage by stage');

  // 1. a lead nobody answered.
  await plantLead('silent');

  // 2. answered, but they never wrote back.
  const answered = await plantLead('answered');
  await say(answered.conv, 'user', 'Hello, how can we help?', 120);

  // 3. genuinely two-way.
  const engaged = await plantLead('engaged');
  await say(engaged.conv, 'client', 'I want an app', 200);
  await say(engaged.conv, 'user', 'Sure — what should it do?', 180);
  await say(engaged.conv, 'client', 'Deliveries', 100);

  // 4. qualified, with a budget on file and accepted requirements.
  const qualified = await plantLead('qualified');
  await say(qualified.conv, 'client', 'Need a booking app', 300);
  await say(qualified.conv, 'user', 'Understood.', 280);
  await say(qualified.conv, 'client', 'Android and iOS', 260);
  await rest('PATCH', 'crm', `leads?id=eq.${qualified.lead.id}`, { status: 'qualifying' });
  // `leads_qualified_at_set` refuses a qualified lead with no date — the record
  // of when it happened arrives with the fact, which is the same rule the whole
  // schema keeps. Written together, as any real caller must.
  const qualifiedPatch = await rest('PATCH', 'crm', `leads?id=eq.${qualified.lead.id}`, {
    status: 'qualified', qualified_at: new Date().toISOString(),
  });
  check(qualifiedPatch.ok, 'the planted lead really did reach qualified', `status ${qualifiedPatch.status}`);
  await rest('POST', 'crm', 'qualification_coverage', {
    organization_id: ORG, lead_id: qualified.lead.id, conversation_id: qualified.conv.id,
    area: 'budget', quote: 'around fifty', read_by_agent: 'sales',
  });
  await rest('POST', 'crm', 'requirement_versions', {
    organization_id: ORG, conversation_id: qualified.conv.id, version: 1, source: 'agent',
    status: 'accepted', payload: { summary: 'A booking app', scopeItems: [], constraints: [], openQuestions: [] },
  });

  const after = await funnel();
  const grew = (field) => (after?.[field] ?? 0) - (before?.[field] ?? 0);

  check(grew('leads') === 4, 'four leads', `+${grew('leads')}`);
  check(grew('responded') === 3, 'three were answered — the silent one was not', `+${grew('responded')}`);
  check(grew('engaged') === 2, 'two are two-way', `+${grew('engaged')}`);
  check(grew('qualified') === 1, 'one is qualified, by its own status', `+${grew('qualified')}`);
  check(grew('requirements_accepted') === 1, 'one has requirements a person accepted', `+${grew('requirements_accepted')}`);
  check(grew('budget_known') === 1, 'one has a budget on file', `+${grew('budget_known')}`);
  // Every planted message has an occurred_at BEFORE its lead row, which is
  // exactly what an imported history looks like. A reply that predates the lead
  // is not a response time, so it is excluded rather than averaged into a
  // negative number nobody could read.
  check(
    after?.hours_to_first_reply === null || Number(after.hours_to_first_reply) >= 0,
    'a reply that predates its lead is not counted as a response time',
    `${after?.hours_to_first_reply}`,
  );

  const prompt = await plantLead('prompt');
  await say(prompt.conv, 'client', 'hi', -1);
  await say(prompt.conv, 'user', 'hello — how can we help?', -2);
  const timed = await funnel();
  check(
    timed?.hours_to_first_reply !== null && Number(timed.hours_to_first_reply) >= 0,
    'and a reply that came after its lead IS',
    `${timed?.hours_to_first_reply}h`,
  );

  // ── C ────────────────────────────────────────────────────────────────────
  console.log('\nC. Two-way means two-way');
  // Re-baselined here rather than reusing B's numbers: the timing lead planted
  // in between grew `responded` by one, and a baseline taken before it would
  // have blamed this section for that.
  const beforeShouting = await funnel();
  const shouting = await plantLead('shouting');
  await say(shouting.conv, 'client', 'Hello', 90);
  await say(shouting.conv, 'client', 'Hello?', 80);
  await say(shouting.conv, 'client', 'Anyone there?', 70);
  const shouted = await funnel();
  check(
    (shouted?.engaged ?? 0) - (beforeShouting?.engaged ?? 0) === 0,
    'a client writing three times alone is not engaged — nobody answered them',
    `+${(shouted?.engaged ?? 0) - (beforeShouting?.engaged ?? 0)}`,
  );
  check(
    (shouted?.responded ?? 0) - (beforeShouting?.responded ?? 0) === 0,
    'and not responded either',
  );

  // ── D ────────────────────────────────────────────────────────────────────
  console.log('\nD. Only what a person accepted counts as requirements');
  const proposed = await plantLead('proposed-only');
  await rest('POST', 'crm', 'requirement_versions', {
    organization_id: ORG, conversation_id: proposed.conv.id, version: 1, source: 'agent',
    status: 'proposed', payload: { summary: 'x', scopeItems: [], constraints: [], openQuestions: [] },
  });
  const withProposed = await funnel();
  check(
    (withProposed?.requirements_accepted ?? 0) - (shouted?.requirements_accepted ?? 0) === 0,
    'a proposed version is the agent’s reading, not an accepted requirement',
  );

  // ── E, F ─────────────────────────────────────────────────────────────────
  console.log('\nE–F. Only a quotation actually sent counts, and the stages do not smooth');
  const deal = await plantLead('deal');
  const opp = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: deal.lead.id, name: `${MARKER} deal`, stage: 'discovery',
  }));
  made.opportunities.push(opp.id);
  await rest('POST', 'sales', 'proposals', {
    organization_id: ORG, opportunity_id: opp.id, conversation_id: deal.conv.id,
    version: 1, status: 'draft', title: `${MARKER} quote`, currency: 'INR',
  });
  const drafted = await funnel();
  check(
    (drafted?.quoted ?? 0) - (withProposed?.quoted ?? 0) === 0,
    'a draft quotation is internal — the client has not seen it',
  );

  // Won it without ever sending the quote. ADM-13 permits exactly this, and it
  // is why the funnel is not forced monotone.
  await rest('PATCH', 'sales', `opportunities?id=eq.${opp.id}`, {
    stage: 'won', closed_at: new Date().toISOString(),
  });
  const wonIt = await funnel();
  check((wonIt?.won ?? 0) - (drafted?.won ?? 0) === 1, 'the deal is won', `+${(wonIt?.won ?? 0) - (drafted?.won ?? 0)}`);
  check(
    (wonIt?.quoted ?? 0) === (drafted?.quoted ?? 0),
    'and is NOT counted as quoted — a won lead is not assumed to have been quoted',
    `quoted ${wonIt?.quoted}`,
  );

  // ── G ────────────────────────────────────────────────────────────────────
  console.log('\nG. The window is a window');
  const narrow = await funnel(ORG, '2099-01-01T00:00:00Z', '2099-02-01T00:00:00Z');
  check(narrow?.leads === 0, 'a window with nothing in it counts nothing', `${narrow?.leads}`);

  // ── H ────────────────────────────────────────────────────────────────────
  console.log('\nH. A soft-deleted lead is not counted');
  const doomed = await plantLead('deleted');
  const withDoomed = await funnel();
  await rest('PATCH', 'crm', `leads?id=eq.${doomed.lead.id}`, { deleted_at: new Date().toISOString() });
  const withoutDoomed = await funnel();
  check(
    (withDoomed?.leads ?? 0) - (withoutDoomed?.leads ?? 0) === 1,
    'soft-deleting a lead removes it from the funnel',
    `${withDoomed?.leads} → ${withoutDoomed?.leads}`,
  );

  // ── J ────────────────────────────────────────────────────────────────────
  console.log('\nJ. A lost deal says why, and prose does not group');
  const lostDeal = await plantLead('lost');
  const lostOpp = one(await rest('POST', 'sales', 'opportunities', {
    organization_id: ORG, lead_id: lostDeal.lead.id, name: `${MARKER} lost`, stage: 'negotiation',
  }));
  made.opportunities.push(lostOpp.id);

  // Doc 09 §38 — "LOST requires a reason" — held at the ROW now, not only in
  // the service. A direct PostgREST write settled a deal with nothing recorded
  // before this.
  const silentLoss = await rest('PATCH', 'sales', `opportunities?id=eq.${lostOpp.id}`, {
    stage: 'lost', closed_at: new Date().toISOString(),
  });
  check(!silentLoss.ok, 'a deal cannot be lost with nothing recorded', `status ${silentLoss.status}`);

  const halfLoss = await rest('PATCH', 'sales', `opportunities?id=eq.${lostOpp.id}`, {
    stage: 'lost', closed_at: new Date().toISOString(), lost_reason: 'they went elsewhere',
  });
  check(!halfLoss.ok, 'nor with words nobody can count', `status ${halfLoss.status}`);

  const fullLoss = await rest('PATCH', 'sales', `opportunities?id=eq.${lostOpp.id}`, {
    stage: 'lost', closed_at: new Date().toISOString(),
    lost_reason: 'they went with an agency their cousin runs',
    lost_category: 'chose_competitor',
  });
  check(fullLoss.ok, 'and is lost with both — the count and the sentence', `status ${fullLoss.status}`);

  const distribution = (await rest('POST', 'sales', 'rpc/lost_reasons', {
    p_organization_id: ORG, p_from: '2000-01-01T00:00:00Z', p_to: '2099-01-01T00:00:00Z',
  })).json ?? [];
  const competitor = distribution.find((r) => r.lost_category === 'chose_competitor');
  check(Boolean(competitor), '§37’s distribution counts it by category', JSON.stringify(distribution).slice(0, 90));
  check(
    Number(competitor?.share) > 0 && Number(competitor?.share) <= 100,
    'with a share of the deals lost in the window',
    `${competitor?.share}%`,
  );

  // Reopening it drops all three, or every report of why deals are lost counts
  // a deal that is back in the pipeline.
  await rest('PATCH', 'sales', `opportunities?id=eq.${lostOpp.id}`, { stage: 'negotiation' });
  const reopened = one(await rest('GET', 'sales',
    `opportunities?id=eq.${lostOpp.id}&select=stage,lost_reason,lost_category,closed_at`));
  check(
    reopened?.lost_category === null && reopened?.lost_reason === null && reopened?.closed_at === null,
    'and a reopened deal carries none of it forward',
    `${reopened?.lost_category}/${reopened?.lost_reason}/${reopened?.closed_at}`,
  );

  // ── I ────────────────────────────────────────────────────────────────────
  console.log('\nI. One tenant cannot see another’s funnel');
  const theirs = await funnel(OTHER);
  const ours = await funnel(ORG);
  check(
    (theirs?.leads ?? 0) !== (ours?.leads ?? 0) || (ours?.leads ?? 0) === 0,
    'another organization reports its own numbers, not ours',
    `theirs ${theirs?.leads}, ours ${ours?.leads}`,
  );
  check(
    (theirs?.won ?? 0) === 0,
    'and none of the deals planted here appear in it',
    `${theirs?.won} won`,
  );
} finally {
  for (const id of made.opportunities) await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  for (const id of made.conversations) await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  for (const id of made.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of made.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
}

console.log(`\n${failures === 0 ? '\x1b[32m✔' : '\x1b[31m✖'} ${checks - failures}/${checks} checks passed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
