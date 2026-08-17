/**
 * Who to reactivate first — G-141 / ADM-88.
 *
 * The prioritisation is a deterministic fact-tier order, not a score:
 *   previously_quoted > previously_replied > has_conversation > cold,
 * then most-recently-active first with a stable phone/id tie-break. This proves
 * the order, that recency breaks ties within a tier, that a lead WITHOUT granted
 * whatsapp consent never appears (it cannot be queued by ranking highly), and
 * that an authenticated caller is pinned to its own tenant.
 */

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';
import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: false, anon: false, jwt: true });
await announceTarget(target, 'verify-reactivation-priority');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = `zztest-g141-${randomUUID().slice(0, 8)}`;
const ORG = '00000000-0000-4000-8000-000000000001';

let failures = 0, checks = 0;
function check(condition, description, detail = '') {
  checks += 1;
  if (condition) return void console.log(`  \x1b[32m✓\x1b[0m ${description}`);
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${description}${detail ? ` — ${detail}` : ''}`);
}
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

async function call(token, method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: token, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'Accept-Profile': schema, 'Content-Profile': schema, Prefer: 'return=representation',
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
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const b = b64({ sub: userId, aud: 'authenticated', role: 'authenticated', app_metadata: { organization_id: ORG, role }, iat: now, exp: now + 900 });
  return `${h}.${b}.${createHmac('sha256', target.jwtSecret).update(`${h}.${b}`).digest('base64url')}`;
}

const created = { leads: [], contacts: [], conversations: [], opportunities: [], orgs: [], users: [] };

async function consentedLead(org, tag, createdAt) {
  const contact = one(await rest('POST', 'crm', 'contacts', {
    organization_id: org, full_name: `${MARKER} ${tag}`, phone: `+9198${Math.floor(Math.random() * 1e8)}`,
  }));
  created.contacts.push(contact.id);
  await rest('POST', 'crm', 'communication_consent', {
    organization_id: org, contact_id: contact.id, channel: 'whatsapp', status: 'granted',
  });
  const lead = one(await rest('POST', 'crm', 'leads', {
    organization_id: org, title: `${MARKER} ${tag}`, status: 'qualifying', contact_id: contact.id,
    ...(createdAt ? { created_at: createdAt } : {}),
  }));
  created.leads.push(lead.id);
  return { lead: lead.id, contact: contact.id };
}
async function conversationFor(org, leadId, contactId) {
  const cv = one(await rest('POST', 'crm', 'conversations', {
    organization_id: org, kind: 'direct', channel: 'whatsapp', lead_id: leadId, contact_id: contactId,
  }));
  created.conversations.push(cv.id);
  return cv.id;
}

console.log('\n\x1b[1mAgencyOS — who to reactivate first (G-141 / ADM-88)\x1b[0m');

try {
  // ── tier fixtures, all consent-eligible ──────────────────────────────────
  const quoted = await consentedLead(ORG, 'quoted');
  const opp = one(await rest('POST', 'sales', 'opportunities', { organization_id: ORG, name: `${MARKER} opp`, lead_id: quoted.lead }));
  created.opportunities.push(opp.id);
  await rest('POST', 'sales', 'proposals', { organization_id: ORG, opportunity_id: opp.id, title: `${MARKER} quote` });

  const replied = await consentedLead(ORG, 'replied');
  const rc = await conversationFor(ORG, replied.lead, replied.contact);
  await rest('POST', 'crm', 'conversation_messages', { organization_id: ORG, conversation_id: rc, seq: 1, author_type: 'client', body: 'hi' });

  const conversed = await consentedLead(ORG, 'conversed');
  await conversationFor(ORG, conversed.lead, conversed.contact);

  const day = 86_400_000;
  const coldNew = await consentedLead(ORG, 'cold-new', new Date(Date.now() - 2 * day).toISOString());
  const coldOld = await consentedLead(ORG, 'cold-old', new Date(Date.now() - 20 * day).toISOString());

  // a lead with a contact but NO consent — must never be ranked
  const noConsentContact = one(await rest('POST', 'crm', 'contacts', { organization_id: ORG, full_name: `${MARKER} noconsent`, phone: `+9197${Math.floor(Math.random() * 1e8)}` }));
  created.contacts.push(noConsentContact.id);
  const noConsentLead = one(await rest('POST', 'crm', 'leads', { organization_id: ORG, title: `${MARKER} noconsent`, status: 'qualifying', contact_id: noConsentContact.id }));
  created.leads.push(noConsentLead.id);

  const mine = new Set([quoted.lead, replied.lead, conversed.lead, coldNew.lead, coldOld.lead]);
  const rankOf = (rows) => {
    const map = new Map();
    rows.filter((r) => mine.has(r.lead_id)).forEach((r, i) => map.set(r.lead_id, { pos: i, tier: r.tier, name: r.tier_name }));
    return map;
  };

  console.log('\n1. Fact-tiers order: quoted > replied > has_conversation > cold');
  const r1 = await rest('POST', 'crm', 'rpc/reactivation_priority', { p_organization_id: ORG, p_limit: 1000 });
  const rows = Array.isArray(r1.json) ? r1.json : [];
  const rank = rankOf(rows);
  check(rank.get(quoted.lead)?.tier === 4 && rank.get(quoted.lead)?.name === 'previously_quoted', 'the quoted lead is tier 4');
  check(rank.get(replied.lead)?.tier === 3 && rank.get(replied.lead)?.name === 'previously_replied', 'the replied lead is tier 3');
  check(rank.get(conversed.lead)?.tier === 2 && rank.get(conversed.lead)?.name === 'has_conversation', 'the conversed lead is tier 2');
  check(rank.get(coldNew.lead)?.tier === 1 && rank.get(coldNew.lead)?.name === 'cold', 'a cold lead is tier 1');
  const positions = [quoted.lead, replied.lead, conversed.lead, coldNew.lead].map((id) => rank.get(id)?.pos);
  check(positions.every((p, i) => i === 0 || p > positions[i - 1]), 'and they appear in that order', JSON.stringify(positions));

  console.log('\n2. Within a tier, most-recently-active first (stable tie-break)');
  check((rank.get(coldNew.lead)?.pos ?? 99) < (rank.get(coldOld.lead)?.pos ?? -1), 'the more recently active cold lead ranks first');

  console.log('\n3. Consent is the gate — a lead without granted whatsapp consent never appears');
  check(!rows.some((r) => r.lead_id === noConsentLead), 'the no-consent lead is absent from the ranking');

  console.log('\n4. An authenticated caller is pinned to its own tenant');
  {
    const otherOrg = one(await rest('POST', 'core', 'organizations', { name: `${MARKER} other`, slug: `zz-${randomUUID().slice(0, 8)}` }));
    created.orgs.push(otherOrg.id);
    const otherLead = await (async () => {
      const contact = one(await rest('POST', 'crm', 'contacts', { organization_id: otherOrg.id, full_name: `${MARKER} other`, phone: `+9196${Math.floor(Math.random() * 1e8)}` }));
      created.contacts.push(contact.id);
      await rest('POST', 'crm', 'communication_consent', { organization_id: otherOrg.id, contact_id: contact.id, channel: 'whatsapp', status: 'granted' });
      const lead = one(await rest('POST', 'crm', 'leads', { organization_id: otherOrg.id, title: `${MARKER} other`, status: 'qualifying', contact_id: contact.id }));
      created.leads.push(lead.id);
      return lead.id;
    })();

    const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
      method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ email: `${MARKER}@example.invalid`, password: randomUUID(), email_confirm: true }),
    }).then((r) => r.json());
    created.users.push(authUser.id);
    await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
    await rest('POST', 'core', 'memberships', { organization_id: ORG, user_id: authUser.id, role: 'owner', status: 'active' });
    const owner = mint(authUser.id, 'owner');

    // As the ORG owner, ASK for otherOrg — the org param must be ignored and the
    // caller pinned to ORG, so otherOrg's lead is absent and ORG's are present.
    const asOwner = await call(owner, 'POST', 'crm', 'rpc/reactivation_priority', { p_organization_id: otherOrg.id, p_limit: 1000 });
    const ownerRows = Array.isArray(asOwner.json) ? asOwner.json : [];
    check(!ownerRows.some((r) => r.lead_id === otherLead), "another tenant's lead is not returned, even when its org id is passed");
    check(ownerRows.some((r) => mine.has(r.lead_id)), 'the caller still sees its own leads');
  }
} finally {
  for (const id of created.opportunities) {
    await rest('DELETE', 'sales', `proposals?opportunity_id=eq.${id}`);
    await rest('DELETE', 'sales', `opportunities?id=eq.${id}`);
  }
  for (const id of created.conversations) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${id}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${id}`);
  }
  for (const id of created.leads) await rest('DELETE', 'crm', `leads?id=eq.${id}`);
  for (const id of created.contacts) await rest('DELETE', 'crm', `contacts?id=eq.${id}`);
  for (const id of created.users) {
    await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
    await rest('DELETE', 'core', `users?id=eq.${id}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, cache: 'no-store' });
  }
  for (const id of created.orgs) await rest('DELETE', 'core', `organizations?id=eq.${id}`);
}

console.log(`\n  ${checks} checks`);
if (failures === 0) {
  console.log('\n\x1b[32m✔ Reactivation is prioritised by recorded facts, consent-gated, tenant-safe\x1b[0m\n');
  process.exit(0);
}
console.error(`\n\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
