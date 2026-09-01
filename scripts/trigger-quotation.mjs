/**
 * Drive the quotation agent once, against a real brief, on the local stack.
 *
 *   node --import ./tests/_alias.mjs scripts/trigger-quotation.mjs
 *
 * NOT a verification script and deliberately not wired into CI. It plants one
 * lead, accepts its requirements, lets the REAL job runner draft and submit a
 * quotation, then renders the PDF the owner would approve.
 *
 * WHAT IS REAL HERE: the database and every guard on it, the job queue, the
 * runner, the workflow, schema validation, `draft_proposal`, the item and
 * total triggers, `submit_proposal`, the approval request, the document
 * write, the assembler and the renderer.
 *
 * WHAT IS NOT: the model's words. There is no live Anthropic key on a
 * developer machine — the verify stack points ANTHROPIC_BASE_URL at a local
 * stub — so the scope below stands in for what a model would answer. It is
 * written to be a plausible answer to the brief and nothing more. Whether a
 * real model populates the G-173 fields when the prompt names them is NOT
 * proved by this script and must not be claimed from it.
 *
 * The brief is one of the agency's own: the Turf Booking Platform quoted at
 * ₹75,000 on 19 August 2026 — customer Android app, turf-owner dashboard,
 * super-admin panel. Using a real one makes the output comparable to what a
 * person actually charged for the same words.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

import { announceTarget, resolveTarget } from './verify-target.mjs';

const fail = (m) => { console.error(`\n\x1b[31m✖ ${m}\x1b[0m\n`); process.exit(1); };

const target = await resolveTarget(fail, { cron: true, anon: false });
await announceTarget(target, 'trigger the quotation agent once, against a real brief');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const APP = target.appUrl ?? 'http://localhost:3000';
const ORG = '00000000-0000-4000-8000-000000000001';
const MARKER = `trigger-${randomUUID().slice(0, 8)}`;
const MODEL_PORT = 54399;
const OUT = process.argv[2] ?? '/tmp/agent-quotation.pdf';

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
  return { ok: res.ok, status: res.status, json: parse(await res.text()) };
}
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
const tick = () => fetch(`${APP}/api/jobs/run`, {
  method: 'POST', headers: { Authorization: `Bearer ${target.cronSecret}` }, cache: 'no-store',
}).then((r) => r.text()).catch(() => '');
async function until(predicate, budget = 40) {
  for (let i = 0; i < budget; i += 1) {
    const seen = await predicate();
    if (seen) return seen;
    await tick();
  }
  return predicate();
}

// ── the stand-in for the model ─────────────────────────────────────────────
//
// Written as a competent answer to the brief, WITH the G-173 fields, because
// the point of this run is to watch the whole document reach the page. It is
// not evidence about what a real model would write.
const SCOPE = {
  title: 'Turf booking platform — players, owners and the operator',
  understanding:
    'A player finds a nearby turf, sees which slots are actually free, pays for one and gets an instant ' +
    'confirmation. A turf owner sets their own prices and blocks the slots they need. The operator ' +
    'approves who may list, takes a commission on each booking and settles the rest.',
  items: [
    { description: 'Player Android app', priceRupees: 30000, kind: 'surface',
      features: ['Mobile number and OTP login', 'Find turfs nearby with photos and facilities',
        'See the slots that are genuinely free for a date', 'Pay for a slot and get an instant confirmation',
        'Past and upcoming bookings'] },
    { description: 'Turf owner dashboard', priceRupees: 17000, kind: 'surface',
      features: ['Add a turf with photos, address and facilities', 'Set base and peak pricing per slot',
        'Block slots for maintenance or a private event', 'See earnings with the commission shown'] },
    { description: 'Operator panel', priceRupees: 13000, kind: 'surface',
      features: ['Approve or reject a turf listing with a reason', 'Set the commission percentage',
        'Every booking across every turf', 'Process a refund on a cancellation'] },
    { description: 'Backend, APIs and database', priceRupees: 12000, kind: 'foundation',
      features: ['Slot availability that cannot double-book', 'Role-based access for the three sides',
        'Razorpay under the operator’s own merchant account'] },
    { description: 'Testing, deployment and handover', priceRupees: 3000, kind: 'foundation',
      features: ['Play Store submission support', 'Source code transferred to the client’s repository'] },
  ],
  summary:
    'Covers the player app, the owner dashboard and the operator panel, with payments and commission. ' +
    'An iOS build, a public website and multi-city operations are not covered.',
  exclusions: [
    'iOS app — the requirements name Android only',
    'A public booking website',
    'Multi-city operations and per-city pricing',
  ],
  assumptions: ['One city at launch', 'The operator holds the Razorpay merchant account'],
  clientResponsibilities: [
    'Razorpay merchant account and KYC',
    'Google Play Console account',
    'Turf photographs and facility lists',
  ],
  dependencies: ['Razorpay account approved before the payment flow can be tested end to end'],
  acceptanceCriteria: [
    'A player books and pays for a slot, the owner sees it, and the same slot cannot be booked twice',
    'The operator changes the commission and the next booking uses the new figure',
  ],
  optionalAddons: [{ label: 'iOS app from the same Flutter codebase', priceRupees: 45000 }],
  industryTheme: 'marketplace',
  regulatedCategory: null,
  depth: 'standard',
};

let modelCalls = 0;
const model = createServer((req, res) => {
  modelCalls += 1;
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const asks = (p) => body.includes(`"${p}"`);
    const payload = asks('items') && asks('summary') ? SCOPE : { summary: 'ok' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }],
      usage: { input_tokens: 40, output_tokens: 30 },
    }));
  });
});
await new Promise((resolve, reject) => {
  model.once('error', reject);
  model.listen(MODEL_PORT, '127.0.0.1', resolve);
}).catch((e) => fail(`could not bind the model stub on ${MODEL_PORT}: ${e.message}`));

const step = (n, s) => console.log(`\n\x1b[1m${n}.\x1b[0m ${s}`);

try {
  // An approver rung, or the submission has nobody to name.
  await rest('POST', 'approvals', 'approval_policies', {
    organization_id: ORG, subject_type: 'proposal', min_amount_minor: 0,
    required_role: 'owner', sla_hours: 24, active: true, note: `${MARKER} rung`,
  });

  step(1, 'A lead arrives on WhatsApp');
  const contact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: ORG, full_name: `${MARKER} Kabir Sethi`, phone: `+9198${String(Date.now()).slice(-8)}`,
  }));
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: ORG, contact_id: contact.id, title: `${MARKER} Turf booking platform`,
    source: 'whatsapp', source_ref: `${MARKER}:lead`, status: 'new',
  }));
  const conv = one(await rest('POST', 'crm', 'conversations', {
    organization_id: ORG, lead_id: lead.id, contact_id: contact.id,
    channel: 'whatsapp', external_ref: `${MARKER}:conv`, status: 'active',
  }));
  console.log(`   lead ${lead.id}  ·  ${contact.full_name}`);

  step(2, 'Their requirements are read, then ACCEPTED — acceptance is a transition, and it is the trigger');
  const proposed = one(await rest('POST', 'crm', 'requirement_versions', {
    organization_id: ORG, conversation_id: conv.id, version: 1, source: 'agent', status: 'proposed',
    payload: {
      summary:
        'A turf booking platform. Players find turfs near them, see free slots and pay online. Turf owners ' +
        'list their grounds, set their own prices and block slots. The operator approves listings and takes ' +
        'a commission on every booking. Android first.',
      scopeItems: [
        { title: 'Find and book', detail: 'Search nearby turfs, filter by facilities, see real availability' },
        { title: 'Pay online', detail: 'Razorpay, instant confirmation, refund on cancellation' },
        { title: 'Owner side', detail: 'List a turf, set peak and off-peak pricing, block slots, see earnings' },
        { title: 'Operator side', detail: 'Approve listings, set commission, oversee bookings and payouts' },
      ],
      constraints: ['Android only for now', 'One city at launch'],
      openQuestions: [],
    },
  }));
  const accepted = one(await rest('PATCH', 'crm', `requirement_versions?id=eq.${proposed.id}`, { status: 'accepted' }));
  console.log(`   requirement version v${accepted.version} → ${accepted.status}`);

  step(3, 'The runner picks the job up, and the agent drafts');
  const proposal = await until(async () => {
    const row = one(await rest('GET', 'sales',
      `proposals?select=id,version,title,status,total_minor,valid_until,document,created_at,opportunity_id` +
      `&order=created_at.desc&limit=1`));
    return row?.title?.includes('Turf') ? row : null;
  });
  if (!proposal) fail('no quotation was drafted — check that the app is running on :3000');
  console.log(`   ${proposal.title}`);
  console.log(`   v${proposal.version} · ${proposal.status} · ₹${(proposal.total_minor / 100).toLocaleString('en-IN')} · valid until ${proposal.valid_until}`);
  console.log(`   model calls: ${modelCalls}`);

  const items = (await rest('GET', 'sales',
    `proposal_items?proposal_id=eq.${proposal.id}&select=description,quantity,amount_minor,features&order=position`)).json ?? [];

  step(4, 'What the agent wrote onto the document');
  const d = proposal.document ?? {};
  const mark = (k) => {
    const v = d[k];
    const on = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined;
    console.log(`   ${on ? '●' : '○'} ${k.padEnd(22)} ${on ? JSON.stringify(v).slice(0, 96) : '— absent'}`);
  };
  ['understanding', 'exclusions', 'assumptions', 'clientResponsibilities',
   'dependencies', 'acceptanceCriteria', 'optionalAddons', 'industryTheme',
   'regulatedCategory', 'depth', 'phase', 'pricingReference'].forEach(mark);

  step(5, 'It is in the owner’s approval queue — and nowhere near the client');
  const req = one(await rest('GET', 'approvals',
    `approval_requests?select=id,state,required_role,requested_by_type,requested_by_id,amount_minor&order=created_at.desc&limit=1`));
  // `state`, not `status` — the first draft of this script asked for a column
  // that does not exist and printed `undefined` as if it were a finding.
  console.log(`   ${req?.state} · needs ${req?.required_role} · ₹${((req?.amount_minor ?? 0) / 100).toLocaleString('en-IN')} · requested by ${req?.requested_by_type}${req?.requested_by_id ? ` (${req.requested_by_id})` : ' — nobody impersonated'}`);

  step(6, 'The PDF the owner would open');
  const { renderQuotationPdf, quotationContactLine } = await import('../src/lib/pdf/quotation.ts');
  const { quotationSectionsFor } = await import('../src/modules/sales/quotation-standards.ts');
  const org = one(await rest('GET', 'core', 'organizations?select=name,timezone,settings&limit=1'));
  const renderItems = items.map((i) => ({
    description: i.description, quantity: Number(i.quantity), amountMinor: i.amount_minor,
    ...(Array.isArray(i.features) ? { features: i.features } : {}),
  }));
  const sections = quotationSectionsFor(proposal.total_minor, 0, proposal.document, renderItems);
  const rendered = await renderQuotationPdf({
    organizationName: org?.name ?? 'AgencyOS',
    contactLine: quotationContactLine(org?.settings),
    preparedFor: contact.full_name.replace(`${MARKER} `, ''),
    title: proposal.title, version: proposal.version, status: proposal.status,
    body: null, currency: 'INR', items: renderItems,
    subtotalMinor: proposal.total_minor, discountMinor: 0, taxMinor: 0, totalMinor: proposal.total_minor,
    validUntil: proposal.valid_until, preparedAt: proposal.created_at,
    timeZone: org?.timezone ?? 'Asia/Kolkata', reference: proposal.id,
    ...(sections ?? {}),
  });
  writeFileSync(OUT, rendered.bytes);
  console.log(`   ${OUT}  ·  glyph failures: ${rendered.replacedCharacters.length}`);
  console.log('   sections: ' + rendered.drawnText.filter((l) => /^[A-Z][A-Z &—,'’·-]{4,}$/.test(l)).join(' | '));

  step(7, 'What the owner is being shown against their own formula');
  const ref = d.pricingReference;
  if (ref) {
    const delta = ref.proposedRupees - ref.referenceRupees;
    console.log(`   proposed ₹${ref.proposedRupees.toLocaleString('en-IN')} · formula ₹${ref.referenceRupees.toLocaleString('en-IN')} · ${delta >= 0 ? '+' : ''}${delta.toLocaleString('en-IN')}`);
    console.log(`   lane ${ref.lane} · ${ref.surfaces} surface(s) · ${ref.depth} depth`);
    console.log(`   approver note: ${sections?.internalNote ? 'SHOWN' : 'silent — inside the formula’s own error bar'}`);
  }
  console.log(`\n   For comparison, a person quoted this same brief at ₹75,000 on 19 August 2026.`);

  console.log('\n\x1b[32m✔ the agent drafted, priced and submitted a quotation\x1b[0m');
  console.log('\x1b[33m  The model\'s WORDS were stubbed — there is no live key on this machine.\x1b[0m');
  console.log('\x1b[33m  Everything else ran for real: queue, runner, guards, triggers, renderer.\x1b[0m\n');
} finally {
  model.close();
  // Clean up the approver rung this script planted. Leaving it behind broke
  // `verify-quotations`, whose first section proves a submission is REFUSED
  // when no policy covers quotations — a fixture from another script had
  // quietly made that impossible.
  await rest('DELETE', 'approvals', `approval_policies?note=eq.${encodeURIComponent(`${MARKER} rung`)}`);
}
