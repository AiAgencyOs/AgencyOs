-- ═══════════════════════════════════════════════════════════════════════════
-- The language they actually wrote in.
--
-- Document 08 §8 asks for eight things and the system does none of them:
-- detect the language of each incoming message, maintain a client preferred
-- language, let a person override it, **support mixed-language messages such
-- as Hinglish**, keep the original message unchanged as evidence, and use the
-- preference in Sales, Support and Customer Success prompts.
--
-- Nothing anywhere records what language a client writes in. For an agency
-- whose leads arrive on WhatsApp in Hindi, English and a mixture of the two,
-- that is a fact every staff member reconstructs by scrolling.
--
-- ── one reading, two facts ───────────────────────────────────────────────
--
-- The sales agent already reads every inbound client message to label its Doc
-- 08 §12 intent. §12's own flow diagram puts them in order — *PARSE CONTENT →
-- LANGUAGE → INTENT* — so the language is asked for in the **same call**. A
-- second model call per message to answer a question the first one was already
-- looking at would be paying twice for one reading.
--
-- ── Hinglish, without an enumeration nobody approved ─────────────────────
--
-- `language` is a short tag: a primary alone (`hi`, `en`), or
-- `primary-secondary` for a message that genuinely mixes two (`hi-en`). That
-- is §8's *"Support mixed-language messages such as Hinglish"* expressed
-- exactly — Hinglish is `hi-en`, and it says which two rather than collapsing
-- to a `mixed` flag that loses them.
--
-- No list of permitted languages, because which languages this agency works in
-- is business configuration nobody has given. The CHECK constrains the SHAPE
-- and not the membership.
--
-- ── and no confidence number ─────────────────────────────────────────────
--
-- §8 says *"Store detected language/confidence where useful."* Nothing here
-- would consume a confidence: no branch reads it, no threshold exists, and
-- G-130 and G-133 are both the record of what a column with no consumer does —
-- it reads as checked. If something ever needs to act on uncertainty, the
-- number arrives with the thing that acts on it.
--
-- ── the detection is frozen; the PREFERENCE is not ───────────────────────
--
-- §8 asks for both *"Detect the language of each incoming message"* and
-- *"Allow Admin/client to override detected language."* Those are two
-- different facts and this is why they are two columns. What language a
-- message was written in is a reading of that message and cannot be revised —
-- the same rule `freeze_message_intent` holds one column over. What language
-- to WRITE BACK in is a preference, and a person overriding it is §8 working
-- rather than §8 being broken.

alter table crm.conversation_messages
  add column if not exists language text
    check (language is null or language ~ '^[a-z]{2,3}(-[a-z]{2,3})?$');

comment on column crm.conversation_messages.language is
  'Document 08 section 8. The language this message was written in: a primary tag alone, or primary-secondary for a message that genuinely mixes two - Hinglish is "hi-en", which says which two rather than collapsing to a flag. Frozen once written, like intent: it is a reading of the message, not an opinion about it. No confidence column - nothing would consume one, and G-130 records what a column with no consumer does.';

alter table crm.contacts
  add column if not exists preferred_language text
    check (preferred_language is null or preferred_language ~ '^[a-z]{2,3}(-[a-z]{2,3})?$'),
  add column if not exists preferred_language_set_by uuid references core.users(id);

comment on column crm.contacts.preferred_language is
  'Document 08 section 8: "Maintain client preferred language" and "Allow Admin/client to override detected language." Maintained from what the contact actually writes in, and overridable by a person - preferred_language_set_by is non-null exactly when a person set it, and a person''s choice is never overwritten by a later detection.';

-- ── a reading is not revised ─────────────────────────────────────────────

create or replace function crm.freeze_message_language()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.language is not null and new.language is distinct from old.language then
    raise exception
      'the language of a message is what it was written in, not what somebody thinks now'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_message_language on crm.conversation_messages;
create trigger freeze_message_language
  before update of language on crm.conversation_messages
  for each row execute function crm.freeze_message_language();

-- ── the preference follows what they write, until a person says otherwise ─

create or replace function crm.maintain_preferred_language()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact uuid;
begin
  if new.language is null or old.language is not null then
    return new;
  end if;

  select c.contact_id into v_contact
    from crm.conversations c
   where c.id = new.conversation_id;

  if v_contact is null then
    return new;
  end if;

  -- A person's override wins for ever. §8 says the Admin or the client may
  -- override the detected language, and an override a later message silently
  -- undoes is not an override.
  update crm.contacts
     set preferred_language = new.language,
         updated_at         = now()
   where id = v_contact
     and preferred_language_set_by is null;

  return new;
end;
$$;

comment on function crm.maintain_preferred_language() is
  'Document 08 section 8: "Maintain client preferred language." Follows what the contact actually writes in - and stops the moment a person sets it, because an override a later message silently undoes is not an override.';

drop trigger if exists maintain_preferred_language on crm.conversation_messages;
create trigger maintain_preferred_language
  after update of language on crm.conversation_messages
  for each row execute function crm.maintain_preferred_language();

notify pgrst, 'reload schema';
