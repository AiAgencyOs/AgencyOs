-- ═══════════════════════════════════════════════════════════════════════════
-- How often is too often — G-216
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Nothing in this system limits how often it messages somebody. A grep for
-- `rate_limit`, `fatigue` and `cooldown` across `src/`, `app/` and every
-- migration returns nothing at all.
--
-- That was survivable while the follow-up engine could not deliver anything
-- (G-213) and while enrolment was one lead at a time. It stops being
-- survivable the moment templates are approved and twelve hundred historical
-- leads become reachable: the same machinery that could not send once would
-- then be able to send to everybody, repeatedly, with nothing in the way but
-- the shape of ADM-11's rhythms.
--
-- ── the line this draws, and why it is drawable ───────────────────────────
--
-- These limits govern messages the AGENCY starts. They do not govern replies.
--
-- The distinction is not a judgement call, because Meta already made it: a
-- contact who wrote within 24 hours is in an open conversation and what we
-- send is an ANSWER; outside that window every message is business-initiated
-- and needs an approved template. So `crm.window_state` is the same boundary
-- twice — once for what may be sent, and once for whether it counts against
-- a limit. A client asking four questions in an afternoon gets four answers
-- and no limit is touched.
--
-- ── fatigue is not a rate ─────────────────────────────────────────────────
--
-- A rate says "no more than N a week". Fatigue says "they have not answered
-- the last three, so stop for a while". Both are here because they catch
-- different failures: a rate stops a burst, and fatigue stops a slow, polite,
-- entirely-within-the-rate campaign against somebody who is plainly not
-- interested. The second is the one that gets a WhatsApp number reported.
--
-- ── the defaults are conservative on purpose ──────────────────────────────
--
-- A deployment that never opens this screen should not be able to spam
-- anybody. So the defaults are what a careful person would choose — one a
-- day, three a week, stop after three unanswered — rather than what a
-- campaign would like.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.outreach_limits (
  organization_id  uuid primary key references core.organizations(id) on delete cascade,

  -- Per person. The number that stops a burst.
  per_contact_per_day   int not null default 1  check (per_contact_per_day   between 0 and 20),
  per_contact_per_week  int not null default 3  check (per_contact_per_week  between 0 and 60),

  -- Per organization, per day. The number that stops a runaway campaign
  -- reaching everybody before anybody notices. Zero means "send nothing",
  -- which is a legitimate way to pause an agency's outreach entirely.
  per_organization_per_day int not null default 200 check (per_organization_per_day between 0 and 100000),

  -- Fatigue. After this many business-initiated messages with no reply of any
  -- kind, stop contacting them for this many days.
  unanswered_before_cooldown int not null default 3  check (unanswered_before_cooldown between 1 and 20),
  cooldown_days              int not null default 30 check (cooldown_days between 1 and 365),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table crm.outreach_limits is
  'How often this organization may start a conversation (G-216). Governs business-initiated messages only — a reply inside WhatsApp''s 24-hour window is an answer, not outreach, and is never counted. One row per organization; absent means the conservative defaults below apply.';

alter table crm.outreach_limits enable row level security;

drop policy if exists outreach_limits_select on crm.outreach_limits;
create policy outreach_limits_select on crm.outreach_limits
  for select using (
    core.is_internal() and organization_id = core.current_organization_id()
  );

drop policy if exists outreach_limits_write on crm.outreach_limits;
create policy outreach_limits_write on crm.outreach_limits
  for all using (
    core.is_admin() and organization_id = core.current_organization_id()
  ) with check (
    core.is_admin() and organization_id = core.current_organization_id()
  );

-- An org-scoped table cannot be re-tenanted, and `verify-tenancy-guards`
-- checks the catalogue rather than trusting anybody to remember. The first
-- version of this table forgot, and the chain said so.
drop trigger if exists freeze_org_outreach_limits on crm.outreach_limits;
create trigger freeze_org_outreach_limits
  before update on crm.outreach_limits
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at on crm.outreach_limits;
create trigger set_updated_at
  before update on crm.outreach_limits
  for each row execute function core.set_updated_at();

grant select on crm.outreach_limits to authenticated, service_role;
grant insert, update, delete on crm.outreach_limits to authenticated, service_role;

/**
 * The limits in force, whether or not anybody set them.
 *
 * A missing row is not "no limits": it is the defaults. A deployment that has
 * never opened the screen must still be unable to spam anybody, which is the
 * opposite of how an unset configuration usually behaves and is the whole
 * reason this function exists rather than a plain select.
 */
create or replace function crm.outreach_limits_for(p_organization_id uuid)
returns crm.outreach_limits
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select l from crm.outreach_limits l where l.organization_id = p_organization_id),
    row(
      p_organization_id,
      1,      -- per_contact_per_day
      3,      -- per_contact_per_week
      200,    -- per_organization_per_day
      3,      -- unanswered_before_cooldown
      30,     -- cooldown_days
      now(), now()
    )::crm.outreach_limits
  )
$$;

comment on function crm.outreach_limits_for(uuid) is
  'The limits in force for an organization, defaults included (G-216). A missing row is the conservative default rather than no limit, so a deployment that never opens the screen still cannot spam anybody.';

/**
 * May this organization start a conversation with this thread's counterpart?
 *
 * Answers a reason, not a boolean: 'ok', or the specific rule that refused,
 * because a person reading a suppressed send needs to know which number to
 * change.
 *
 * Counted per COUNTERPART NUMBER rather than per conversation, for the same
 * reason G-214 measures the window that way: two threads with one person are
 * still one person, and a limit that counts threads is a limit somebody can
 * walk around by accident.
 */
create or replace function crm.outreach_allowance(p_conversation_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org        uuid;
  v_digits     text;
  v_limits     crm.outreach_limits;
  v_today      int;
  v_week       int;
  v_org_today  int;
  v_last_in    timestamptz;
  v_unanswered int;
begin
  select c.organization_id, crm.conversation_counterpart_digits(c.id)
    into v_org, v_digits
    from crm.conversations c
   where c.id = p_conversation_id;

  if v_org is null then
    return 'no_conversation';
  end if;

  -- A group has no counterpart and no window; these limits are about a person
  -- being contacted repeatedly, and there is nobody here to be.
  if v_digits is null then
    return 'ok';
  end if;

  v_limits := crm.outreach_limits_for(v_org);

  -- Every thread this organization holds with this number.
  with peers as (
    select peer.id
      from crm.conversations peer
      left join crm.contacts ct on ct.id = peer.contact_id
     where peer.organization_id = v_org
       and case
             when peer.kind in ('project_group', 'internal_group') then null
             when peer.kind = 'internal_direct'
               then nullif(regexp_replace(peer.external_ref, '\D', '', 'g'), '')
             else nullif(regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g'), '')
           end = v_digits
  ),
  /**
   * Business-initiated messages only.
   *
   * `outreach` marks a message as one the agency started: an outbound message
   * sent when the window was NOT open at the time. It cannot be recomputed
   * from history — the window at the moment of sending is not recoverable
   * afterwards — so the sender records it, and this reads what was recorded.
   */
  outreach as (
    select m.occurred_at
      from crm.conversation_messages m
      join peers on peers.id = m.conversation_id
     where m.author_type <> 'client'
       and coalesce((m.metadata->>'outreach')::boolean, false)
  ),
  inbound as (
    select max(m.occurred_at) as last_at
      from crm.conversation_messages m
      join peers on peers.id = m.conversation_id
     where m.author_type = 'client'
  )
  select
    (select count(*) from outreach where occurred_at > now() - interval '1 day'),
    (select count(*) from outreach where occurred_at > now() - interval '7 days'),
    (select last_at from inbound),
    (select count(*) from outreach o
      where o.occurred_at > coalesce((select last_at from inbound), '-infinity'::timestamptz))
    into v_today, v_week, v_last_in, v_unanswered;

  if v_today >= v_limits.per_contact_per_day then
    return 'per_contact_per_day';
  end if;

  if v_week >= v_limits.per_contact_per_week then
    return 'per_contact_per_week';
  end if;

  -- Fatigue. Counted since their last message of any kind, so one reply
  -- clears it completely — which is right: they answered.
  if v_unanswered >= v_limits.unanswered_before_cooldown then
    -- The cooldown runs from the newest unanswered attempt, not from the
    -- first. Otherwise a long slow campaign would exit its own cooldown while
    -- still adding to the pile.
    if (select max(o.occurred_at) from crm.conversation_messages o
          join crm.conversations peer on peer.id = o.conversation_id
          left join crm.contacts ct2 on ct2.id = peer.contact_id
         where peer.organization_id = v_org
           and o.author_type <> 'client'
           and coalesce((o.metadata->>'outreach')::boolean, false)
           and case
                 when peer.kind in ('project_group', 'internal_group') then null
                 when peer.kind = 'internal_direct'
                   then nullif(regexp_replace(peer.external_ref, '\D', '', 'g'), '')
                 else nullif(regexp_replace(coalesce(ct2.phone, ''), '\D', '', 'g'), '')
               end = v_digits
        ) > now() - make_interval(days => v_limits.cooldown_days)
    then
      return 'cooldown';
    end if;
  end if;

  select count(*)
    into v_org_today
    from crm.conversation_messages m
    join crm.conversations c on c.id = m.conversation_id
   where c.organization_id = v_org
     and m.author_type <> 'client'
     and coalesce((m.metadata->>'outreach')::boolean, false)
     and m.occurred_at > now() - interval '1 day';

  if v_org_today >= v_limits.per_organization_per_day then
    return 'per_organization_per_day';
  end if;

  return 'ok';
end;
$$;

comment on function crm.outreach_allowance(uuid) is
  'Whether this organization may start a conversation with this thread''s counterpart right now, and if not, WHICH rule refused (G-216). Counts only messages marked as outreach — business-initiated, sent outside WhatsApp''s 24-hour window — per counterpart NUMBER, so two threads with one person are still one person.';

/**
 * Marks a message as one the agency started.
 *
 * Written by the sender at the moment of sending, because the window at that
 * moment is the only thing that distinguishes outreach from an answer, and it
 * is not recoverable afterwards.
 */
create or replace function crm.mark_message_as_outreach(p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated int;
begin
  update crm.conversation_messages m
     set metadata = m.metadata || jsonb_build_object('outreach', true)
   where m.id = p_message_id
     and m.author_type <> 'client'
     -- SECURITY DEFINER, so the tenant check is this function's own. A signed
     -- in caller may only mark a message in their own organization; the job
     -- runner (no auth.uid()) is unrestricted, exactly as the other senders
     -- are. Without this, an org owner could mark another tenant's messages
     -- as outreach and spend their limits for them.
     and (
       (select auth.uid()) is null
       or m.organization_id = (select core.current_organization_id())
     );

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- ── what these limits deliberately do not count ───────────────────────────
--
-- The one-off template that tells a client their quotation is ready (G-214)
-- is not recorded as a message, so it is not counted here. It is still
-- GOVERNED — `planOutbound` asks this function before sending it — and it
-- cannot repeat, because a job that has already told somebody does not tell
-- them twice. A message that can happen at most once per quotation is not a
-- fatigue risk; counting it would need a message row nobody would read.

comment on function crm.mark_message_as_outreach(uuid) is
  'Records that a message was business-initiated — sent while WhatsApp''s 24-hour window was shut (G-216). Written at send time because the window at that moment is not recoverable afterwards. Refuses to mark a client''s own message.';

revoke all on function crm.mark_message_as_outreach(uuid) from public, anon;
grant execute on function crm.mark_message_as_outreach(uuid) to authenticated, service_role;

-- ── a send held by a limit waits for the limit, not for a reply ───────────
--
-- G-214's park is for a send waiting on WhatsApp's window, which only a
-- client's message can open — so it waits over the horizon and their reply
-- wakes it. A send held by a daily limit is waiting for a clock, and parking
-- an approved quotation for thirty days because of a per-day count would be
-- the cure being worse than the disease.
create or replace function crm.defer_send(
  p_job_id uuid,
  p_conversation_id uuid,
  p_reason text,
  p_until timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job         core.jobs;
  v_digits      text;
begin
  select * into v_job from core.jobs where id = p_job_id;
  if v_job.id is null then
    return 'no_job';
  end if;

  select c.id into v_digits
    from crm.conversations c
   where c.id = p_conversation_id
     and c.organization_id = v_job.organization_id;
  if v_digits is null then
    return 'wrong_tenant';
  end if;

  v_digits := crm.conversation_counterpart_digits(p_conversation_id);
  if v_digits is null then
    return 'no_counterpart';
  end if;

  update core.jobs
     set status     = 'queued',
         -- EDIT (G-216): a caller that knows WHEN the obstacle clears says so.
         -- Absent, the obstacle is the window and only a reply clears it.
         run_at     = coalesce(p_until, now() + interval '30 days'),
         locked_at  = null,
         locked_by  = null,
         attempts   = greatest(attempts - 1, 0),
         last_error = left(p_reason, 500),
         updated_at = now()
   where id = p_job_id;

  insert into crm.deferred_sends (
    organization_id, job_id, conversation_id, counterpart_digits, reason
  )
  values (
    v_job.organization_id, p_job_id, p_conversation_id, v_digits, left(p_reason, 500)
  )
  on conflict (job_id) do update
    set reason          = excluded.reason,
        conversation_id = excluded.conversation_id,
        counterpart_digits = excluded.counterpart_digits,
        deferred_at     = now(),
        woken_at        = null,
        updated_at      = now();

  return 'deferred';
end;
$$;

comment on function crm.defer_send(uuid, uuid, text, timestamptz) is
  'Parks an outbound job until its counterpart writes, or until a given time (G-214, G-216): the job stays queued, the attempt it spent discovering the obstacle is given back, and a deferred_sends row records why. `p_until` is for an obstacle a clock clears — a daily limit — where waiting for a reply would be the cure being worse than the disease. Refuses a conversation outside the job''s organization.';

revoke all on function crm.defer_send(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function crm.defer_send(uuid, uuid, text, timestamptz) to service_role;

-- The three-argument form is gone: every caller passes four now, and leaving
-- it would be a second door into the same room with different manners.
drop function if exists crm.defer_send(uuid, uuid, text);
