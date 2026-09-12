// ═══════════════════════════════════════════════════════════════════════════
// Shared fixtures for the live verifiers — the ones that need a deal to be
// WON the way G-230 now requires.
//
// Before G-230 a verifier could PATCH an opportunity to stage='won' — or
// INSERT one already won — and move on. Six did: verify-won-gate (its own
// subject), verify-memory (client memory is written on the win),
// verify-sales-funnel (the won counter), and three that a pre-PR review found
// still inserting deals born won — verify-deal-terms, verify-second-engagement
// and verify-returning-client, the first of which runs before every new CI
// step. All six now need an ACCEPTED quotation first, and acceptance is the
// end of a governed path — draft → items → submit (raises the owner's approval) → the
// owner approves → sync → send → the client accepts. That is six RPCs, an
// owner JWT, and a money-floor policy, and it is the same six for every
// verifier. So it lives here once.
//
// Everything here goes through the real doors. Nothing inserts a proposal
// already accepted — sales.proposals_guard refuses that on INSERT, which is
// precisely the guard the first draft of verify-won-gate tripped over.
// ═══════════════════════════════════════════════════════════════════════════

import { Buffer } from 'node:buffer';
import { createHmac, randomUUID } from 'node:crypto';

const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return t; } };
const one = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);

/** The order the governed path runs in. `advanceProposal` walks it from a fresh draft. */
const LADDER = ['draft', 'pending_approval', 'approved', 'sent', 'accepted'];

/**
 * Bind the helpers to one target. `target` is what resolveTarget() returns
 * with `{ jwt: true }` — the JWT secret is needed to mint the owner.
 */
export function fixturesFor(target, org) {
  const URL_BASE = target.url;
  const KEY = target.serviceKey;

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
    return { ok: res.ok, status: res.status, json: parse(text), text };
  }
  const rest = (m, s, p, b) => call(KEY, m, s, p, b);

  /**
   * An HS256 JWT PostgREST will accept, carrying the tenancy claims the hook
   * would set. `orgId` defaults to the bound organization; a verifier proving a
   * tenancy refusal must pass ANOTHER one — review found a 'foreign owner'
   * minted for the same org, so the refusal it asserted could never fire.
   */
  function mint(userId, role, orgId = org) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const h = b64({ alg: 'HS256', typ: 'JWT' });
    const b = b64({
      sub: userId, aud: 'authenticated', role: 'authenticated',
      app_metadata: { organization_id: orgId, role }, iat: now, exp: now + 900,
    });
    return `${h}.${b}.${createHmac('sha256', target.jwtSecret).update(`${h}.${b}`).digest('base64url')}`;
  }

  // Every id the governed path touches, so cleanup can find what it emitted.
  const created = { users: [], policies: [], opportunities: [], proposals: [], approvals: [] };

  /**
   * An owner of `org` who can approve a quotation. Created through Supabase
   * Auth, mirrored into core.users, given a membership, and minted a token.
   */
  async function bootstrapOwner(marker) {
    const authUser = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ email: `${marker}-owner@example.invalid`, password: randomUUID(), email_confirm: true }),
    }).then((r) => r.json());
    if (!authUser?.id) throw new Error(`could not create an auth user: ${JSON.stringify(authUser).slice(0, 200)}`);
    created.users.push(authUser.id);
    await rest('POST', 'core', 'users', { id: authUser.id, email: authUser.email });
    await rest('POST', 'core', 'memberships', { organization_id: org, user_id: authUser.id, role: 'owner', status: 'active' });
    return { id: authUser.id, token: mint(authUser.id, 'owner') };
  }

  /** The proposal money-floor policy (ADM-07: at the owner). Idempotent per org. */
  async function installProposalPolicy(owner) {
    const existing = await rest('GET', 'approvals', `approval_policies?organization_id=eq.${org}&subject_type=eq.proposal&select=id`);
    if ((existing.json ?? []).length > 0) return;
    const row = one(await call(owner.token, 'POST', 'approvals', 'approval_policies', {
      organization_id: org, subject_type: 'proposal', min_amount_minor: 0,
      required_role: 'owner', sla_hours: 48, audience: 'internal',
    }));
    if (row?.id) created.policies.push(row.id);
  }

  /** A fresh draft on `opportunityId`, through the real door. */
  async function draftProposal(opportunityId, title) {
    const draft = one(await rest('POST', 'sales', 'rpc/draft_proposal', { p_opportunity_id: opportunityId, p_title: title }));
    if (!created.opportunities.includes(opportunityId)) created.opportunities.push(opportunityId);
    if (draft?.proposal_id) created.proposals.push(draft.proposal_id);
    return { id: draft?.proposal_id ?? null, draft };
  }

  /**
   * Walk a FRESH draft up the governed ladder to `toState`, returning every
   * intermediate answer so a verifier can say which door refused rather than
   * "the fixture failed". Assumes the proposal is a draft with no items —
   * which is what draftProposal() hands back.
   */
  async function advanceProposal(id, owner, toState, { totalMinor = 100_000, messageRef = 'wamid.FIXTURE', contactId = null, conversationId = null } = {}) {
    const trace = {};
    const stop = LADDER.indexOf(toState);
    if (stop < 1) return trace;

    trace.item = one(await rest('POST', 'sales', 'rpc/add_proposal_item', {
      p_proposal_id: id, p_description: 'The work', p_quantity: 1, p_unit_price_minor: totalMinor,
    }));
    trace.submit = one(await rest('POST', 'sales', 'rpc/submit_proposal', { p_proposal_id: id, p_requested_by: owner.id }));
    if (trace.submit?.request_id) created.approvals.push(trace.submit.request_id);
    if (stop < 2) return trace;

    trace.decide = one(await call(owner.token, 'POST', 'approvals', 'rpc/decide_approval', {
      p_request_id: trace.submit?.request_id, p_decision: 'approved',
    }));
    trace.sync = (await rest('POST', 'sales', 'rpc/sync_proposal_decision', { p_proposal_id: id })).json;
    if (stop < 3) return trace;

    // Sent IN a conversation when the verifier has one: the funnel reaches a
    // quotation from its lead through the thread it was sent in, and the first
    // full CI run of verify-sales-funnel counted a quotation sent nowhere as
    // not quoted — which is the funnel being right about a fixture that lied.
    trace.send = one(await rest('POST', 'sales', 'rpc/send_proposal', {
      p_proposal_id: id, p_message_ref: messageRef, ...(conversationId ? { p_conversation_id: conversationId } : {}),
    }));
    if (stop < 4) return trace;

    // The contact is optional at the door (record_proposal_response), so a
    // verifier can accept with nobody named and watch the packet say so.
    trace.accept = one(await rest('POST', 'sales', 'rpc/record_proposal_response', {
      p_proposal_id: id, p_response: 'accepted', ...(contactId ? { p_contact_id: contactId } : {}),
    }));
    return trace;
  }

  /** Draft + advance, for the common case. */
  async function proposalAt(opportunityId, owner, title, toState, options) {
    const { id, draft } = await draftProposal(opportunityId, title);
    if (!id) return { id: null, trace: { draft } };
    const trace = await advanceProposal(id, owner, toState, options);
    return { id, trace: { draft, ...trace } };
  }

  /** A deal with an accepted quotation, ready to be won. */
  const acceptedProposal = (opportunityId, owner, title, options) => proposalAt(opportunityId, owner, title, 'accepted', options);

  async function cleanup() {
    // The events the governed path and the win emitted. They hang off nothing
    // by FK, and the dispatcher reads one page of unpublished events per tick
    // ordered by attempts and then id — a uuid — so a backlog left here made a
    // later verifier's own event miss the first tick: the milestone-unlock
    // verifier went red on PR #399's first full CI run for exactly that. The
    // rows cascade with their opportunities; the events and handoffs do not.
    const subjects = [...new Set([...created.opportunities, ...created.proposals, ...created.approvals])];
    for (let i = 0; i < subjects.length; i += 40) {
      const page = subjects.slice(i, i + 40).join(',');
      await rest('DELETE', 'core', `outbox_events?subject_id=in.(${page})`);
      await rest('DELETE', 'ai', `handoffs?subject_type=eq.opportunity&subject_id=in.(${page})`);
    }
    for (const id of created.policies) await rest('DELETE', 'approvals', `approval_policies?id=eq.${id}`);
    for (const id of created.users) {
      await rest('DELETE', 'core', `memberships?user_id=eq.${id}`);
      await rest('DELETE', 'core', `users?id=eq.${id}`);
      await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, {
        method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, cache: 'no-store',
      }).catch(() => {});
    }
  }

  return {
    call, rest, one, mint,
    bootstrapOwner, installProposalPolicy,
    draftProposal, advanceProposal, proposalAt, acceptedProposal,
    cleanup, created,
  };
}
