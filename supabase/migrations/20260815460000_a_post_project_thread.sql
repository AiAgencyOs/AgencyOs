-- ═══════════════════════════════════════════════════════════════════════════
-- A post-project follow-up has a thread to send on — G-139 / ADM-69 situation 8.
--
-- ADM-69's post-project rhythm was decided, but the situation had no conversation
-- it could legally use: `direct` needs a lead, and a completed project's client
-- account outlives its leads (the whole reason the lifecycle continues past
-- `completed`); `project_group` is G-136; `internal_group` is not a client. So
-- the worker STOPPED situation 8 with `no_conversation` — observable and
-- undeliverable (G-139's honest state).
--
-- This adds a fourth conversation kind, `client_account`: a thread keyed to a
-- client account rather than a lead, carrying the account's contact. One per
-- account (the relationship channel outlives individual projects). The worker
-- resolves-or-creates it for post-project instead of stopping.
--
-- Consent is NOT a new decision. A `client_account` thread has an identifiable
-- contact (the account's), so the EXISTING per-contact-per-channel rule applies,
-- exactly as for `direct` — this is client-facing communication and is gated by
-- the same chokepoint. That is one word in crm.send_outbound_message; the rest
-- of that function is regenerated VERBATIM from its live catalog definition
-- (dumped, one line changed) to avoid the D16 / PR #165 drift its own header
-- warns about, and the full consent/authority/outbound/announce/delivery verifier
-- suite is the proof it did not drift.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the new kind, and the column it hangs on ───────────────────────────
alter table crm.conversations
  add column if not exists client_account_id uuid references core.client_accounts(id) on delete cascade;

comment on column crm.conversations.client_account_id is
  'The client account a `client_account` conversation belongs to (G-139). Null for every other kind; not null exactly when kind = client_account (conversations_kind_shape).';

alter table crm.conversations drop constraint conversations_kind_check;
alter table crm.conversations
  add constraint conversations_kind_check
  check (kind in ('direct', 'project_group', 'internal_group', 'client_account'));

alter table crm.conversations drop constraint conversations_kind_shape;
alter table crm.conversations
  add constraint conversations_kind_shape check (
    (kind = 'direct'         and lead_id is not null and project_id is null     and client_account_id is null)
    or (kind = 'project_group'  and lead_id is null     and project_id is not null and client_account_id is null)
    or (kind = 'internal_group' and lead_id is null     and project_id is null     and client_account_id is null)
    or (kind = 'client_account' and lead_id is null     and project_id is null     and client_account_id is not null)
  );

-- One live client_account thread per account: post-project follow-ups for two
-- projects of the same client reuse the one relationship channel.
create unique index if not exists conversations_client_account_key
  on crm.conversations (organization_id, client_account_id)
  where kind = 'client_account';

-- The new org-scoped FK gets the same org-consistency guard every other one has
-- (S7): a conversation's client account must belong to the conversation's org.
-- Null (every non-client_account kind) is skipped by core.enforce_parent_org.
drop trigger if exists org_match_conversations_client_account_id on crm.conversations;
create trigger org_match_conversations_client_account_id
  before insert or update of client_account_id, organization_id on crm.conversations
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

-- ── 2. the chokepoint learns the new kind ─────────────────────────────────
-- Regenerated from the live catalog definition; the ONLY change is the consent
-- condition on line "if v_conversation.kind in (...)" — client_account joins
-- direct, because it has a contact and is client-facing. Everything else is the
-- verbatim body, including the grant re-stated below.
CREATE OR REPLACE FUNCTION crm.send_outbound_message(p_conversation_id uuid, p_body text, p_external_ref text, p_author_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, message_id uuid, seq integer, to_phone text, from_phone_number_id text, recipient_type text, delivery text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_conversation crm.conversations;
  v_existing     crm.conversation_messages;
  v_next         int;
  v_row          crm.conversation_messages;
  v_contact      crm.contacts;
  v_settings     jsonb;
  v_is_group     boolean;
begin
  select c.* into v_conversation
    from crm.conversations c
   where c.id = p_conversation_id
   for update;

  if v_conversation.id is null then
    return query select 'not_found'::text, null::uuid, null::int, null::text, null::text, null::text, null::text;
    return;
  end if;

  v_is_group := v_conversation.kind in ('project_group', 'internal_group');

  -- ── consent, at the chokepoint ─────────────────────────────────────────
  --
  -- G-012, ADM-70, ADM-81. Placed here rather than in a caller because ADM-70
  -- required the communication system to enforce it: both callers pass through
  -- this function, so a future third one does not get to skip the rule by not
  -- knowing about it. That is the G-093 argument again.
  --
  -- Checked BEFORE the idempotency lookup deliberately. A send that was
  -- refused for want of consent must not become permitted by being retried.
  -- `direct` only, and the boundary is a category judgement rather than a
  -- convenience. This consent model is per contact per channel, and `direct`
  -- is the only kind that has a contact.
  --
  -- A `project_group` has none, so group consent is UNMODELLED and recorded as
  -- G-136 / ADM-86 rather than quietly resolved here — refusing every group
  -- send would break the group messaging G-014 and G-109 built, and pretending
  -- a group "consented" would invent a record nobody made.
  --
  -- `internal_group` is exempt because there is no client on the other end at
  -- all: the approval announcement runs through this same function, and
  -- suppressing it would silently break G-110.
  --
  -- G-139: `client_account` joins `direct` here. A post-project thread carries
  -- the client account's contact, so it IS a kind that has a contact, and the
  -- same per-contact consent rule applies — it is client-facing communication.
  if v_conversation.kind in ('direct', 'client_account') then
    if v_conversation.contact_id is null then
      -- A client-facing conversation with nobody identifiable on the other
      -- end. Refused rather than allowed: treating "no identifiable contact"
      -- as "no objection" is how a consent model becomes decorative.
      return query select 'no_consent'::text, null::uuid, null::int,
                          null::text, null::text, null::text, null::text;
      return;
    end if;

    if not exists (
      select 1
        from crm.communication_consent cc
       where cc.organization_id = v_conversation.organization_id
         and cc.contact_id      = v_conversation.contact_id
         and cc.channel         = 'whatsapp'
         and cc.status          = 'granted'
    ) then
      -- Absent and withdrawn are the same answer. ADM-70: absent consent means
      -- do not send, and withdrawn stops future sends on that channel.
      return query select 'no_consent'::text, null::uuid, null::int,
                          null::text, null::text, null::text, null::text;
      return;
    end if;
  end if;

  select m.* into v_existing
    from crm.conversation_messages m
   where m.organization_id = v_conversation.organization_id
     and m.external_ref    = p_external_ref;

  select o.settings into v_settings
    from core.organizations o
   where o.id = v_conversation.organization_id;

  if v_existing.id is not null then
    -- A retry of the same send. The recipient is recomputed rather than
    -- remembered, so a caller that retries after a group was linked gets the
    -- current answer instead of the one that was true the first time. And now
    -- the delivery state travels with it, so the caller sends again only if
    -- the row is not already `sent`.
    select ct.* into v_contact from crm.contacts ct where ct.id = v_conversation.contact_id;

    return query select 'already_sent'::text, v_existing.id, v_existing.seq,
                        case when v_is_group then v_conversation.external_ref else v_contact.phone end,
                        v_settings->>'whatsapp_phone_number_id',
                        case when v_is_group then 'group' else 'individual' end,
                        coalesce(v_existing.metadata->>'delivery', 'pending');
    return;
  end if;

  -- `-1`, not `0`: a thread's first message is seq 0. Carried forward from the
  -- original verbatim, because rewriting it as `coalesce(max, 0) + 1` — which
  -- is what this said for one commit — shifts every thread's numbering by one
  -- and was caught only by verify-outbound-messages asserting the first seq.
  -- Exactly the regeneration drift D16 was.
  select coalesce(max(m.seq), -1) + 1 into v_next
    from crm.conversation_messages m
   where m.conversation_id = p_conversation_id;

  insert into crm.conversation_messages (
    organization_id, conversation_id, seq, author_type, author_id,
    body, external_ref, metadata, occurred_at
  )
  values (
    v_conversation.organization_id, p_conversation_id, v_next, 'user', p_author_id,
    p_body, p_external_ref,
    jsonb_build_object('channel', 'whatsapp', 'direction', 'outbound', 'delivery', 'pending'),
    now()
  )
  returning * into v_row;

  select ct.* into v_contact from crm.contacts ct where ct.id = v_conversation.contact_id;

  perform core.record_audit(
    v_conversation.organization_id,
    'message.outbound.queued',
    'conversation_message',
    v_row.id,
    null,
    jsonb_build_object('conversation_id', p_conversation_id, 'seq', v_next)
  );

  return query select 'created'::text, v_row.id, v_next,
                      -- The whole fix, in one expression: a group is addressed
                      -- by the provider id G-109 already stores, not by a
                      -- contact's phone that a group does not have.
                      case when v_is_group then v_conversation.external_ref else v_contact.phone end,
                      v_settings->>'whatsapp_phone_number_id',
                      case when v_is_group then 'group' else 'individual' end,
                      'pending'::text;
end;
$function$;

comment on function crm.send_outbound_message(uuid, text, text, uuid) is
  'Queues an outbound message idempotently on external_ref and refuses one to a client without recorded consent (G-012, ADM-70, ADM-81). Returns the row''s delivery state alongside already_sent so a retry sends again only when the row is not already sent. Consent is per-contact-per-channel and enforced for the kinds that have a contact: direct and client_account (G-139, addressed by the contact''s phone). internal_group is exempt (approval announcement, G-110); project_group is messaged on membership (ADM-86 = A, G-136).';

grant execute on function crm.send_outbound_message(uuid, text, text, uuid) to authenticated, service_role;

-- ── 3. resolve-or-create the client_account thread ────────────────────────
create or replace function crm.ensure_client_account_conversation(
  p_project_id uuid,
  p_contact_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_account uuid;
  v_conv    uuid;
begin
  -- Tenant and account derived from the authoritative project row, never passed.
  select pr.organization_id, pr.client_account_id
    into v_org, v_account
    from projects.projects pr
   where pr.id = p_project_id;
  if v_account is null then
    return null;   -- no client account to thread; caller blocks honestly
  end if;

  select c.id into v_conv
    from crm.conversations c
   where c.organization_id  = v_org
     and c.kind             = 'client_account'
     and c.client_account_id = v_account
   limit 1;
  if v_conv is not null then
    return v_conv;
  end if;

  begin
    insert into crm.conversations (organization_id, kind, channel, client_account_id, contact_id)
    values (v_org, 'client_account', 'whatsapp', v_account, p_contact_id)
    returning id into v_conv;
  exception when unique_violation then
    -- Lost a race to the partial unique index; the other caller made it.
    select c.id into v_conv
      from crm.conversations c
     where c.organization_id  = v_org
       and c.kind             = 'client_account'
       and c.client_account_id = v_account
     limit 1;
  end;

  return v_conv;
end;
$$;

comment on function crm.ensure_client_account_conversation(uuid, uuid) is
  'Resolves-or-creates the one client_account conversation for a project''s client account (G-139), carrying the account''s contact so the consent chokepoint can gate it. Idempotent (one thread per account); tenant and account derived from the project row. Returns null when the project has no client account.';

revoke all on function crm.ensure_client_account_conversation(uuid, uuid) from public, anon;
grant execute on function crm.ensure_client_account_conversation(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
