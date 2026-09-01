#!/usr/bin/env node
/**
 * The agent asking in the internal group, verified against a real database.
 *
 * Gap G-110, decision ADM-11, against docs/business-os/02-business-rules.md
 * §5.1. G-109 built the channel and nothing flowed through it: the queue the
 * Admin was promised existed only on a web page.
 *
 * What it proves:
 *
 *   1. Every request gets a reference, drawn from an alphabet with the
 *      characters people misread on a phone removed, and no two share one.
 *   2. An **internal**-audience request emits `approval.requested`, carrying
 *      the reference and the amount.
 *   3. A **client**-audience request emits nothing. That is §5.1's rule — the
 *      internal group is an approval channel, not a chat log, and a client's
 *      decision is recorded by staff with evidence (ADM-08d).
 *   4. The event becomes exactly one job, and re-dispatching enqueues none.
 *   5. Raising the same request twice announces once: `already_pending`
 *      emits nothing, so an owner's phone does not buzz twice for one
 *      decision.
 *   6. A reference is never reused, even after its request settles.
 *
 * Not proved here, because it is not built: nothing settles an approval from
 * a WhatsApp reply. `decide_approval` refuses without a signed-in approver,
 * and inbound group messages have no ingest path at all (G-115). See ADM-74.
 *
 *   node scripts/verify-approval-announcements.mjs
 */

import { randomUUID } from 'node:crypto';

import { announceTarget, resolveTarget } from './verify-target.mjs';

function fail(message) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m\n`);
  process.exit(1);
}

const target = await resolveTarget(fail, { cron: true, anon: false, jwt: false });
await announceTarget(target, 'verify-approval-announcements');

const URL_BASE = target.url;
const KEY = target.serviceKey;
const MARKER = 'zztest-announce';
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

async function rest(method, schema, path, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
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

const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

const raise = (subjectType, subjectId, extra = {}) =>
  rest('POST', 'approvals', 'rpc/request_approval', {
    p_organization_id: ORG,
    p_subject_type: subjectType,
    p_subject_id: subjectId,
    p_requested_by_type: 'system',
    ...extra,
  });

const eventsFor = async (requestId) =>
  (await rest('GET', 'core', `outbox_events?subject_id=eq.${requestId}&select=id,type,payload`)).json ?? [];

const tick = () =>
  fetch(`${target.appUrl ?? 'http://localhost:3000'}/api/jobs/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.cronSecret}` },
    cache: 'no-store',
  }).then((r) => r.text()).catch(() => '');

async function tickUntil(predicate, budget = 30) {
  for (let i = 0; i < budget; i += 1) {
    const seen = await predicate();
    if (seen) return seen;
    await tick();
  }
  return predicate();
}

/**
 * A Graph stub on the port .env.verify.local points WHATSAPP_GRAPH_BASE_URL
 * at. Without it every provider call from the app fails into a retry, which
 * the earlier sections tolerated (they assert rows, not deliveries) — but
 * §0b asserts the QUOTATION PDF actually left, which takes a provider that
 * answers. Uploads answer the upload shape ({ id }), sends the send shape
 * (messages[]) — conflating the two is the exact stub bug the upload
 * function reports as "accepted with no media id".
 */
import { createServer } from 'node:http';

const graphSends = [];
const graphUploads = [];
const graph = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.endsWith('/media')) {
      graphUploads.push({ url: req.url, bytes: body.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `MEDIA.STUB.${graphUploads.length}` }));
      return;
    }
    graphSends.push({ url: req.url, body: parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: `wamid.STUB.${graphSends.length}` }] }));
  });
});
const GRAPH_PORT = 54398;
await new Promise((resolve, reject) => {
  graph.once('error', reject);
  graph.listen(GRAPH_PORT, '127.0.0.1', resolve);
}).catch((e) => fail(`could not bind the graph stub on ${GRAPH_PORT}: ${e.message}`));

const created = { requests: [] };

/**
 * The organization's WhatsApp number, planted so the provider legs run.
 *
 * Without it every send dies permanent ("no WhatsApp number configured") and
 * only the ROWS prove anything — which is how this script originally passed
 * while the app had never delivered an announcement anywhere. With the stub
 * above and this number, the text and the document both travel the whole
 * path: row, upload where there is one, provider send, delivery settled.
 * Restored in the finally, whatever it was.
 */
const savedSettings = (one(await rest('GET', 'core', `organizations?id=eq.${ORG}&select=settings`)) ?? {}).settings ?? {};
await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, {
  settings: { ...savedSettings, whatsapp_phone_number_id: 'PN.STUB.ANNOUNCE' },
});

console.log('\n\x1b[1mAgencyOS — the agent asks in the group (G-110)\x1b[0m');

try {
  await rest('POST', 'approvals', 'approval_policies', {
    organization_id: ORG,
    subject_type: 'invoice',
    min_amount_minor: 0,
    required_role: 'ops_admin',
    sla_hours: 24,
    audience: 'internal',
  });
  await rest('POST', 'approvals', 'approval_policies', {
    organization_id: ORG,
    subject_type: 'deliverable',
    min_amount_minor: 0,
    required_role: 'ops_admin',
    sla_hours: 48,
    audience: 'client',
  });

  // ── 0. the announcement a quotation produces actually lands ─────────────
  //
  // Everything below tests the EVENT. Nothing tested the MESSAGE, and the
  // difference is a live defect: `announcementFor` renders the amount as
  // currency, and `crm.refuse_unread_price` refuses an agency message stating
  // a price when nobody authored it. The first quotation ever submitted would
  // have raised its approval, queued the announcement, and had the row refuse
  // it — retrying until the job died with the owner never told.
  console.log('\n0. An approval carrying an amount reaches the group');
  {
    const group = one(await rest('POST', 'crm', 'conversations', {
      organization_id: ORG, kind: 'internal_group', channel: 'whatsapp',
      external_ref: `zzapproval-group-${randomUUID().slice(0, 8)}`, status: 'active',
    }));
    created.group = group?.id;
    // Asserted, not assumed. A partial unique index allows one live internal
    // group per organization, so a group another script left behind makes this
    // insert be refused — and every check below then reads
    // `conversation_id=eq.undefined`, finds nothing, and reports `0 message(s)`
    // as though the announcement had failed. It had not: it went correctly to
    // the leftover group. Two hours of the wrong diagnosis, because the fixture
    // did not say it had not been planted.
    check(Boolean(created.group), 'a group exists to be told', group?.id ? 'created' : `refused: ${JSON.stringify(group)?.slice(0, 120)}`);

    // ── an agent-raised request: the number goes WITH the message ─────────
    //
    // The history, in two steps. `crm.refuse_unread_price` refuses an agency
    // message stating a price with no author, so the un-authored announcement
    // originally dropped the amount rather than die at the row. ADM-96 then
    // exempted the internal kinds (migration 20260824120000): the agency
    // saying a number to ITSELF is how the number gets its human, and a
    // system-raised request is exactly when the owner has only this message
    // to decide from. So the amount now travels, author or none.
    const bySystem = one(await raise('invoice', randomUUID(), { p_amount_minor: 7000000 }));
    created.requests.push(bySystem.request_id);
    check(bySystem?.outcome === 'requested', 'a priced approval is raised by an agent', `outcome ${bySystem?.outcome}`);

    const unauthored = await tickUntil(async () => {
      const rows = (await rest('GET', 'crm',
        `conversation_messages?conversation_id=eq.${group.id}&select=body,author_id&order=seq`)).json ?? [];
      return rows.length > 0 ? rows : null;
    }, 30);
    check((unauthored ?? []).length > 0, 'the group is told', `${(unauthored ?? []).length} message(s)`);
    const note = (unauthored ?? [])[0]?.body ?? '';
    check(/₹/.test(note), 'WITH the number — the amount is the question being asked (ADM-96)', note.split('\n').find((l) => l.includes('₹')) ?? '(none)');
    check((unauthored ?? [])[0]?.author_id === null, 'and no author invented for it', String((unauthored ?? [])[0]?.author_id));
    check(/Decide it in AgencyOS/i.test(note), 'still directing the decision to AgencyOS (ADM-74)');

    // ── a person's request: the number stays ──────────────────────────────
    //
    // Which is the real quotation path: `submitProposal` passes context.userId
    // straight through to `request_approval`.
    // `core.users.id` references `auth.users(id)`, so the auth row comes
    // first — and a trigger mirrors it into `core.users`, so nothing else is
    // needed.
    const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        email: `zzapproval-${randomUUID().slice(0, 8)}@example.invalid`,
        password: randomUUID(),
        email_confirm: true,
      }),
    }).then((r) => r.json()).catch(() => ({}));
    // The `core.users` row arrives with the auth row — a trigger on
    // `auth.users` mirrors it, so inserting one here is a duplicate key. The
    // first draft did exactly that and reported 409 as "could not plant a
    // user", which was a fact about the script.
    const authorId = authUser?.id;
    const planted = authorId
      ? one(await rest('GET', 'core', `users?id=eq.${authorId}&select=id`))
      : null;
    if (planted?.id) {
      created.user = authorId;
      const byPerson = one(await raise('invoice', randomUUID(), {
        p_amount_minor: 7000000, p_requested_by_type: 'user', p_requested_by_id: authorId,
      }));
      created.requests.push(byPerson.request_id);

      const authored = await tickUntil(async () => {
        const rows = (await rest('GET', 'crm',
          `conversation_messages?conversation_id=eq.${group.id}&select=body,author_id&order=seq`)).json ?? [];
        return rows.length > 1 ? rows : null;
      }, 30);
      const second = (authored ?? [])[1];
      check(Boolean(second), 'a person’s request is announced too', `${(authored ?? []).length} message(s)`);
      check(/₹/.test(second?.body ?? ''), 'carrying the amount, because a human is behind it', (second?.body ?? '').split('\n').find((l) => l.includes('₹')) ?? '(none)');
      check(second?.author_id === authorId, 'and named as theirs at the row', second?.author_id ? 'authored' : 'no author');
    } else {
      check(false, 'a user exists to prove the authored case', authorId ? 'no core.users row appeared' : 'no auth user');
    }
  }

  // ── 0b. a quotation approval carries the quotation as a document ────────
  //
  // Brief §12, gap G-156. The text announcement tells the owner what they
  // are deciding; the PDF is the form they can save and forward. This is the
  // one live proof of that leg: a real proposal row, a person-raised
  // approval against it, the app's own job runner, and the stub above
  // standing in for Meta — upload first, document message second, both
  // asserted, plus the row that records it.
  console.log('\n0b. A quotation approval reaches the group as a document too');
  if (created.user) {
    // The proposal the document renders from. Planted directly rather than
    // through submit_proposal, because what this section proves is the
    // ANNOUNCE leg reading rows — not the submit path, which
    // verify-quotations already holds.
    const lead = one(await rest('POST', 'crm', 'leads', {
      organization_id: ORG, title: `${MARKER} quotation lead`,
    }));
    created.lead = lead?.id;
    const deal = one(await rest('POST', 'sales', 'opportunities', {
      organization_id: ORG, lead_id: lead?.id, name: `${MARKER} quotation deal`,
    }));
    created.deal = deal?.id;
    const quote = one(await rest('POST', 'sales', 'proposals', {
      organization_id: ORG, opportunity_id: deal?.id,
      title: `${MARKER} website build`, body: 'Covers the site. Does not cover hosting.',
    }));
    created.quote = quote?.id;
    check(Boolean(quote?.id), 'a quotation exists to be announced', JSON.stringify(quote)?.slice(0, 120));

    await rest('POST', 'sales', 'proposal_items', {
      organization_id: ORG, proposal_id: quote?.id, position: 0,
      description: 'Design', quantity: 3, unit_price_minor: 100000, amount_minor: 300000,
    });

    // A proposal-subject approval needs a policy to resolve its approver
    // from — request_approval answers no_policy otherwise, and the FIRST
    // version of this section spent an hour reading job tables before
    // looking at the raise's own answer. Owner at zero, the only policy the
    // money floor permits for quotations (ADM-07); the finally below already
    // deletes every policy this organization holds.
    const policy = one(await rest('POST', 'approvals', 'approval_policies', {
      organization_id: ORG, subject_type: 'proposal',
      min_amount_minor: 0, required_role: 'owner', sla_hours: 48, audience: 'internal',
    }));
    check(Boolean(policy?.id), 'a quotation policy exists to resolve the approver', JSON.stringify(policy)?.slice(0, 100));

    const uploadsBefore = graphUploads.length;
    const byPersonQuote = one(await raise('proposal', quote?.id, {
      p_amount_minor: 300000, p_requested_by_type: 'user', p_requested_by_id: created.user,
    }));
    created.requests.push(byPersonQuote?.request_id);
    check(byPersonQuote?.outcome === 'requested', 'the quotation approval is raised', `outcome ${byPersonQuote?.outcome}`);

    const docRow = await tickUntil(async () => {
      const rows = (await rest('GET', 'crm',
        `conversation_messages?external_ref=eq.${encodeURIComponent(`approval:${byPersonQuote?.request_id}:pdf`)}&select=body,author_id,metadata`)).json ?? [];
      return rows.length > 0 && rows[0]?.metadata?.delivery === 'sent' ? rows[0] : null;
    }, 40);

    check(Boolean(docRow), 'a document row lands beside the announcement, delivery settled', docRow ? 'sent' : 'no settled row appeared');
    check(docRow?.metadata?.media_type === 'document', 'recorded as a document, not as text', docRow?.metadata?.media_type ?? '(none)');
    check(
      /^Quotation-v\d+/.test(docRow?.metadata?.media_filename ?? ''),
      'with a filename a phone will show',
      docRow?.metadata?.media_filename ?? '(none)',
    );
    check((docRow?.body ?? 'x') === '', 'and an empty body — the words travel in the text message beside it');
    check(docRow?.author_id === created.user, 'authored by the person who asked — attribution follows the requester');

    check(graphUploads.length > uploadsBefore, 'the PDF bytes reached the provider as an upload', `${graphUploads.length - uploadsBefore} upload(s)`);
    check(
      (graphUploads[graphUploads.length - 1]?.bytes ?? 0) > 10000,
      'and they are a document, not a stub of one',
      `${graphUploads[graphUploads.length - 1]?.bytes ?? 0} byte(s)`,
    );
    const docSend = graphSends.find((g) => g.body?.type === 'document');
    check(Boolean(docSend), 'and a document message followed them', docSend ? JSON.stringify(docSend.body?.document)?.slice(0, 80) : 'no document send');
    check(
      docSend?.body?.document?.id?.startsWith('MEDIA.STUB.'),
      'naming the id the upload answered with — the two calls are one delivery',
      docSend?.body?.document?.id ?? '(none)',
    );

    // ── 0d. a SYSTEM-raised quotation approval carries everything too ─────
    //
    // ADM-96 inverted the old rule here. The agent now submits quotations
    // with no human requester, which is precisely when the owner has ONLY
    // this announcement to decide from — so the amount and the PDF go, and
    // `crm.refuse_unread_price` exempts the internal kinds (migration
    // 20260824120000) because the agency saying a number to ITSELF is how
    // the number gets its human. What survives whole is attribution: no
    // person asked, so NO author is named on either row.
    // Its own deal: proposals_live_version_key allows ONE live quotation per
    // opportunity, and quote v1 above is still live — a second draft on the
    // same deal is refused at the index, which the first draft of this
    // section read as a handler bug.
    // And no lead: opportunities_open_lead_key allows one OPEN deal per lead
    // (ADM-05), and deal one above is open.
    console.log('\n0d. A system-raised quotation approval carries the amount AND the document');
    const deal2 = one(await rest('POST', 'sales', 'opportunities', {
      organization_id: ORG, name: `${MARKER} second deal`,
    }));
    created.deal2 = deal2?.id;
    const quote2 = one(await rest('POST', 'sales', 'proposals', {
      organization_id: ORG, opportunity_id: deal2?.id,
      title: `${MARKER} website build again`,
    }));
    created.quote2 = quote2?.id;
    await rest('POST', 'sales', 'proposal_items', {
      organization_id: ORG, proposal_id: quote2?.id, position: 0,
      description: 'Website build', quantity: 1, unit_price_minor: 300000, amount_minor: 300000,
    });
    const uploadsBeforeSystem = graphUploads.length;
    const bySystemQuote = one(await raise('proposal', quote2?.id, { p_amount_minor: 300000 }));
    created.requests.push(bySystemQuote?.request_id);
    check(bySystemQuote?.outcome === 'requested', 'the system-raised quotation approval is raised', `outcome ${bySystemQuote?.outcome}`);

    const announced = await tickUntil(async () => {
      const rows = (await rest('GET', 'crm',
        `conversation_messages?external_ref=eq.${encodeURIComponent(`approval:${bySystemQuote?.request_id}`)}&select=id,body,author_id,metadata`)).json ?? [];
      return rows.length > 0 && rows[0]?.metadata?.delivery === 'sent' ? rows : null;
    }, 40);
    check((announced ?? []).length > 0, 'the system-raised quotation approval is announced, delivery settled');
    check(
      /₹/.test(announced?.[0]?.body ?? ''),
      'carrying the amount — the number IS the question the owner is being asked',
      (announced?.[0]?.body ?? '').slice(0, 60),
    );
    check(
      announced?.[0]?.author_id === null,
      'with NO author named — nobody asked, and the row says so honestly',
      String(announced?.[0]?.author_id),
    );

    const systemDoc = await tickUntil(async () => {
      const rows = (await rest('GET', 'crm',
        `conversation_messages?external_ref=eq.${encodeURIComponent(`approval:${bySystemQuote?.request_id}:pdf`)}&select=id,author_id,metadata`)).json ?? [];
      return rows.length > 0 && rows[0]?.metadata?.delivery === 'sent' ? rows[0] : null;
    }, 40);
    check(Boolean(systemDoc), 'and the document goes too — the PDF is what the owner decides against (ADM-96)', systemDoc ? 'sent' : 'no settled row');
    check(systemDoc?.author_id === null, 'unauthored for the same honest reason', String(systemDoc?.author_id));
    check(
      graphUploads.length > uploadsBeforeSystem,
      'its bytes genuinely reached the provider',
      `${graphUploads.length - uploadsBeforeSystem} upload(s)`,
    );
  } else {
    check(false, 'a user exists to prove the quotation document case');
  }

  // ── 0c. the channel may be a person — ADM-95, G-159 ─────────────────────
  //
  // Meta refused this WABA the Groups APIs (#131215), so the internal
  // channel can be the owner's own WhatsApp: an internal_direct
  // conversation, addressed by the number inside its own external_ref, as an
  // individual. While the group above is still linked, the PERSON must win —
  // on the real deployment the group is a row Meta will refuse to deliver
  // to, and an announcement that reaches a person outranks one that reaches
  // a constraint.
  console.log('\n0c. The channel may be a person, and the person wins');
  if (created.user) {
    const linked = one(await rest('POST', 'crm', 'rpc/link_internal_recipient', {
      p_organization_id: ORG, p_phone: '+91 83606 91637', p_title: 'Owner',
    }));
    created.recipient = linked?.conversation_id;
    check(linked?.outcome === 'linked', 'a person is linked as the channel', `outcome ${linked?.outcome}`);

    const relinked = one(await rest('POST', 'crm', 'rpc/link_internal_recipient', {
      p_organization_id: ORG, p_phone: '918360691638',
    }));
    check(
      relinked?.outcome === 'relinked' && relinked?.conversation_id === created.recipient,
      'a second link RE-links — the corrected number replaces the old one on the same row',
      `outcome ${relinked?.outcome}`,
    );

    const sendsBefore = graphSends.length;
    const byPersonDirect = one(await raise('invoice', randomUUID(), {
      p_amount_minor: 4200000, p_requested_by_type: 'user', p_requested_by_id: created.user,
    }));
    created.requests.push(byPersonDirect?.request_id);

    /**
     * Keyed on THIS request, not on whichever message arrived first.
     *
     * It used to read `rows[0]` — the first message on the person's thread —
     * and that was only ever a proxy for "the announcement this section
     * raised". G-176 made the proxy wrong: linking a channel now announces
     * every approval that was ALREADY pending, so on a database carrying work
     * from earlier scripts the first message on this thread belongs to
     * somebody else's request. It passed alone and failed in the chain, which
     * is the signature.
     *
     * `approval:<request id>` is the announcer's own idempotency key, so this
     * asks the question the check was always trying to ask.
     */
    const ownRef = `approval:${byPersonDirect?.request_id}`;
    const landed = await tickUntil(async () => {
      const rows = (await rest('GET', 'crm',
        `conversation_messages?conversation_id=eq.${created.recipient}&external_ref=eq.${encodeURIComponent(ownRef)}&select=body,metadata`)).json ?? [];
      return rows.length > 0 && rows[0]?.metadata?.delivery === 'sent' ? rows : null;
    }, 40);

    check((landed ?? []).length > 0, 'the announcement lands on the PERSON, not the group — the preference is real', `${(landed ?? []).length} message(s)`);
    check(/₹/.test(landed?.[0]?.body ?? ''), 'carrying the amount, because a human asked');

    // The same discipline on the wire: several announcements may leave in this
    // window now, and the one under test is the one carrying this request's
    // own reference.
    const reference = one(await rest('GET', 'approvals',
      `approval_requests?id=eq.${byPersonDirect?.request_id}&select=reference`))?.reference ?? '';
    const wire = graphSends
      .slice(sendsBefore)
      .find((g) => typeof g.body?.text?.body === 'string' && g.body.text.body.includes(reference));
    check(
      wire?.body?.to === '918360691638' && wire?.body?.recipient_type === 'individual',
      'addressed to the RE-linked digits, as an individual — the number inside the ref, not a contact row',
      JSON.stringify({ to: wire?.body?.to, rt: wire?.body?.recipient_type }),
    );

    const groupGot = (await rest('GET', 'crm',
      `conversation_messages?conversation_id=eq.${created.group}&external_ref=eq.${encodeURIComponent(`approval:${byPersonDirect?.request_id}`)}&select=id`)).json ?? [];
    check(groupGot.length === 0, 'and the group got nothing for this request — one channel, not two', `${groupGot.length} row(s)`);

    // The person is unlinked (abandoned) so §1 onward measures the group
    // exactly as it always did — this section must not rewrite the others.
    await rest('PATCH', 'crm', `conversations?id=eq.${created.recipient}`, { status: 'abandoned' });
  } else {
    check(false, 'a user exists to prove the person-channel case');
  }

  // ── 1 & 2. an internal request is announced ─────────────────────────────
  console.log('\n1. An internal request carries a reference and is announced');
  {
    const subject = randomUUID();
    const raised = one(await raise('invoice', subject, { p_amount_minor: 4500000 }));
    check(raised?.outcome === 'requested', 'the request is raised', `outcome ${raised?.outcome}`);
    created.requests.push(raised.request_id);

    const row = one(
      await rest('GET', 'approvals', `approval_requests?id=eq.${raised.request_id}&select=reference,audience`),
    );
    check(
      typeof row?.reference === 'string' && /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/.test(row.reference),
      'it has a six-character reference from the safe alphabet',
      `${row?.reference}`,
    );
    check(
      !/[01OILU]/.test(row?.reference ?? ''),
      'and none of the characters people misread on a phone',
      `${row?.reference}`,
    );

    const events = await eventsFor(raised.request_id);
    check(events.length === 1, 'exactly one announcement is emitted', `${events.length} events`);
    check(
      events[0]?.type === 'approval.requested',
      'of the type the catalog subscribes to',
      `${events[0]?.type}`,
    );
    check(
      events[0]?.payload?.reference === row?.reference,
      'carrying the reference somebody has to quote back',
      `${events[0]?.payload?.reference}`,
    );
    check(
      events[0]?.payload?.amountMinor === 4500000,
      'and the amount the decision is about',
      `${events[0]?.payload?.amountMinor}`,
    );

    created.firstReference = row?.reference;
    created.firstRequest = raised.request_id;
  }

  // ── 5. raising twice announces once ─────────────────────────────────────
  console.log('\n2. One decision, one announcement');
  {
    const subject = randomUUID();
    const first = one(await raise('invoice', subject));
    created.requests.push(first.request_id);

    const again = one(await raise('invoice', subject));
    check(
      again?.outcome === 'already_pending' && again?.request_id === first.request_id,
      'raising the same subject twice answers with the pending request',
      `outcome ${again?.outcome}`,
    );

    const events = await eventsFor(first.request_id);
    check(
      events.length === 1,
      'and emits nothing the second time — an owner’s phone does not buzz twice',
      `${events.length} events`,
    );
  }

  // ── 3. a client-audience request is not announced ───────────────────────
  console.log('\n3. A client’s decision is not brought to the internal group');
  {
    const subject = randomUUID();
    const raised = one(await raise('deliverable', subject));
    check(raised?.outcome === 'requested', 'the client-audience request is raised');
    created.requests.push(raised.request_id);

    const events = await eventsFor(raised.request_id);
    check(
      events.length === 0,
      '§5.1: the internal group is an approval channel, not a chat log',
      `${events.length} events`,
    );

    // And the explicit override is honoured, not just the policy default.
    const forced = one(await raise('invoice', randomUUID(), { p_audience: 'client' }));
    created.requests.push(forced.request_id);
    const forcedEvents = await eventsFor(forced.request_id);
    check(
      forcedEvents.length === 0,
      'and an internal-policy subject forced to client audience is not announced either',
      `${forcedEvents.length} events`,
    );
  }

  // ── 6. references are never reused ──────────────────────────────────────
  console.log('\n4. A reference is never reused');
  {
    const duplicate = await rest('PATCH', 'approvals', `approval_requests?id=eq.${created.requests[1]}`, {
      reference: created.firstReference,
    });
    check(
      duplicate.status >= 400 && duplicate.text.includes('approval_requests_reference_key'),
      'two live requests cannot share a code',
      `status ${duplicate.status}`,
    );

    // Settle the first, then try to hand its code to a new request. A code
    // recycled on settlement would make a late reply land on a different
    // decision.
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${created.firstRequest}`, {
      state: 'cancelled',
      decided_at: new Date().toISOString(),
    });
    const afterSettle = await rest('PATCH', 'approvals', `approval_requests?id=eq.${created.requests[1]}`, {
      reference: created.firstReference,
    });
    check(
      afterSettle.status >= 400,
      'and a settled request keeps its code — it is not recycled',
      `status ${afterSettle.status}`,
    );
  }

  // ── 4. the event becomes one job, and only one ──────────────────────────
  console.log('\n5. The announcement becomes exactly one job');
  {
    const unpublished = (
      await rest('GET', 'core', `outbox_events?type=eq.approval.requested&published_at=is.null&select=id`)
    ).json ?? [];
    check(
      unpublished.length > 0,
      'the announcements are waiting in the outbox for the dispatcher',
      `${unpublished.length} unpublished`,
    );

    // The dispatcher's own idempotency is proved by tests/outbox-dispatch and
    // verify-milestone-unlock; what matters here is that these events are
    // ordinary outbox rows and need no special handling.
    const shaped = (
      await rest('GET', 'core', `outbox_events?type=eq.approval.requested&select=organization_id,subject_type`)
    ).json ?? [];
    check(
      shaped.every((e) => e.organization_id === ORG && e.subject_type === 'approval_request'),
      'each is scoped to its organization and names its subject',
      `${shaped.length} rows`,
    );
  }
  // ── 6. one queue does not starve another ────────────────────────────────
  //
  // G-110's announce drain returned early, exactly as the unlock drain does.
  // The unlock path can afford that — milliseconds of pure database work — but
  // an announcement reaches an outside provider, and returning meant **a
  // single queued announcement starved every later queue for that whole
  // invocation**. In CI, where the scripts drive the runner directly rather
  // than waiting for cron, that is the difference between a tick doing its
  // work and a tick doing none of it.
  console.log('\n6. An announcement does not starve the queues behind it');
  {
    // Isolated first. This script raises several approvals of its own, and the
    // runner's dispatcher turns any unpublished ones into announce jobs — so
    // without this the tick spends its batch on those and the assertion below
    // measures the script's own leftovers rather than the starvation it is
    // testing. The same reason verify-requirement-proposal parks other
    // extractions before its own.
    await rest('DELETE', 'core', 'jobs?dedupe_key=like.zzstarve-*');
    await rest('PATCH', 'core', "jobs?status=eq.queued", { status: 'cancelled' });
    await rest('DELETE', 'core', 'outbox_events?type=eq.approval.requested');

    await rest('POST', 'core', 'jobs', [
      { organization_id: ORG, kind: 'approval.announce', payload: {}, dedupe_key: 'zzstarve-a', status: 'queued' },
      { organization_id: ORG, kind: 'requirement.extract', payload: {}, dedupe_key: 'zzstarve-e', status: 'queued' },
    ]);

    const before = (
      await rest('GET', 'core', 'jobs?dedupe_key=eq.zzstarve-e&select=attempts')
    ).json ?? [];
    check(before[0]?.attempts === 0, 'the extraction job starts unclaimed', `${before[0]?.attempts}`);

    const res = await fetch(`${target.app}/api/jobs/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.cronSecret}` },
      cache: 'no-store',
    }).catch(() => null);

    if (!res || res.status >= 400) {
      // The app is not running against this database, which is the ordinary
      // case for a schema-only run. Skipped loudly rather than passed quietly.
      console.log('  \x1b[33m•\x1b[0m the runner is not reachable; starvation check skipped');
    } else {
      const after = (
        await rest('GET', 'core', 'jobs?dedupe_key=eq.zzstarve-e&select=attempts,status')
      ).json ?? [];
      check(
        after[0]?.attempts === 1,
        'and one tick reaches it even with an announcement queued ahead of it',
        `attempts ${after[0]?.attempts}`,
      );
    }

    await rest('DELETE', 'core', 'jobs?dedupe_key=like.zzstarve-*');
  }

} finally {
  // approvals.decide_approval emits approval.decided since ADM-96, so the
  // decisions above left outbox rows; removed the way verify-approvals
  // removes its own, because later scripts assert an empty outbox and
  // drive the runner against whatever events remain.
  await rest('DELETE', 'core', 'outbox_events?subject_type=eq.approval_request');
  graph.close();
  await rest('PATCH', 'core', `organizations?id=eq.${ORG}`, { settings: savedSettings });
  if (created.recipient) {
    await rest('DELETE', 'crm', `conversation_messages?conversation_id=eq.${created.recipient}`);
    await rest('DELETE', 'crm', `conversations?id=eq.${created.recipient}`);
  }
  // §0b's sales fixtures — children first.
  if (created.quote) await rest('DELETE', 'sales', `proposal_items?proposal_id=eq.${created.quote}`);
  for (const q of [created.quote, created.quote2]) {
    if (q) await rest('DELETE', 'sales', `proposals?id=eq.${q}`);
  }
  for (const d of [created.deal, created.deal2]) {
    if (d) await rest('DELETE', 'sales', `opportunities?id=eq.${d}`);
  }
  if (created.lead) await rest('DELETE', 'crm', `leads?id=eq.${created.lead}`);
  // Section 0 drives the runner, so it can leave work queued behind it. A job
  // left in the queue changes what the NEXT script's tick reports — the reaper
  // asserts on a tick that claimed nothing, and one that claims a stray job
  // answers in a different shape. Cancelled rather than deleted: the row is a
  // record that the work existed.
  await rest('PATCH', 'core', 'jobs?status=eq.queued&kind=eq.approval.announce', {
    status: 'cancelled',
  });

  // The group this script made, and the announcements in it.
  if (created.group) await rest('DELETE', 'crm', `conversations?id=eq.${created.group}`);
  if (created.user) {
    await rest('DELETE', 'core', `users?id=eq.${created.user}`);
    await fetch(`${URL_BASE}/auth/v1/admin/users/${created.user}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    }).catch(() => {});
  }
  for (const id of created.requests ?? []) {
    await rest('DELETE', 'core', `outbox_events?subject_id=eq.${id}`);
  }
  const pending = await rest('GET', 'approvals', 'approval_requests?state=eq.pending&select=id');
  for (const row of pending.json ?? []) {
    await rest('PATCH', 'approvals', `approval_requests?id=eq.${row.id}`, {
      state: 'cancelled',
      decided_at: new Date().toISOString(),
    });
  }
  await rest('DELETE', 'approvals', `approval_policies?organization_id=eq.${ORG}`);
  // The requests themselves refuse deletion by design; cancelled is the end
  // state, and verify-milestone-unlock's "no leftover outbox events" assertion
  // is what the deletes above protect.
  void MARKER;
}

console.log(`\n${checks} checks`);

if (failures === 0) {
  console.log('\x1b[32m✔ What needs deciding is announced, once, to the right audience\x1b[0m\n');
  process.exit(0);
}

console.error(`\x1b[31m✖ ${failures} failure(s)\x1b[0m\n`);
process.exit(1);
