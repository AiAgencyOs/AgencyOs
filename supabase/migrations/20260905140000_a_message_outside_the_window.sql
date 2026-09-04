-- ═══════════════════════════════════════════════════════════════════════════
-- A message outside the window — G-213
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WhatsApp carries a free-form message to somebody only within **24 hours of
-- their last message to you**. Outside that, Meta accepts an approved
-- TEMPLATE and nothing else.
--
-- This system has never known that. `sendWhatsAppText` sends `type: 'text'`
-- and has no other shape, and the follow-up handler already names the
-- consequence in a comment: *"a plain-text follow-up past WhatsApp's 24-hour
-- window → 400"*.
--
-- ── the size of it, measured against this agency's own rhythms ────────────
--
-- ADM-11's follow-up days are 2, 5, 8, 11, 14, 17, 20 for Sales-Active and 7,
-- 14, 21, 28, 35, 42, 49 for Sales-Nurture. **Every one of them is past 24
-- hours.** So no automated follow-up this system sends can be delivered
-- today; each is handed to Meta and refused.
--
-- And the twelve hundred historical leads the reactivation work exists for
-- last wrote months ago. Every one of them is outside the window. The whole
-- campaign is undeliverable without templates.
--
-- ── and a quieter failure that matters more ───────────────────────────────
--
-- `deliverFollowUp` deliberately does not stop a sequence on a permanent send
-- failure, for reasons its own comment argues well. But the escalation is
-- decided at claim time, so a follow-up that could NEVER have been delivered
-- still advances the count and eventually escalates as *"the client ignored
-- us"*. The client ignored nothing; the message never reached them. This
-- migration is what lets that be told apart.
--
-- ── what is recorded here, and what is deliberately not ───────────────────
--
-- A template is a Meta artifact: a NAME, a LANGUAGE and positional
-- parameters, approved by Meta before it can ever be sent. The body text
-- lives at Meta, not here.
--
-- So this table records only which approved template answers which situation.
-- It invents no template, no name and no copy — the same shape ADM-12 gave
-- the portfolio: *a list the Admin maintains*, empty until they fill it, and
-- nothing is sent from it until then.

create table if not exists crm.whatsapp_templates (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,

  -- Which follow-up situation this template answers. The vocabulary is
  -- ADM-11's own, and `internal_approval` is here too because the owner's
  -- announcement number falls outside the window exactly as a client does.
  situation_key     text not null check (situation_key in (
    'no_response_after_quotation',
    'no_response_after_requirements',
    'no_response_after_proposal',
    'abandoned_conversation',
    'pending_approval',
    'inactive_lead',
    'post_project',
    'internal_approval'
  )),

  -- Exactly as approved at Meta. Not a description of one.
  template_name     text not null check (length(btrim(template_name)) between 1 and 512),

  -- Meta's own language tag for the approved template, e.g. en, en_US, hi.
  language_code     text not null check (length(btrim(language_code)) between 2 and 10),

  /**
   * Which facts fill the template's positional parameters, in order.
   *
   * Names of things this system already holds — never literal copy. A
   * template body is approved at Meta with {{1}}, {{2}} placeholders; this
   * says what goes in them. An empty array is a template with no parameters,
   * which is the commonest and safest kind.
   */
  parameters        text[] not null default '{}'::text[]
                      check (array_length(parameters, 1) is null or array_length(parameters, 1) <= 10),

  active            boolean not null default true,
  created_by        uuid references core.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table crm.whatsapp_templates is
  'Which Meta-approved template answers which follow-up situation (G-213). Records a NAME, a LANGUAGE and which facts fill the parameters - never the copy, which is approved at Meta and lives there. Empty until the Admin fills it, and outside the 24-hour window a situation with no template registered SENDS NOTHING rather than being handed to Meta to be refused.';

comment on column crm.whatsapp_templates.parameters is
  'Names of facts this system already holds, in the order the approved template''s {{1}}, {{2}} placeholders expect them. Never literal text: a parameter this system invented would be copy nobody approved.';

-- One live template per situation per organization. Two would make the sender
-- choose, and choosing between approved templates is a marketing decision.
create unique index if not exists whatsapp_templates_situation_key
  on crm.whatsapp_templates (organization_id, situation_key)
  where active;

alter table crm.whatsapp_templates enable row level security;

drop policy if exists whatsapp_templates_select on crm.whatsapp_templates;
create policy whatsapp_templates_select on crm.whatsapp_templates
  for select using (
    core.is_internal() and organization_id = core.current_organization_id()
  );

drop policy if exists whatsapp_templates_write on crm.whatsapp_templates;
create policy whatsapp_templates_write on crm.whatsapp_templates
  for all using (
    core.is_admin() and organization_id = core.current_organization_id()
  ) with check (
    core.is_admin() and organization_id = core.current_organization_id()
  );

drop trigger if exists freeze_org_whatsapp_templates on crm.whatsapp_templates;
create trigger freeze_org_whatsapp_templates
  before update on crm.whatsapp_templates
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at on crm.whatsapp_templates;
create trigger set_updated_at
  before update on crm.whatsapp_templates
  for each row execute function core.set_updated_at();

grant select on crm.whatsapp_templates to authenticated, service_role;
grant insert, update, delete on crm.whatsapp_templates to authenticated, service_role;

-- ── is the window open? ───────────────────────────────────────────────────

/**
 * When the contact last wrote to us on this conversation.
 *
 * A fact from our own transcript, not a guess and not a call to Meta: the
 * window opens on THEIR message, and every one of those is a row here. Null
 * when they have never written, which is the state of every imported
 * historical lead and is exactly why the campaign cannot free-form.
 */
create or replace function crm.window_open_until(p_conversation_id uuid)
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$
  select max(m.occurred_at) + interval '24 hours'
    from crm.conversation_messages m
   where m.conversation_id = p_conversation_id
     and m.author_type = 'client';
$$;

comment on function crm.window_open_until(uuid) is
  'When WhatsApp will stop carrying a free-form message to this conversation: 24 hours after the contact last wrote. Null when they never have - every imported historical lead is in that state, which is why the reactivation campaign cannot send free-form at all.';

create or replace function crm.window_is_open(p_conversation_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(crm.window_open_until(p_conversation_id) > now(), false);
$$;

comment on function crm.window_is_open(uuid) is
  'Whether a free-form message can still be delivered. FALSE when the contact has never written, because a window that never opened is not an open one - the coalesce is the whole difference between refusing to send and sending something Meta will refuse.';

notify pgrst, 'reload schema';

-- ── registering one ───────────────────────────────────────────────────────
--
-- Admin only, the same shape `crm.set_third_party_charge` uses: the RPC is
-- reachable by any authenticated caller, so a service-owned gate would be one
-- door on a room with two.

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
           language_code = btrim(p_language_code),
           parameters = coalesce(p_parameters, '{}'::text[])
     where t.id = v_id;
  end if;

  perform core.record_audit(
    p_organization_id, 'whatsapp_template.set', 'whatsapp_template', v_id,
    null,
    jsonb_build_object('situation', p_situation_key, 'template', btrim(p_template_name),
                       'language', btrim(p_language_code)),
    null
  );

  return query select 'set'::text, v_id;
end;
$$;

comment on function crm.set_whatsapp_template(uuid, text, text, text, text[]) is
  'Register which Meta-approved template answers a follow-up situation (G-213). Admin only in the DATABASE as well as the service. Audited, because a template is what an agency says to somebody it has not spoken to in weeks - and which one was registered when is the first question after a complaint.';

create or replace function crm.clear_whatsapp_template(
  p_organization_id uuid,
  p_situation_key text
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
   where t.organization_id = p_organization_id and t.situation_key = p_situation_key and t.active;

  if v_id is null then
    return query select 'no_template'::text; return;
  end if;

  -- Deactivated, never deleted: which template a past send used is part of
  -- the record of what this agency said.
  update crm.whatsapp_templates set active = false where id = v_id;

  perform core.record_audit(
    p_organization_id, 'whatsapp_template.withdrawn', 'whatsapp_template', v_id,
    jsonb_build_object('situation', p_situation_key), null, null
  );

  return query select 'cleared'::text;
end;
$$;

revoke all on function crm.set_whatsapp_template(uuid, text, text, text, text[]) from public;
revoke all on function crm.clear_whatsapp_template(uuid, text) from public;
grant execute on function crm.set_whatsapp_template(uuid, text, text, text, text[]) to authenticated, service_role;
grant execute on function crm.clear_whatsapp_template(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
