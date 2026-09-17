-- ═══════════════════════════════════════════════════════════════════════════
-- Only what is still missing.
--
-- PM §4.2, §4.3, §6 PM-03 and PM-05.
--
-- Three sentences across the specification say one thing:
--
--   PM-03: *"Do not re-ask known details."*
--   PM-03: *"Request only the first set of missing required information."*
--   §4.2:  *"Ask one clear question/request at the appropriate time."*
--
-- G-252 answered the first for **inherited Phase 1 context**. This answers all
-- three for the **onboarding checklist** — the operational list a PM actually
-- works through, which only became capable of carrying the answer when G-261
-- gave it `requirement` and `waiting_client`.
--
-- ── what it will not do, and why that is not this unit's gap ─────────────
--
-- It does not SEND, and it does not schedule a follow-up. §4.2 says *"track
-- unanswered requests and follow up according to policy"* and §15 says
-- *"WAITING_CLIENT + policy-based follow-up"* — and **there is no policy**.
-- Every registered follow-up situation carries a rhythm with day values
-- somebody decided; none covers onboarding, and inventing one would be exactly
-- what `pending_payment`'s own record refuses: *"ADM-69 states no day values
-- for its Payment-Followup rhythm. Running it would mean inventing both."*
--
-- Raised as **ADM-109**. What is built here is the part that does not depend
-- on it: *which* things are still worth asking, and *which one* to ask next.
-- Any cadence, on any channel, needs that list first.
--
-- ── outstanding is not the same as askable ──────────────────────────────
--
-- Three states are all "not settled", and only ONE of them is a question for
-- the client:
--
--   * `pending` — nobody has asked. **This is the only askable state.**
--   * `waiting_client` — asked, no answer yet. Asking again is how a client
--     learns their answers are not being read.
--   * `received` — they sent it and **nobody here has checked it**. The
--     blocker is ours, not theirs, and asking again would be asking for
--     something already sitting in the thread.
--
-- The first draft of this function got `received` wrong and offered it as the
-- next question. That was found by driving it, not by reading it: the test
-- output showed a client being asked for assets they had already provided.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.outstanding_client_requests(p_project_id uuid)
returns table (
  item_id      uuid,
  key          text,
  label        text,
  status       text,
  -- Not `position`: reserved, and a bare one is parsed as POSITION(x IN y)
  -- here too, not only in a select list.
  list_position int,
  -- Asked, and they have not answered.
  with_client  boolean,
  -- They answered, and nobody here has checked it. Outstanding, but ours.
  with_us      boolean,
  -- The single item §4.2's "one clear question at a time" points at. True on
  -- at most one row.
  ask_next     boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with outstanding as (
    select
      oi.id,
      oi.key,
      oi.label,
      oi.status,
      -- Aliased: bare `position` in a select list parses as the POSITION(x IN
      -- y) function, which is a syntax error rather than a column.
      oi.position as list_position,
      oi.status = 'waiting_client' as with_client,
      oi.status = 'received' as with_us
      from projects.onboarding_items oi
     where oi.project_id = p_project_id
       -- REQUIRED only. ADM-06 says the checklist blocks nothing and G-261
       -- left `requirement` null until somebody decides; an item nobody
       -- marked required is not a thing to chase a client about.
       and oi.requirement = 'required'
       -- Settled items are not missing. `received` still is: something arrived
       -- and nobody has checked it, which is not the same as having it.
       and oi.status not in ('verified', 'not_applicable')
       -- The items the agency owes itself are not questions for a client.
       and oi.key not in ('kickoff_sent', 'project_activated', 'whatsapp_group_mapped',
                          'payment_verified', 'project_manager_assigned', 'specialist_agents_assigned')
  )
  select
    o.id, o.key, o.label, o.status, o.list_position, o.with_client, o.with_us,
    -- The first unasked one, in checklist order — which Document 10 §6 chose
    -- as roughly the order the work happens in, so the next question is the
    -- next thing that matters rather than the next row a query happened to
    -- return.
    -- `pending` only. The other two outstanding states are waiting on the
    -- client's reply or on us, and neither is a new question.
    -- Coalesced: with nothing askable the subquery is NULL, and `id = NULL`
    -- is NULL rather than false. A caller writing `not ask_next` would then
    -- silently drop every row instead of getting all of them.
    coalesce(o.id = (select o2.id from outstanding o2 where o2.status = 'pending'
                      order by o2.list_position, o2.id limit 1), false) as ask_next
    from outstanding o
   order by o.list_position, o.id;
$$;

comment on function projects.outstanding_client_requests(uuid) is
  'PM section 4.2 and PM-03/PM-05 - what is still worth asking this client, and which single thing to ask next. Required items only (ADM-06 and G-261: an item nobody marked required is not a thing to chase a client about), settled items excluded, and an item already put to the client stays outstanding but is never the next question, because asking twice is how a client learns their answers are not being read. It does not send and does not schedule: no follow-up policy covers onboarding, which is ADM-109.';

revoke all on function projects.outstanding_client_requests(uuid) from public, anon;
grant execute on function projects.outstanding_client_requests(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
