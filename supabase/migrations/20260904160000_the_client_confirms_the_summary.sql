-- ═══════════════════════════════════════════════════════════════════════════
-- The client confirms the summary — G-200 (Doc 09 §12, audit RD-05)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Doc 09 §12's flow has a CLIENT CONFIRMATION step between extracting the
-- requirements and quoting them. In this system that step was an internal
-- button: `decideRequirementVersion` requires a signed-in session, so the
-- version a client's whole quotation is built on was agreed *on their behalf*,
-- and **nothing ever sent them the summary to look at**.
--
-- The agency read the thread, wrote down what it heard, approved its own
-- reading, and priced it. Every step honest, and the client never saw the
-- sentence they were about to be quoted against.
--
-- ── what this adds, and the line it does not cross ────────────────────────
--
-- It sends. A person puts the summary in front of the client, through the
-- same consent chokepoint every other outbound message goes through, and the
-- version records that it happened and which message it was.
--
-- **It does not read the reply.** Doc 08 §14 is explicit — *"Do not infer
-- acceptance from a generic 'looks good'"* — and business rules §5 makes
-- *"treat a client's word as a fact"* one of the five things no agent may do
-- at any level. `messageIntentSchema`'s own comment says the same about the
-- `acceptance` label: *"there is no path from this label to any of them to
-- guard."* Building one here would be building the path.
--
-- So the client's answer stays where it is — in the thread, in their own
-- words — and what changes is that the person accepting the version can see
-- whether the client was ever shown it. Doc 09 §12 becomes a step that
-- happened rather than a step nobody could take.
--
-- ── advisory, not blocking, and that is a choice ──────────────────────────
--
-- Acceptance does NOT require a send. A scope agreed on a phone call is
-- agreed, and refusing to record it would push the truth out of the system to
-- protect a checkbox. ADM-07 puts the decision with a person; this makes sure
-- they are deciding with the fact in front of them, which is the same posture
-- G-168 took about price.

alter table crm.requirement_versions
  add column if not exists sent_for_confirmation_at timestamptz,
  add column if not exists confirmation_message_id uuid
    references crm.conversation_messages(id) on delete set null;

comment on column crm.requirement_versions.sent_for_confirmation_at is
  'When this summary was put in front of the CLIENT for confirmation (Doc 09 section 12). Null on every version nobody has shown them - which was every version before G-200.';

comment on column crm.requirement_versions.confirmation_message_id is
  'The outbound message carrying the summary. Provenance: a claim that the client was shown something must point at what they were shown.';

-- ── the two rules the columns need ────────────────────────────────────────
--
-- 1. A send must point at the message it sent. The same discipline
--    `ai.memory_records` applies to a claim about where a fact came from: a
--    row saying the client was shown something, with nothing to open, is an
--    assertion.
--
-- 2. Once sent, it stays sent. This is a record of an act, like the approver's
--    name on a quotation (G-194) - frozen by having happened rather than by a
--    status.

create or replace function crm.confirmation_send_is_a_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sent_for_confirmation_at is not null and new.confirmation_message_id is null then
    raise exception 'a summary sent for confirmation must name the message it was sent in'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and old.sent_for_confirmation_at is not null then
    if new.sent_for_confirmation_at is distinct from old.sent_for_confirmation_at
       or new.confirmation_message_id is distinct from old.confirmation_message_id then
      raise exception 'when a client was shown this summary is a record of what happened, and does not change'
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists confirmation_send_is_a_record on crm.requirement_versions;
create trigger confirmation_send_is_a_record
  before insert or update on crm.requirement_versions
  for each row execute function crm.confirmation_send_is_a_record();

drop trigger if exists org_match_requirement_versions_confirmation on crm.requirement_versions;
create trigger org_match_requirement_versions_confirmation
  before insert or update of confirmation_message_id, organization_id on crm.requirement_versions
  for each row execute function core.enforce_parent_org('confirmation_message_id', 'crm.conversation_messages');

-- ── and the send itself ───────────────────────────────────────────────────
--
-- Through `crm.send_outbound_message`, never around it: consent (ADM-70), the
-- sequence two writers cannot corrupt, and the idempotency key are all its.
-- The key is derived from the VERSION, so pressing the button twice sends one
-- message — the same shape every other send in this system uses.
--
-- The body is composed here rather than by a model. It is a restatement of a
-- payload the agency already holds, and a model asked to restate it could
-- restate it differently, which is how a client confirms a scope nobody
-- wrote down.

create or replace function crm.send_requirement_for_confirmation(
  p_version_id uuid,
  p_body text
)
returns table (outcome text, message_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row     crm.requirement_versions;
  v_sent    record;
begin
  select v.* into v_row
    from crm.requirement_versions v
   where v.id = p_version_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  -- Only a version still awaiting a decision. A summary the agency has
  -- already accepted or rejected is not a question to ask a client.
  if v_row.status <> 'proposed' then
    return query select 'not_proposed'::text, null::uuid;
    return;
  end if;

  /**
   * An early exit, and NOT the control — a red-proof settled which is which.
   *
   * Removing this branch and pressing send twice still sends once: the
   * refusal belongs to `send_outbound_message`'s idempotency key, which is
   * derived from the version below and is the same key on every attempt.
   * What this saves is a pointless trip through the send path, and it returns
   * the message the client actually has rather than whatever the second
   * attempt reports.
   *
   * Recorded rather than deleted, because a reader would otherwise assume the
   * guard here is what makes double-sending impossible, and remove the key.
   */
  if v_row.sent_for_confirmation_at is not null then
    return query select 'already_sent'::text, v_row.confirmation_message_id;
    return;
  end if;

  select * into v_sent
    from crm.send_outbound_message(
      v_row.conversation_id,
      p_body,
      'requirement:' || p_version_id::text
    );

  -- Consent, a missing thread, a refused body: the chokepoint's answer is
  -- carried out as-is rather than translated, because the caller has to be
  -- able to tell "they have opted out" from "it failed".
  if v_sent.outcome is distinct from 'created' or v_sent.message_id is null then
    return query select coalesce(v_sent.outcome, 'not_sent')::text, v_sent.message_id;
    return;
  end if;

  update crm.requirement_versions
     set sent_for_confirmation_at = now(),
         confirmation_message_id = v_sent.message_id
   where crm.requirement_versions.id = p_version_id;

  perform core.record_audit(
    v_row.organization_id, 'requirement.sent_for_confirmation', 'requirement_version', p_version_id,
    null,
    jsonb_build_object('messageId', v_sent.message_id, 'version', v_row.version),
    null
  );

  return query select 'sent'::text, v_sent.message_id;
end;
$$;

comment on function crm.send_requirement_for_confirmation(uuid, text) is
  'Doc 09 section 12''s client confirmation step, as a send that actually happens: puts the summary in front of the client through the consent chokepoint and records which message it was. It does NOT read the reply - Doc 08 section 14 refuses to let acceptance be inferred, and building a path from a client''s words to a status would be building the thing that refusal exists to prevent.';

revoke all on function crm.send_requirement_for_confirmation(uuid, text) from public;
grant execute on function crm.send_requirement_for_confirmation(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
