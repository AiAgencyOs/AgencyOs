-- ═══════════════════════════════════════════════════════════════════════════
-- Finding who is waiting.
--
-- Gap G-012, decision ADM-69. The observation layer: which subjects are
-- currently owed a follow-up sequence.
--
-- ── observe, decide, claim, send, record ─────────────────────────────────
--
-- This is only the first of those. It **finds** and never sends, never
-- claims, and never decides whether a message is permitted. It returns facts;
-- `follow-up-contract.ts` applies ADM-69's ten steps to them, and
-- `crm.send_outbound_message` decides whether the result may go out.
--
-- Keeping the split means one place to change a query and one place to change
-- a policy, and neither can quietly become the other.
--
-- ── five of seven, and the two that are missing are missing on purpose ────
--
-- ADM-69 lists eight situations, seven of them runnable. Five map to facts
-- this schema actually records:
--
--   1  no response after quotation   `sales.proposals` sent, `sent_at`
--   4  abandoned conversation        no inbound message since `sent_at`
--   5  pending approval              `approval_requests` still pending
--   7  inactive lead                 an open lead with no recent activity
--   8  post-project                  `projects.completed_at`
--
-- **Situations 2 and 3 are not implemented**, and the reason is specific
-- rather than a shrug. In this schema `sales.proposals` **is** the quotation —
-- Document 09 calls the row a quotation and the table keeps the older name —
-- so "no response after requirements request" and "no response after
-- proposal" have no fact that distinguishes them from situation 1.
--
-- Pointing all three at `sales.proposals` would start three sequences against
-- one client for one silence, each idempotent in isolation and all three
-- messaging on the same days. That is the precise harm ADM-69's idempotency
-- requirement exists to prevent, arrived at by inventing triggers rather than
-- reading them. Recorded as its own gap instead.
--
-- ── organization_id is derived, never accepted ───────────────────────────
--
-- Every row below takes its `organization_id` from the authoritative record —
-- the proposal, the lead, the approval request — and no argument can supply
-- one. A caller cannot ask "find candidates in that tenant".
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.observe_follow_up_candidates(p_limit int default 200)
returns table (
  organization_id uuid,
  situation_key   text,
  subject_type    text,
  subject_id      uuid,
  conversation_id uuid,
  triggered_at    timestamptz,
  contact_id      uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  -- ── 1. no response after quotation ─────────────────────────────────────
  --
  -- Day 0 is `sent_at`: the moment the client was actually asked. `sent` is
  -- the only status that means "waiting on them" — G-111's `lapsed` has its
  -- own meaning and its own handling, and accepted, rejected and superseded
  -- are answers.
  select p.organization_id,
         'no_response_after_quotation'::text,
         'proposal'::text,
         p.id,
         p.conversation_id,
         p.sent_at,
         c.contact_id
    from sales.proposals p
    join sales.opportunities o on o.id = p.opportunity_id
    left join crm.conversations c on c.id = p.conversation_id
   where p.status = 'sent'
     and p.sent_at is not null
     and o.stage not in ('won', 'lost')
     and not exists (
       select 1 from crm.follow_up_sequences s
        where s.organization_id = p.organization_id
          and s.situation_key = 'no_response_after_quotation'
          and s.subject_type = 'proposal'
          and s.subject_id = p.id
     )

  union all

  -- ── 4. abandoned conversation ──────────────────────────────────────────
  --
  -- Day 0 is the last message of any kind. "Abandoned" is silence after
  -- contact, so a thread with no messages at all is not abandoned — it never
  -- started, and chasing it would be a first approach dressed as a follow-up.
  --
  -- Only `direct` threads. A project group has no single contact and G-136
  -- has not decided whether membership permits messaging it; an internal
  -- group is not a client at all.
  select cv.organization_id,
         'abandoned_conversation'::text,
         'lead'::text,
         cv.lead_id,
         cv.id,
         m.last_at,
         cv.contact_id
    from crm.conversations cv
    join crm.leads l on l.id = cv.lead_id
    join lateral (
      select max(cm.occurred_at) as last_at
        from crm.conversation_messages cm
       where cm.conversation_id = cv.id
    ) m on true
   where cv.kind = 'direct'
     and cv.status = 'active'
     and cv.lead_id is not null
     and m.last_at is not null
     and l.status not in ('converted', 'disqualified')
     and l.deleted_at is null
     and not exists (
       select 1 from crm.follow_up_sequences s
        where s.organization_id = cv.organization_id
          and s.situation_key = 'abandoned_conversation'
          and s.subject_type = 'lead'
          and s.subject_id = cv.lead_id
     )

  union all

  -- ── 5. pending approval ────────────────────────────────────────────────
  --
  -- INTERNAL. ADM-69: "explicitly NOT governed by the client/lead consent
  -- gate." No contact and no conversation are selected, because there is no
  -- client on the other end — the announcer resolves the internal group
  -- itself, as G-110 already does.
  select a.organization_id,
         'pending_approval'::text,
         'approval_request'::text,
         a.id,
         null::uuid,
         a.created_at,
         null::uuid
    from approvals.approval_requests a
   where a.state = 'pending'
     and a.audience = 'internal'
     and not exists (
       select 1 from crm.follow_up_sequences s
        where s.organization_id = a.organization_id
          and s.situation_key = 'pending_approval'
          and s.subject_type = 'approval_request'
          and s.subject_id = a.id
     )

  union all

  -- ── 7. inactive lead ───────────────────────────────────────────────────
  --
  -- Day 0 is the most recent thing that happened to the lead — an activity if
  -- there is one, otherwise its creation. A lead that has never been touched
  -- is still inactive; using only activity would silently exclude exactly the
  -- leads nobody has looked at.
  --
  -- `qualified` is included with `new` and `qualifying`: a qualified lead that
  -- nobody progressed is the clearest case of one going cold.
  select l.organization_id,
         'inactive_lead'::text,
         'lead'::text,
         l.id,
         cv.id,
         greatest(l.created_at, coalesce(act.last_at, l.created_at)),
         l.contact_id
    from crm.leads l
    left join lateral (
      select max(la.occurred_at) as last_at
        from crm.lead_activities la
       where la.lead_id = l.id
    ) act on true
    left join lateral (
      select c2.id
        from crm.conversations c2
       where c2.lead_id = l.id and c2.kind = 'direct'
       order by c2.created_at desc
       limit 1
    ) cv on true
   where l.status in ('new', 'qualifying', 'qualified')
     and l.deleted_at is null
     and not exists (
       select 1 from crm.follow_up_sequences s
        where s.organization_id = l.organization_id
          and s.situation_key = 'inactive_lead'
          and s.subject_type = 'lead'
          and s.subject_id = l.id
     )

  union all

  -- ── 8. post-project ────────────────────────────────────────────────────
  --
  -- Day 0 is `completed_at`. The contact comes from the client account rather
  -- than a conversation, because a finished project's thread may be closed and
  -- the relationship outlives it — which is the whole reason the lifecycle
  -- continues past `completed`.
  select pr.organization_id,
         'post_project'::text,
         'project'::text,
         pr.id,
         null::uuid,
         pr.completed_at,
         ct.id
    from projects.projects pr
    left join lateral (
      select c3.id
        from crm.contacts c3
       where c3.client_account_id = pr.client_account_id
       order by c3.created_at
       limit 1
    ) ct on true
   where pr.status = 'completed'
     and pr.completed_at is not null
     and pr.deleted_at is null
     and not exists (
       select 1 from crm.follow_up_sequences s
        where s.organization_id = pr.organization_id
          and s.situation_key = 'post_project'
          and s.subject_type = 'project'
          and s.subject_id = pr.id
     )

  limit p_limit;
$$;

comment on function crm.observe_follow_up_candidates(int) is
  'Finds subjects owed a follow-up sequence (G-012, ADM-69). OBSERVES ONLY: it never sends, never claims and never decides whether a message is permitted - the contract applies ADM-69 ten steps and crm.send_outbound_message decides permission. Five of the seven runnable situations; 2 and 3 are deliberately absent because sales.proposals IS the quotation in this schema, so no fact distinguishes them from situation 1, and pointing all three at it would chase one client three times for one silence. organization_id is derived from the authoritative record and cannot be supplied by a caller.';

revoke all on function crm.observe_follow_up_candidates(int) from public;
grant execute on function crm.observe_follow_up_candidates(int) to service_role;

-- ── the other half: sequences already running and now due ────────────────
--
-- Kept separate from the observer above because they answer different
-- questions. One asks "who should be chased"; this asks "who is already being
-- chased and is due next". Merging them would make a query that starts and
-- advances in one pass, and the two have different failure modes.

create or replace function crm.due_follow_up_sequences(p_limit int default 200)
returns table (
  sequence_id     uuid,
  organization_id uuid,
  situation_key   text,
  subject_type    text,
  subject_id      uuid,
  conversation_id uuid,
  triggered_at    timestamptz,
  attempts_sent   int,
  correlation_id  uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.organization_id, s.situation_key, s.subject_type, s.subject_id,
         s.conversation_id, s.triggered_at, s.attempts_sent, s.correlation_id
    from crm.follow_up_sequences s
   where s.status = 'active'
     and s.next_due_at is not null
     and s.next_due_at <= now()
   order by s.next_due_at
   limit p_limit;
$$;

comment on function crm.due_follow_up_sequences(int) is
  'Sequences already running whose next attempt is due (G-012). Separate from the observer because the two answer different questions - who should be chased, versus who is being chased and is due next - and merging them would build one query that both starts and advances, with different failure modes on each side.';

revoke all on function crm.due_follow_up_sequences(int) from public;
grant execute on function crm.due_follow_up_sequences(int) to service_role;
