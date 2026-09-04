-- ═══════════════════════════════════════════════════════════════════════════
-- The import brings the conversation with it — G-218
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `crm.commit_import_record` is documented as *"idempotent, phone-keyed only,
-- no consent, no send"*, and the no-consent part was right when it was
-- written: a name and a number in a spreadsheet is not permission to message
-- anybody.
--
-- But the import does not read a spreadsheet. It reads a WhatsApp export —
-- **a transcript of these people writing to this agency** — and then throws
-- the transcript away, keeping a count. So every imported lead arrives with
-- no consent record and no message history, which means:
--
--   · ADM-70's chokepoint refuses to send to them, correctly, forever; and
--   · `crm.window_state` answers `never`, correctly, forever.
--
-- Twelve hundred leads, unreachable by design, and the design was reading the
-- wrong document.
--
-- ── the decision this rests on ────────────────────────────────────────────
--
-- ADM-92: *being written to is consent* — recorded with the message as
-- evidence and source `inbound_message`, so an operator can see the system
-- inferred it rather than a person entering it. The trigger that does this
-- already exists and already fires on any inbound message.
--
-- This migration does not decide anything new. It stops discarding the
-- evidence ADM-92 asks to be kept. **The Admin was asked and said yes**, and
-- the answer is recorded here because a future reader will want to know that
-- somebody was asked.
--
-- ── what it deliberately refuses ──────────────────────────────────────────
--
-- **Group exports.** A group transcript cannot be attributed to a two-party
-- conversation: "not theirs" is not "ours" when there are five people in the
-- room, and inventing a sender is exactly the fabrication ADM-76 forbids.
--
-- **Messages with no resolvable timestamp.** The parser refuses to assign one
-- when the export's DD/MM vs MM/DD order is genuinely ambiguous, and a guessed
-- date here is worse than a missing message: it would place a message on a
-- timeline the 24-hour window is computed from. Skipped, and counted, so the
-- operator sees how many.
--
-- **An organization with no timezone.** A WhatsApp export states no timezone
-- (the format simply has none), so the wall-clock times mean nothing until
-- somebody says where they were written. G-137 already makes an organization
-- choose one before follow-ups run; this needs the same fact for the same
-- reason.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.import_messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  record_id        uuid not null references crm.import_records(id) on delete cascade,

  -- Position in the export, so the committed transcript reads in the order it
  -- was written rather than whatever the planner returned.
  ordinal          int not null check (ordinal >= 0),

  /**
   * Whose message this is.
   *
   * `inbound` means the person this record is about wrote it — the fact
   * ADM-92 turns into consent — and it is decided by the author string
   * matching this record's participant, which is how the parser groups them.
   * Everything else in a 1:1 export is the agency, and a group export does
   * not reach this table at all.
   */
  direction        text not null check (direction in ('inbound', 'outbound')),

  /** Naive wall-clock from the export. Placed in a real timezone at commit. */
  occurred_at_local timestamp not null,

  body             text not null check (length(btrim(body)) > 0),

  -- 'media' and 'system' are kept because a transcript that silently omitted
  -- them would misrepresent the conversation an agent later reads.
  kind             text not null default 'text' check (kind in ('text', 'media', 'system')),

  created_at       timestamptz not null default now(),

  -- One row per position per record: staging the same export twice is refused
  -- at the door rather than doubling somebody's history.
  constraint import_messages_ordinal_once unique (record_id, ordinal)
);

create index if not exists import_messages_record_idx
  on crm.import_messages (record_id, ordinal);

alter table crm.import_messages enable row level security;

drop policy if exists import_messages_select on crm.import_messages;
create policy import_messages_select on crm.import_messages
  for select using (
    core.is_internal() and organization_id = core.current_organization_id()
  );

drop policy if exists import_messages_write on crm.import_messages;
create policy import_messages_write on crm.import_messages
  for all using (
    core.is_admin() and organization_id = core.current_organization_id()
  ) with check (
    core.is_admin() and organization_id = core.current_organization_id()
  );

drop trigger if exists org_match_import_messages on crm.import_messages;
create trigger org_match_import_messages
  before insert or update of record_id, organization_id on crm.import_messages
  for each row execute function core.enforce_parent_org('record_id', 'crm.import_records');

drop trigger if exists freeze_org_import_messages on crm.import_messages;
create trigger freeze_org_import_messages
  before update on crm.import_messages
  for each row execute function core.freeze_organization_id();

grant select on crm.import_messages to authenticated, service_role;
grant insert, update, delete on crm.import_messages to authenticated, service_role;

comment on table crm.import_messages is
  'The transcript an import staged, one row per message, before anybody commits it (G-218). Staged rather than committed because an operator reviews a batch first, and because the messages are the evidence ADM-92 turns into consent — evidence that used to be parsed, counted and thrown away.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Committing one, now with the conversation it came from
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The return gains a count, so the signature is replaced rather than altered.
drop function if exists crm.commit_import_record(uuid);

create or replace function crm.commit_import_record(p_record_id uuid)
returns table (outcome text, contact_id uuid, lead_id uuid, messages_imported int, messages_skipped int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor    uuid := (select auth.uid());
  v_rec      crm.import_records%rowtype;
  v_org      uuid;
  v_contact  uuid;
  v_lead     uuid;
  v_name     text;
  v_tz       text;
  v_convo    uuid;
  v_existing int;
  v_seq      int;
  v_written  int := 0;
  v_staged   int := 0;
begin
  select * into v_rec from crm.import_records where id = p_record_id for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, 0, 0; return;
  end if;
  v_org := v_rec.organization_id;

  -- Authority: owner/ops_admin of the record's own org. Tenant is DERIVED from
  -- the row, never trusted from the caller. The service role (jobs) is exempt.
  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text, null::uuid, null::uuid, 0, 0; return;
    end if;
    if v_org is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text, null::uuid, null::uuid, 0, 0; return;
    end if;
  end if;

  -- Idempotent: a committed record returns its existing ids and writes nothing.
  if v_rec.committed_at is not null then
    return query select 'already_committed'::text, v_rec.committed_contact_id, v_rec.committed_lead_id, 0, 0; return;
  end if;

  -- Only a clean phone decision may be committed. Everything else is manual
  -- review and is refused here — the database will not create from a name.
  if v_rec.classification not in ('exact', 'new') or not v_rec.auto_importable or v_rec.phone is null then
    return query select 'not_importable'::text, null::uuid, null::uuid, 0, 0; return;
  end if;

  select count(*) into v_staged from crm.import_messages im where im.record_id = p_record_id;

  /**
   * A transcript with no timezone is a transcript with no timeline — G-137.
   *
   * A WhatsApp export states no timezone; the format simply has none. Until
   * somebody says where these were written, the wall-clock times cannot be
   * placed, and the 24-hour window is computed from exactly those times. So a
   * record carrying a transcript refuses rather than guessing UTC.
   *
   * A record with NO transcript commits as it always did: the lead and the
   * contact do not need a timeline.
   */
  if v_staged > 0 then
    select o.timezone into v_tz from core.organizations o where o.id = v_org;
    if v_tz is null or btrim(v_tz) = '' then
      return query select 'no_timezone'::text, null::uuid, null::uuid, 0, v_staged; return;
    end if;
  end if;

  -- Contact: insert-or-find on (org, phone) — the inbound-ingest idiom. A
  -- returning number is never duplicated and a corrected name is never
  -- overwritten.
  v_name := coalesce(nullif(btrim(v_rec.display_name), ''), v_rec.phone);
  insert into crm.contacts (organization_id, full_name, phone)
  values (v_org, v_name, v_rec.phone)
  on conflict (organization_id, phone) where phone is not null
  do nothing
  returning id into v_contact;
  if v_contact is null then
    select c.id into v_contact from crm.contacts c where c.organization_id = v_org and c.phone = v_rec.phone;
  end if;

  -- Lead: the contact's existing OPEN lead if it has one (one person, one lead),
  -- else a new source='import' lead keyed for idempotent re-runs.
  select l.id into v_lead
    from crm.leads l
   where l.organization_id = v_org
     and l.contact_id = v_contact
     and l.deleted_at is null
     and l.status in ('new', 'qualifying', 'qualified')
   order by l.created_at asc
   limit 1;

  if v_lead is null then
    insert into crm.leads (organization_id, contact_id, title, summary, source, source_ref, status)
    values (v_org, v_contact,
            'Imported lead — ' || v_name,
            -- EDIT (G-218): the summary said "No consent implied", and with the
            -- transcript imported that is no longer what happens. ADM-92 infers
            -- consent from THEIR OWN MESSAGES, recorded as evidence, and saying
            -- otherwise here would leave a sentence that contradicts the row
            -- next to it.
            'Imported from a WhatsApp export (' || v_rec.source_label || ').',
            'import', v_rec.phone, 'new')
    on conflict (organization_id, source, source_ref) where source_ref is not null
    do nothing
    returning id into v_lead;
    if v_lead is null then
      select l.id into v_lead from crm.leads l
       where l.organization_id = v_org and l.source = 'import' and l.source_ref = v_rec.phone;
    end if;
  end if;

  -- ── the conversation the export was of ──────────────────────────────────
  if v_staged > 0 then
    select c.id into v_convo
      from crm.conversations c
     where c.organization_id = v_org
       and c.channel = 'whatsapp'
       and c.external_ref = 'wa:' || v_rec.phone;

    if v_convo is null then
      insert into crm.conversations (
        organization_id, lead_id, contact_id, kind, channel, external_ref, status
      )
      values (v_org, v_lead, v_contact, 'direct', 'whatsapp', 'wa:' || v_rec.phone, 'active')
      returning id into v_convo;
    end if;

    /**
     * A live thread wins.
     *
     * If this number has already written to the deployment, the real
     * transcript is here and the export is a stale copy of part of it.
     * Interleaving an old export into a live conversation would produce a
     * history that never happened, in an order nobody wrote.
     */
    select count(*) into v_existing from crm.conversation_messages m where m.conversation_id = v_convo;

    if v_existing = 0 then
      select coalesce(max(m.seq), -1) + 1 into v_seq
        from crm.conversation_messages m where m.conversation_id = v_convo;

      insert into crm.conversation_messages (
        organization_id, conversation_id, seq, author_type, body, external_ref, occurred_at, metadata
      )
      select
        v_org,
        v_convo,
        v_seq + (row_number() over (order by im.ordinal) - 1)::int,
        -- THEIR messages are 'client', which is the fact ADM-92 reads. Ours are
        -- 'agent': an imported outbound message had no human at a keyboard in
        -- this system, and calling it 'user' would name an author who never
        -- authored it here.
        case when im.direction = 'inbound' then 'client' else 'agent' end,
        im.body,
        -- Provenance and idempotency in one key: re-running cannot double a
        -- history, and a reader can see which export a line came from.
        'import:' || p_record_id::text || ':' || im.ordinal::text,
        -- Placed in the organization's own timezone. Months old by
        -- construction, so the 24-hour window reads SHUT — which is the true
        -- answer and the reason templates exist.
        im.occurred_at_local at time zone v_tz,
        jsonb_build_object('imported', true, 'import_record_id', p_record_id, 'kind', im.kind)
      from crm.import_messages im
      where im.record_id = p_record_id
      order by im.ordinal;

      get diagnostics v_written = row_count;
    end if;
  end if;

  -- Record the commit on the staging row (DEFINER write, not subject to RLS).
  update crm.import_records
     set committed_at = now(), committed_contact_id = v_contact, committed_lead_id = v_lead
   where id = p_record_id;

  perform core.record_audit(
    v_org, 'lead.imported', 'lead', v_lead, null,
    jsonb_build_object('contact_id', v_contact, 'phone', v_rec.phone,
                       'source_label', v_rec.source_label, 'import_record_id', p_record_id,
                       'messages_imported', v_written,
                       'messages_staged', v_staged));

  return query select 'committed'::text, v_contact, v_lead, v_written, v_staged - v_written;
end;
$$;

comment on function crm.commit_import_record(uuid) is
  'Commits ONE staged import record to a contact, a lead and — since G-218 — the conversation it came from, idempotently. SECURITY DEFINER; owner/ops_admin, tenant derived from the row, service role exempt. Only classification exact/new with a phone commit. THE TRANSCRIPT IS THE POINT: ADM-92 infers consent from a person''s own inbound messages with the message as evidence, and discarding them was why twelve hundred imported leads were unreachable by design. Refuses without an organization timezone (an export states none, and the 24-hour window is computed from these times); skips the transcript entirely when the thread already has live messages, because interleaving a stale export into a live conversation writes a history that never happened. Still writes NO job and sends NOTHING.';

revoke all on function crm.commit_import_record(uuid) from public, anon;
grant execute on function crm.commit_import_record(uuid) to authenticated, service_role;
