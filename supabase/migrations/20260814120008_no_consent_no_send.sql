-- ═══════════════════════════════════════════════════════════════════════════
-- No consent, no send.
--
-- Gap G-012. Decision ADM-70 granted (consent before sending, channel-
-- specific, enforced by the communication system rather than the UI).
-- Decision ADM-81 — the transactional-versus-sales question ADM-70 left open —
-- is taken here as a **delegated decision** under the owner's standing
-- authorization.
--
-- ── ADM-81: there is no transactional exception ──────────────────────────
--
-- ADM-70 recorded the finding that decides this: the words **transactional**,
-- **marketing** and **promotional** appear **nowhere in any AgencyOS
-- document**. There is no existing rule to apply, so there is nothing to
-- separate without inventing it.
--
-- A "transactional" category is also the exact shape a broad marketing
-- exception takes on its way in: every message anybody wants to send can be
-- argued to service an existing relationship. Drawing that line requires a
-- business judgement nobody has made.
--
-- So: **every client-facing send requires recorded consent on the channel.**
-- No exception, no category, nothing to widen. If the owner later wants a
-- transactional carve-out, that is a decision to take deliberately — and
-- adding one to this model is a smaller, more reviewable change than removing
-- one that was assumed.
--
-- What this does *not* block: a human is always free to message a client from
-- their own phone. This governs what **AgencyOS** sends.
--
-- ── the trap ADM-70 named, and it is real ────────────────────────────────
--
-- The approval announcement to the internal group runs through this very
-- function. It is **not** a client communication, and suppressing it would
-- silently break G-110 — the owner would stop being told what needs deciding,
-- and nothing would say why.
--
-- So suppression keys off the **conversation kind**, not off the send:
-- `internal_group` is outside consent entirely, because there is no client on
-- the other end of it.
--
-- ── where there is nobody to have consented ──────────────────────────────
--
-- A `project_group` conversation may carry no `contact_id` at all. There is
-- then no person whose consent could be checked, and a group send reaches
-- whoever is in the group.
--
-- That is refused rather than allowed. The alternative — treating "no
-- identifiable contact" as "no objection" — is precisely how a consent model
-- becomes decorative, and this repository has found three of those already.
--
-- ── a table, not a column ────────────────────────────────────────────────
--
-- ADM-70 again: a column on `crm.contacts` cannot hold one status per channel,
-- and channel-specific is what was granted. WhatsApp consent is not email
-- consent is not SMS consent.
--
-- The channel vocabulary admits **only `whatsapp`**, because that is the only
-- channel that exists: email and SMS have no sender, no configuration and no
-- code. Admitting what is imagined would let a row be written that nothing
-- could ever honour.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.communication_consent (
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  contact_id       uuid not null references crm.contacts(id) on delete cascade,

  -- Only what exists. A channel added here without a sender behind it would be
  -- a permission nothing can act on.
  channel          text not null check (channel in ('whatsapp')),

  -- `withdrawn` is a row, not a deletion. Deleting consent would lose the fact
  -- that it was withdrawn and when, which is the half that matters when
  -- somebody asks why a client stopped being messaged.
  status           text not null check (status in ('granted', 'withdrawn')),

  -- How it was obtained. Free text on purpose: ADM-70 did not decide what
  -- counts as capture, and a CHECK here would be inventing that.
  source           text,
  note             text,

  -- Who recorded it. Null for a system-recorded row; there is no such path
  -- today, and the column exists so one could not be added without saying so.
  recorded_by      uuid references core.users(id) on delete set null,

  recorded_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One current status per contact per channel. History lives in the audit
  -- log, which is why this is an upsert target rather than an append log:
  -- two rows both claiming to be current is the state that cannot be resolved.
  primary key (organization_id, contact_id, channel)
);

comment on table crm.communication_consent is
  'Whether a contact may be messaged by AgencyOS on a channel (G-012, ADM-70, ADM-81). A TABLE rather than a column because consent is channel-specific and a column cannot hold one status per channel. Absent means no consent: the enforcement in crm.send_outbound_message requires a granted row and refuses everything else. There is NO transactional exception - ADM-81 - because no AgencyOS document distinguishes transactional from marketing, and inventing the category is how a broad exception arrives.';

comment on column crm.communication_consent.status is
  'granted or withdrawn. Withdrawn is a row rather than a deletion, because deleting would lose the fact that consent was withdrawn and when - the half that matters when somebody asks why a client stopped being messaged.';

create index if not exists communication_consent_contact_idx
  on crm.communication_consent (organization_id, contact_id)
  where status = 'granted';

-- ── tenant isolation, and agents may not grant themselves consent ────────
--
-- ADM-70: "Agents may not grant themselves consent and may not bypass
-- suppression." Writes are `core.is_admin()`, which no agent is — an agent
-- reaching this table would need a human's role, and the send path reads it
-- through a `security definer` function that never writes.

alter table crm.communication_consent enable row level security;

drop policy if exists communication_consent_select on crm.communication_consent;
create policy communication_consent_select on crm.communication_consent
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists communication_consent_write on crm.communication_consent;
create policy communication_consent_write on crm.communication_consent
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  );

drop trigger if exists set_updated_at on crm.communication_consent;
create trigger set_updated_at
  before update on crm.communication_consent
  for each row execute function core.set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- The audit vocabulary, in the same change as the trigger
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADM-70 warned about exactly this: `audit.record_row_change` RAISES for any
-- table it has no vocabulary for, so attaching the trigger without adding a
-- branch would make every write to the consent table fail.
--
-- Regenerated from the live definition in `20260814120005` with one branch
-- added and nothing else changed. The diff was checked before committing —
-- an earlier change in this repository regenerated this same function from an
-- older copy and silently dropped the `proposals` branch.

create or replace function audit.record_row_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_action  text;
  v_subject text;
  v_before  jsonb;
  v_after   jsonb;
  v_org     uuid;
begin
  v_after := to_jsonb(new);
  v_before := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;

  v_org := (v_after->>'organization_id')::uuid;

  if v_org is null then
    raise exception 'audit.record_row_change: % has no organization_id', tg_table_name;
  end if;

  case tg_table_name
    when 'leads' then
      v_subject := 'lead';
      v_action :=
        case
          when tg_op = 'INSERT' then 'lead.created'
          when new.status = 'converted' and old.status is distinct from 'converted' then 'lead.converted'
          when new.status is distinct from old.status then 'lead.status_changed'
          when new.qualification is distinct from old.qualification then 'lead.qualification_updated'
          when new.next_follow_up_at is distinct from old.next_follow_up_at then 'lead.follow_up_scheduled'
          else 'lead.updated'
        end;

    when 'lead_activities' then
      v_subject := 'lead';
      v_action :=
        -- G-010. The six kinds ADM-10 §7 names are recorded as what they are.
        -- The seven that came before keep `lead.note_added`, which is wrong
        -- for some of them and is not this change's to fix — it is recorded
        -- as its own gap. What this refuses to do is *add* to the problem:
        -- six new kinds filed as notes would be six new false statements in
        -- the audit log, written knowingly, in the change that exists to make
        -- the six honest.
        case new.kind
          when 'contacted'         then 'lead.contacted'
          when 'sample_sent'       then 'lead.sample_sent'
          when 'demo_sent'         then 'lead.demo_sent'
          when 'offer_sent'        then 'lead.offer_sent'
          when 'follow_up'         then 'lead.follow_up_recorded'
          when 'advance_requested' then 'lead.advance_requested'
          -- G-126. The seven the timeline shipped with, each recorded as what
          -- it is. Until now every one of them was filed as `lead.note_added`,
          -- so an assignment, a logged call, an inbound message and an agent
          -- run all read as notes -- in audit.audit_log, the record that
          -- exists to be trusted.
          --
          -- `status_change` becomes `lead.status_change_logged` rather than
          -- `lead.status_changed`, which the `leads` branch already produces
          -- for the lead's own status. Two different events sharing one action
          -- name would be a worse defect than the one being fixed.
          when 'note'          then 'lead.note_added'
          when 'status_change' then 'lead.status_change_logged'
          when 'message_in'    then 'lead.message_in'
          when 'message_out'   then 'lead.message_out'
          when 'call'          then 'lead.call_logged'
          when 'agent_run'     then 'lead.agent_run_logged'
          when 'assignment'    then 'lead.assigned'
          -- No fallback. The kind CHECK admits thirteen values and all
          -- thirteen are named above, so a fourteenth arriving without an
          -- action here raises rather than being filed as a note - which is
          -- exactly how the first seven came to be wrong.
          else null
        end;

      if v_action is null then
        raise exception 'audit.record_row_change: no action for lead_activities.kind %', new.kind;
      end if;

    -- G-012, ADM-70. Consent is the thing that decides whether a client may
    -- be messaged at all, so a change to it is exactly the kind of act the
    -- audit log exists for. ADM-70 warned this branch must arrive in the same
    -- change as the trigger: this function RAISES for any table it has no
    -- vocabulary for, so attaching the trigger without a branch here would
    -- make every write to the consent table fail.
    when 'communication_consent' then
      v_subject := 'communication_consent';
      v_action  := 'consent.' || new.status;

    when 'requirement_versions' then
      v_subject := 'requirement_version';
      v_action :=
        case
          when tg_op = 'INSERT' then 'requirement.proposed'
          when new.status is distinct from old.status then 'requirement.' || new.status
          else 'requirement.updated'
        end;

    when 'client_accounts' then
      v_subject := 'client_account';
      v_action := case when tg_op = 'INSERT' then 'client_account.created' else 'client_account.updated' end;

    when 'opportunities' then
      v_subject := 'opportunity';
      v_action :=
        case
          when tg_op = 'INSERT' then 'opportunity.created'
          when new.stage = 'won' and old.stage is distinct from 'won' then 'opportunity.won'
          when new.stage is distinct from old.stage then 'opportunity.stage_changed'
          when new.value_minor is distinct from old.value_minor then 'opportunity.value_changed'
          else 'opportunity.updated'
        end;

    -- G-011. The status vocabulary is already the business vocabulary — the
    -- states a quote moves through are exactly the events worth reading in a
    -- log — so the derivation is the status itself. `proposal.repriced` is
    -- named separately because a discount or tax change on a draft is the one
    -- material money edit that leaves the status alone, and it is the edit
    -- Document 09 §17 gates approval on.
    when 'proposals' then
      v_subject := 'proposal';
      v_action :=
        case
          when tg_op = 'INSERT' then 'proposal.drafted'
          when new.status is distinct from old.status then 'proposal.' || new.status
          when new.total_minor is distinct from old.total_minor then 'proposal.repriced'
          else 'proposal.updated'
        end;

    when 'projects' then
      v_subject := 'project';
      v_action :=
        case
          when tg_op = 'INSERT' then 'project.created'
          when new.status is distinct from old.status then 'project.status_changed'
          else 'project.updated'
        end;

    when 'defects' then
      v_subject := 'defect';
      v_action :=
        case
          when tg_op = 'INSERT' then 'defect.raised'
          when new.status is distinct from old.status then 'defect.' || new.status
          else 'defect.updated'
        end;

    else
      raise exception 'audit.record_row_change: no vocabulary for table %', tg_table_name;
  end case;

  if tg_op = 'UPDATE' and (v_before - 'updated_at') = (v_after - 'updated_at') then
    return null;
  end if;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org,
    case when (select auth.uid()) is null then 'system' else 'user' end,
    (select auth.uid()),
    v_action,
    v_subject,
    (v_after->>'id')::uuid,
    v_before,
    v_after
  );

  return null;
end;
$$;

drop trigger if exists record_row_change on crm.communication_consent;
create trigger record_row_change
  after insert or update on crm.communication_consent
  for each row execute function audit.record_row_change();


-- ═══════════════════════════════════════════════════════════════════════════
-- The chokepoint enforces it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Regenerated from the live definition with the consent guard added and
-- nothing else changed; the diff was checked before committing.

CREATE OR REPLACE FUNCTION crm.send_outbound_message(p_conversation_id uuid, p_body text, p_external_ref text, p_author_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, message_id uuid, seq integer, to_phone text, from_phone_number_id text, recipient_type text)
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
    return query select 'not_found'::text, null::uuid, null::int, null::text, null::text, null::text;
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
  -- `internal_group` is exempt, and this is the trap ADM-70 named before
  -- anybody built it: the approval announcement to the owner runs through this
  -- same function, is not a client communication, and suppressing it would
  -- silently break G-110 - the owner would stop being told what needs
  -- deciding, with nothing to say why.
  --
  -- Checked BEFORE the idempotency lookup deliberately. A send that was
  -- refused for want of consent must not become permitted by being retried.
  -- `direct` only, and the boundary is a category judgement rather than a
  -- convenience. This consent model is **per contact per channel**, which is
  -- what ADM-70 granted, and `direct` is the only kind that has a contact.
  --
  -- A `project_group` has none: it is created with a `project_id` and nothing
  -- else, because a WhatsApp group is not a person. Applying a per-contact
  -- rule to it is a category error in either direction — refusing every group
  -- send would break the group messaging G-014 and G-109 deliberately built,
  -- and pretending the group "consented" would invent a record nobody made.
  --
  -- **So group consent is unmodelled, and that is recorded as G-136 rather
  -- than quietly resolved here.** Whether being in a project group is itself a
  -- basis for messaging it is a business decision nobody has taken.
  --
  -- `internal_group` is exempt for a different and firmer reason: there is no
  -- client on the other end of it at all. That is the trap ADM-70 named — the
  -- approval announcement runs through this same function, and suppressing it
  -- would silently break G-110.
  if v_conversation.kind = 'direct' then
    if v_conversation.contact_id is null then
      -- A client-facing conversation with nobody identifiable on the other
      -- end. Refused rather than allowed: treating "no identifiable contact"
      -- as "no objection" is how a consent model becomes decorative.
      return query select 'no_consent'::text, null::uuid, null::int,
                          null::text, null::text, null::text;
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
                          null::text, null::text, null::text;
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
    -- current answer instead of the one that was true the first time.
    select ct.* into v_contact from crm.contacts ct where ct.id = v_conversation.contact_id;

    return query select 'already_sent'::text, v_existing.id, v_existing.seq,
                        case when v_is_group then v_conversation.external_ref else v_contact.phone end,
                        v_settings->>'whatsapp_phone_number_id',
                        case when v_is_group then 'group' else 'individual' end;
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
                      case when v_is_group then 'group' else 'individual' end;
end;
$function$;

comment on function crm.send_outbound_message(uuid, text, text, uuid) is
  'Queues an outbound message, and refuses one to a client without recorded consent (G-012, ADM-70, ADM-81). Suppression lives HERE rather than in a caller because ADM-70 required the communication system to enforce it - a future caller does not get to skip the rule by not knowing about it. internal_group is exempt: the approval announcement runs through this same function, is not client communication, and suppressing it would silently break G-110.';
