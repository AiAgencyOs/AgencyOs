-- Inbound email: the replies, bounces and unsubscribes that arrive on the two mailboxes are read, recorded once and acted on.
--
-- Until now the system only sent. A prospect who answered the campaign kept receiving step two; an address that bounced was tried
-- again; a client who replied by email was invisible to the Project Manager. The worker (src/modules/crm/inbound-email.ts) reads
-- each mailbox, classifies a message (reply / hard bounce / unsubscribe / auto-reply) and calls ONE door, which is the only thing
-- that writes: idempotent per message-id, org-scoped, service role only.
--
--   outreach lane (info@):  a reply stops the prospect's sequence and marks them replied; "unsubscribe / stop" suppresses them for
--                           good; a hard bounce suppresses the address. Nothing is sent from here.
--   client lane (care@):    a reply from a known contact lands in that contact's thread as a client message, so everything that
--                           already reads a thread (the PM, the agents, the Admin's inbox) sees it exactly as it sees a WhatsApp one.
--   anyone else:            recorded as unmatched and raised once for a person - never guessed at.

create table if not exists crm.inbound_emails (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  lane            text not null check (lane in ('client', 'outreach')),
  -- The Message-ID header: what makes a re-read of the same mailbox change nothing.
  message_id      text not null check (length(btrim(message_id)) between 3 and 400),
  from_email      text not null check (from_email = lower(from_email) and length(from_email) <= 320),
  subject         text check (subject is null or length(subject) <= 300),
  received_at     timestamptz not null,
  kind            text not null check (kind in ('reply', 'hard_bounce', 'unsubscribe', 'auto_reply')),
  outcome         text not null,
  conversation_id uuid references crm.conversations(id) on delete set null,
  prospect_id     uuid references crm.outreach_prospects(id) on delete set null,
  recorded_at     timestamptz not null default now(),
  unique (organization_id, message_id)
);

comment on table crm.inbound_emails is
  'One row per email read from a mailbox: what it was and what was done about it. The body is NOT kept here - a reply''s words live in the conversation message it became; a bounce or unsubscribe has nothing worth keeping beyond the address (and that is in the suppression list).';

create index if not exists inbound_emails_org_idx on crm.inbound_emails (organization_id, received_at desc);

alter table crm.inbound_emails enable row level security;
alter table crm.inbound_emails force row level security;
drop policy if exists inbound_emails_admin_read on crm.inbound_emails;
create policy inbound_emails_admin_read on crm.inbound_emails for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()));
revoke all on crm.inbound_emails from public, anon, authenticated;
grant select on crm.inbound_emails to authenticated;
grant select, insert on crm.inbound_emails to service_role;

-- Tenancy: each FK and the organization never move (the guard every org-scoped table carries).
drop trigger if exists freeze_org_inbound_emails on crm.inbound_emails;
create trigger freeze_org_inbound_emails before update of organization_id on crm.inbound_emails for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_inbound_email_conversation on crm.inbound_emails;
create trigger org_match_inbound_email_conversation before insert or update of conversation_id, organization_id on crm.inbound_emails
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');
drop trigger if exists org_match_inbound_email_prospect on crm.inbound_emails;
create trigger org_match_inbound_email_prospect before insert or update of prospect_id, organization_id on crm.inbound_emails
  for each row execute function core.enforce_parent_org('prospect_id', 'crm.outreach_prospects');

-- A record of what was read is history: nobody edits or removes it (except with its organization).
create or replace function crm.inbound_emails_are_history()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from core.organizations where id = old.organization_id) then
    return old;
  end if;
  raise exception 'an inbound email record is history and cannot be edited or removed' using errcode = 'P0001';
end;
$$;
drop trigger if exists inbound_emails_are_history on crm.inbound_emails;
create trigger inbound_emails_are_history before update or delete on crm.inbound_emails for each row execute function crm.inbound_emails_are_history();

-- ── the one door ──

create or replace function crm.ingest_inbound_email(
  p_organization_id uuid,
  p_lane            text,
  p_message_id      text,
  p_from            text,
  p_subject         text,
  p_body            text,
  p_received_at     timestamptz,
  p_kind            text,
  -- For a hard bounce: the address that could not be reached (parsed from the delivery report), not the mailer-daemon.
  p_bounced_email   text default null
)
returns table (outcome text, conversation_id uuid, prospect_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_from     text := lower(btrim(coalesce(p_from, '')));
  v_target   text := lower(btrim(coalesce(p_bounced_email, '')));
  v_msg      text := btrim(coalesce(p_message_id, ''));
  v_outcome  text;
  v_prospect uuid;
  v_conv     uuid;
  v_contact  crm.contacts;
  v_seq      int;
  v_body     text := btrim(coalesce(p_body, ''));
  v_row      uuid;
begin
  if p_lane not in ('client', 'outreach') then return query select 'bad_lane'::text, null::uuid, null::uuid; return; end if;
  if p_kind not in ('reply', 'hard_bounce', 'unsubscribe', 'auto_reply') then return query select 'bad_kind'::text, null::uuid, null::uuid; return; end if;
  if length(v_msg) < 3 or v_from !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then return query select 'unreadable'::text, null::uuid, null::uuid; return; end if;
  if not exists (select 1 from core.organizations where id = p_organization_id) then return query select 'unknown_organization'::text, null::uuid, null::uuid; return; end if;

  -- Idempotent: the same mailbox read twice changes nothing.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || v_msg, 0));
  if exists (select 1 from crm.inbound_emails e where e.organization_id = p_organization_id and e.message_id = v_msg) then
    return query select 'duplicate'::text, null::uuid, null::uuid; return;
  end if;

  if p_kind = 'auto_reply' then
    v_outcome := 'ignored_auto_reply';

  elsif p_kind = 'hard_bounce' then
    if v_target ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      -- Marked bounced FIRST: the suppression would otherwise close the pending send as merely "refused", and the record should say why.
      update crm.email_campaign_recipients r set status = 'bounced' where r.organization_id = p_organization_id and r.email = v_target and r.status = 'pending';
      perform crm._suppress_email(p_organization_id, v_target, 'hard_bounce', 'inbound_email:' || left(v_msg, 120), left(coalesce(p_subject, ''), 200), null);
      select p.id into v_prospect from crm.outreach_prospects p where p.organization_id = p_organization_id and p.email = v_target;
      v_outcome := 'bounce_suppressed';
    else
      v_outcome := 'bounce_unreadable';
    end if;

  elsif p_lane = 'outreach' then
    select p.id into v_prospect from crm.outreach_prospects p where p.organization_id = p_organization_id and p.email = v_from;
    if v_prospect is null then
      v_outcome := 'unmatched';
    elsif p_kind = 'unsubscribe' then
      update crm.email_campaign_recipients r set status = 'unsubscribed' where r.organization_id = p_organization_id and r.prospect_id = v_prospect and r.status = 'pending';
      perform crm._suppress_email(p_organization_id, v_from, 'unsubscribed', 'inbound_email:' || left(v_msg, 120), 'asked to stop by replying', null);
      update crm.outreach_prospects p set status = 'do_not_contact' where p.id = v_prospect;
      v_outcome := 'unsubscribed';
    else
      -- A person answered: the sequence stops (nobody wants step three after replying) and a human takes it from here.
      update crm.email_campaign_recipients r set status = 'replied' where r.organization_id = p_organization_id and r.prospect_id = v_prospect and r.status = 'pending';
      update crm.outreach_prospects p set status = 'replied' where p.id = v_prospect and p.status in ('new', 'contacted');
      perform core.raise_alert(p_organization_id, 'email_outreach', 'info', 'A prospect replied to the outreach email: ' || v_from, 'outreach-reply:' || v_prospect);
      v_outcome := 'prospect_replied';
    end if;

  else
    -- client lane: the contact's own thread.
    select c.* into v_contact from crm.contacts c where c.organization_id = p_organization_id and lower(c.email) = v_from;
    if v_contact.id is not null then
      select cv.id into v_conv
        from crm.conversations cv
        join crm.leads l on l.id = cv.lead_id
       where cv.organization_id = p_organization_id and cv.kind = 'direct' and cv.status = 'active' and l.contact_id = v_contact.id
       order by cv.created_at desc limit 1;
      if v_conv is null and v_contact.client_account_id is not null then
        select cv.id into v_conv from crm.conversations cv
         where cv.organization_id = p_organization_id and cv.kind = 'client_account' and cv.client_account_id = v_contact.client_account_id and cv.status <> 'abandoned' limit 1;
      end if;
    end if;
    if v_conv is null then
      perform core.raise_alert(p_organization_id, 'email_inbound', 'warning', 'An email arrived from someone with no conversation to put it in: ' || v_from, 'inbound-unmatched:' || v_from);
      v_outcome := 'unmatched';
    elsif v_body = '' then
      v_outcome := 'empty';
    else
      perform 1 from crm.conversations cv where cv.id = v_conv for update;
      select coalesce(max(m.seq), 0) + 1 into v_seq from crm.conversation_messages m where m.conversation_id = v_conv;
      insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, external_ref, metadata, occurred_at)
      values (p_organization_id, v_conv, v_seq, 'client', left(v_body, 8000), 'email:' || left(v_msg, 300),
              jsonb_build_object('channel', 'email', 'subject', left(coalesce(p_subject, ''), 200), 'from', v_from), coalesce(p_received_at, now()))
      on conflict do nothing;
      v_outcome := 'recorded_to_thread';
    end if;
  end if;

  insert into crm.inbound_emails (organization_id, lane, message_id, from_email, subject, received_at, kind, outcome, conversation_id, prospect_id)
  values (p_organization_id, p_lane, v_msg, v_from, left(p_subject, 300), coalesce(p_received_at, now()), p_kind, v_outcome, v_conv, v_prospect)
  returning id into v_row;

  perform core.record_audit(p_organization_id, 'inbound_email.' || v_outcome, 'inbound_email', v_row, null, jsonb_build_object('lane', p_lane, 'kind', p_kind));
  return query select v_outcome, v_conv, v_prospect;
end;
$$;

revoke all on function crm.ingest_inbound_email(uuid, text, text, text, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function crm.ingest_inbound_email(uuid, text, text, text, text, text, timestamptz, text, text) to service_role;


-- ── how the mailbox sweep is paced and what it last saw (the Admin's "last checked") ──

create table if not exists crm.inbound_email_state (
  organization_id uuid not null references core.organizations(id) on delete cascade,
  lane            text not null check (lane in ('client', 'outreach')),
  last_polled_at  timestamptz,
  last_ok_at      timestamptz,
  last_error      text check (last_error is null or length(last_error) <= 400),
  last_handled    int not null default 0,
  primary key (organization_id, lane)
);
alter table crm.inbound_email_state enable row level security;
alter table crm.inbound_email_state force row level security;
drop policy if exists inbound_email_state_admin_read on crm.inbound_email_state;
create policy inbound_email_state_admin_read on crm.inbound_email_state for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()));
revoke all on crm.inbound_email_state from public, anon, authenticated;
grant select on crm.inbound_email_state to authenticated;
grant select, insert, update on crm.inbound_email_state to service_role;
drop trigger if exists freeze_org_inbound_email_state on crm.inbound_email_state;
create trigger freeze_org_inbound_email_state before update of organization_id on crm.inbound_email_state for each row execute function core.freeze_organization_id();

-- Atomically takes the right to read a mailbox now (true) or says it was read recently (false): two overlapping ticks log in once.
create or replace function crm.claim_inbound_poll(p_organization_id uuid, p_lane text, p_min_interval_seconds int)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claimed int;
begin
  insert into crm.inbound_email_state (organization_id, lane, last_polled_at) values (p_organization_id, p_lane, now())
  on conflict (organization_id, lane) do update set last_polled_at = now()
    where crm.inbound_email_state.last_polled_at is null
       or crm.inbound_email_state.last_polled_at < now() - make_interval(secs => greatest(p_min_interval_seconds, 1));
  get diagnostics v_claimed = row_count;
  return v_claimed > 0;
end;
$$;
revoke all on function crm.claim_inbound_poll(uuid, text, int) from public, anon, authenticated;
grant execute on function crm.claim_inbound_poll(uuid, text, int) to service_role;

create or replace function crm.record_inbound_poll(p_organization_id uuid, p_lane text, p_ok boolean, p_detail text, p_handled int)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update crm.inbound_email_state
     set last_ok_at = case when p_ok then now() else last_ok_at end,
         last_error = case when p_ok then null else left(p_detail, 400) end,
         last_handled = coalesce(p_handled, 0)
   where organization_id = p_organization_id and lane = p_lane;
$$;
revoke all on function crm.record_inbound_poll(uuid, text, boolean, text, int) from public, anon, authenticated;
grant execute on function crm.record_inbound_poll(uuid, text, boolean, text, int) to service_role;

notify pgrst, 'reload schema';
