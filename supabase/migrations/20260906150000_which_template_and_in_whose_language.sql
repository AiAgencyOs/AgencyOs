-- ═══════════════════════════════════════════════════════════════════════════
-- Which template, and in whose language — G-217
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two things were missing from the template registry, and they are the same
-- omission twice: nothing recorded WHICH template carried a message, so
-- nothing could say which ones work, and nothing chose BETWEEN templates, so
-- an agency serving Hindi and English clients had to pick one language for
-- everybody.
--
-- ── the language half ─────────────────────────────────────────────────────
--
-- `crm.contacts.preferred_language` already exists and is already honoured
-- where the agent writes free text: `FOLLOW_UP_DRAFT` skips the draft rather
-- than guess a language, because *"guessing a language is how a Hindi-speaking
-- client gets a nudge in a language they did not choose"*.
--
-- Outside the window that care was thrown away. The registry allowed exactly
-- one live template per situation, so the Hindi speaker and the English
-- speaker got the same one. The uniqueness moves to (situation, language) and
-- the selection reads the contact.
--
-- **The fallback is deliberate and is not a language switch.** An agency that
-- has only registered English is not choosing to write to a Hindi speaker in
-- English; it has one approved message. Sending it beats sending nothing, and
-- the Admin panel says plainly which languages are covered so the gap is
-- visible rather than silent.
--
-- ── the performance half ──────────────────────────────────────────────────
--
-- Derived, never counted. Every figure here comes from a fact this system
-- already records for another reason — Meta's own delivery receipts
-- (`metadata.wire_status`, G-C10) and the client's own replies — so there is
-- no counter to drift, no backfill to get wrong, and no number that can
-- disagree with the transcript it claims to summarise.
--
-- What it deliberately does NOT do is choose. ADM-88 refused a lead score and
-- the reasoning applies here: a number that ranks is a number that decides,
-- and deciding which approved message a client receives on the strength of
-- last month's reply rate is a marketing decision nobody has made. This
-- SHOWS. An Admin reads it and withdraws what is not working.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── one live template per situation PER LANGUAGE ──────────────────────────
drop index if exists crm.whatsapp_templates_situation_key;

create unique index if not exists whatsapp_templates_situation_key
  on crm.whatsapp_templates (organization_id, situation_key, language_code)
  where active and status = 'approved';

comment on index crm.whatsapp_templates_situation_key is
  'One live template per situation PER LANGUAGE (G-217). It was per situation, which meant a Hindi-speaking client and an English-speaking one got the same approved message — the care FOLLOW_UP_DRAFT already takes with free text, thrown away the moment the window shut.';

-- ── what actually went out ────────────────────────────────────────────────
--
-- The message row said it was outreach and not what carried it, so nothing
-- could answer "which template did those four hundred people receive". The
-- template id travels with the message from now on.
create or replace function crm.mark_message_as_outreach(
  p_message_id uuid,
  p_template_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated int;
begin
  update crm.conversation_messages m
     set metadata = m.metadata
                 || jsonb_build_object('outreach', true)
                 -- EDIT (G-217): and which approved template carried it, when
                 -- one did. Absent for a free-text send inside the window that
                 -- some future caller marks; present for every template.
                 || case when p_template_id is null then '{}'::jsonb
                         else jsonb_build_object('template_id', p_template_id) end
   where m.id = p_message_id
     and m.author_type <> 'client'
     and (
       (select auth.uid()) is null
       or m.organization_id = (select core.current_organization_id())
     );

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

comment on function crm.mark_message_as_outreach(uuid, uuid) is
  'Records what a send WAS: business-initiated — sent while WhatsApp''s 24-hour window was shut (G-216) — and which approved template carried it (G-217). Written at send time because the window at that moment is not recoverable afterwards. Refuses to mark a client''s own message, and a signed-in caller may only mark one in their own organization.';

revoke all on function crm.mark_message_as_outreach(uuid, uuid) from public, anon;
grant execute on function crm.mark_message_as_outreach(uuid, uuid) to authenticated, service_role;

-- The one-argument form is gone: a send that does not say what carried it is
-- the state this gap exists to end.
drop function if exists crm.mark_message_as_outreach(uuid);

-- ── how each approved template is actually doing ──────────────────────────
--
-- A view, not a table. Every column is derived from rows written for another
-- reason, so it cannot drift from the transcript and there is nothing to
-- backfill for templates sent before this existed.
create or replace view crm.whatsapp_template_performance
with (security_invoker = true) as
  select
    t.id                as template_id,
    t.organization_id,
    t.situation_key,
    t.template_name,
    t.language_code,
    t.status,
    t.active,

    count(m.id)                                                       as sent,
    count(*) filter (where m.metadata->>'wire_status' in ('delivered', 'read')) as delivered,
    count(*) filter (where m.metadata->>'wire_status' = 'read')        as read,
    count(*) filter (where m.metadata->>'wire_status' = 'failed')      as failed,

    /**
     * A reply is a client message on the SAME thread, after this one, within
     * seven days.
     *
     * Seven rather than a longer window because a reply three weeks later is
     * an answer to something else. Same thread rather than same number
     * because attributing a reply across threads would credit a template for
     * a conversation it had no part in.
     */
    count(*) filter (
      where exists (
        select 1
          from crm.conversation_messages r
         where r.conversation_id = m.conversation_id
           and r.author_type = 'client'
           and r.occurred_at > m.occurred_at
           and r.occurred_at < m.occurred_at + interval '7 days'
      )
    ) as replied

    from crm.whatsapp_templates t
    left join crm.conversation_messages m
      on m.organization_id = t.organization_id
     and (m.metadata->>'template_id')::uuid = t.id
   group by t.id, t.organization_id, t.situation_key, t.template_name,
            t.language_code, t.status, t.active;

comment on view crm.whatsapp_template_performance is
  'How each approved template is doing, derived entirely from rows written for other reasons — Meta''s delivery receipts and the client''s own replies (G-217). Nothing here CHOOSES: ADM-88 refused a lead score because a number that ranks is a number that decides, and picking which approved message a client receives on last month''s reply rate is a marketing decision nobody has made. This shows; an Admin withdraws what is not working. security_invoker, so RLS on the underlying tables decides who sees what.';

grant select on crm.whatsapp_template_performance to authenticated, service_role;

-- ── choosing between them ─────────────────────────────────────────────────
--
-- Returns at most one row: the template this contact should receive for this
-- situation. The preference order is a rule, not a ranking — see the view's
-- comment for why nothing here reads performance.
create or replace function crm.template_for(
  p_organization_id uuid,
  p_situation_key text,
  p_conversation_id uuid
)
returns table (
  template_id uuid,
  template_name text,
  language_code text,
  parameters text[],
  matched_language boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with wanted as (
    select lower(btrim(coalesce(ct.preferred_language, ''))) as lang
      from crm.conversations c
      left join crm.contacts ct on ct.id = c.contact_id
     where c.id = p_conversation_id
       and c.organization_id = p_organization_id
  )
  select t.id, t.template_name, t.language_code, t.parameters,
         -- Whether this is the contact's own language or the fallback. The
         -- caller records it, so an Admin can see how often the gap is being
         -- papered over rather than only that it exists.
         (select lang from wanted) <> ''
           and lower(t.language_code) like ((select lang from wanted) || '%')
    from crm.whatsapp_templates t
   where t.organization_id = p_organization_id
     and t.situation_key = p_situation_key
     and t.active
     and t.status = 'approved'
   order by
     -- Their language first: `en` matches `en_US`, `hi` matches `hi`.
     case when (select lang from wanted) <> ''
            and lower(t.language_code) like ((select lang from wanted) || '%')
          then 0 else 1 end,
     -- Then English, which is this deployment's shared fallback rather than a
     -- preference: ADM-11's rhythms and the agency's own writing are English,
     -- and a fallback that varied by whichever row was oldest would be the
     -- random language switch the brief forbids.
     case when lower(t.language_code) like 'en%' then 0 else 1 end,
     -- Then oldest, so the answer is stable rather than whatever the planner
     -- returned first.
     t.created_at
   limit 1
$$;

comment on function crm.template_for(uuid, text, uuid) is
  'The approved template this contact should receive for this situation (G-217): their own language first, English second as this deployment''s shared fallback, oldest last so the answer is stable. `matched_language` says which of those happened, so an Admin can see how often a missing translation is being papered over. Nothing here reads performance — see crm.whatsapp_template_performance for why.';

-- ── registering, now that a situation can have more than one ──────────────
--
-- Both functions found "the live row for this situation" and there is more
-- than one of those now. Keyed by language as well, or registering Hindi
-- would silently overwrite English.
create or replace function crm.set_whatsapp_template(
  p_organization_id uuid,
  p_situation_key text,
  p_template_name text,
  p_language_code text,
  p_parameters text[] default '{}'::text[]
)
returns table (outcome text, template_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_id    uuid;
begin
  if v_actor is not null and not (select core.is_admin()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if coalesce(btrim(p_template_name), '') = '' or coalesce(btrim(p_language_code), '') = '' then
    return query select 'incomplete'::text, null::uuid; return;
  end if;

  select t.id into v_id
    from crm.whatsapp_templates t
   where t.organization_id = p_organization_id
     and t.situation_key = p_situation_key
     -- EDIT (G-217): and the LANGUAGE. Without it, registering the Hindi
     -- template for a situation overwrote the English one, which is the
     -- opposite of what the person doing it intended.
     and lower(t.language_code) = lower(btrim(p_language_code))
     and t.active;

  if v_id is null then
    insert into crm.whatsapp_templates (
      organization_id, situation_key, template_name, language_code, parameters, created_by
    )
    values (p_organization_id, p_situation_key, btrim(p_template_name), btrim(p_language_code),
            coalesce(p_parameters, '{}'::text[]), v_actor)
    returning crm.whatsapp_templates.id into v_id;
  else
    update crm.whatsapp_templates t
       set template_name = btrim(p_template_name),
           parameters = coalesce(p_parameters, '{}'::text[]),
           -- Re-registering is how an Admin says Meta approved it again after
           -- a rejection, so it comes back approved rather than staying dead.
           status = 'approved'
     where t.id = v_id;
  end if;

  perform core.record_audit(
    p_organization_id, 'whatsapp_template.set', 'whatsapp_template', v_id,
    jsonb_build_object(
      'situation_key', p_situation_key,
      'template_name', btrim(p_template_name),
      'language_code', btrim(p_language_code)
    ), null, null
  );

  return query select 'set'::text, v_id;
end;
$$;

comment on function crm.set_whatsapp_template(uuid, text, text, text, text[]) is
  'Registers which approved template answers a situation IN A LANGUAGE (G-213, keyed by language in G-217). Admin-only and audited. Records a name, a language and parameter NAMES — never copy, which is approved at Meta and lives there. Re-registering an existing pair returns it to approved, which is how an Admin says Meta approved it again.';

create or replace function crm.clear_whatsapp_template(
  p_organization_id uuid,
  p_situation_key text,
  p_language_code text default null
)
returns table (outcome text)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if (select auth.uid()) is not null and not (select core.is_admin()) then
    return query select 'forbidden'::text; return;
  end if;

  select t.id into v_id from crm.whatsapp_templates t
   where t.organization_id = p_organization_id
     and t.situation_key = p_situation_key
     -- EDIT (G-217): a null language withdraws the only one, which is what an
     -- Admin who has registered one language means. With two registered it
     -- withdraws nothing rather than guessing which — an unasked question is
     -- better than a wrong answer about what a client will receive.
     and (p_language_code is null or lower(t.language_code) = lower(btrim(p_language_code)))
     and t.active;

  if v_id is null then
    return query select 'no_template'::text; return;
  end if;

  -- Deactivated, never deleted: which template a past send used is part of
  -- the record of what this agency said.
  update crm.whatsapp_templates set active = false where id = v_id;

  perform core.record_audit(
    p_organization_id, 'whatsapp_template.withdrawn', 'whatsapp_template', v_id,
    jsonb_build_object('situation', p_situation_key, 'language', p_language_code), null, null
  );

  return query select 'cleared'::text;
end;
$$;

comment on function crm.clear_whatsapp_template(uuid, text, text) is
  'Withdraws a registered template — deactivated, never deleted, because which template a past send used is part of the record of what this agency said (G-213). Takes a language since G-217: null withdraws the only one, and with two registered it withdraws nothing rather than guessing which.';

drop function if exists crm.clear_whatsapp_template(uuid, text);
