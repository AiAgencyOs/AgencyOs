-- ═══════════════════════════════════════════════════════════════════════════
-- A variable nobody filled — G-215
-- ═══════════════════════════════════════════════════════════════════════════
--
-- G-213 gave `crm.whatsapp_templates` a `parameters text[]`, and its own
-- column comment says what the values are meant to be:
--
--     "Which facts fill the template's positional parameters, in order.
--      Names of things this system already holds — never literal copy."
--
-- Nothing resolved them. `deliverFollowUp` passed the array straight to Meta
-- and the sender wrapped each entry as `{type: 'text', text}`. So an Admin
-- registering the documented thing — `first_name` — sends a client the words
-- **"first_name"**. The schema described a resolution step nobody wrote.
--
-- Two ways out, and only one of them is honest. The array could be
-- redocumented as literal values, which makes every recipient of a template
-- get the same name. Or the resolution could be built. This builds it.
--
-- ── the vocabulary is closed, and small ───────────────────────────────────
--
-- A CHECK constraint, not a convention. An Admin cannot register a parameter
-- this system has no way to fill, because the alternative is discovering it
-- at send time against a real client.
--
-- It is deliberately short. Every name here resolves from a row this system
-- already holds, and nothing here is inferred: there is no `industry`, no
-- `budget`, no `next_step`, because filling those would be ADM-76's invention
-- wearing a variable's clothes.
--
-- ── and what happens when one cannot be filled ────────────────────────────
--
-- Nothing is sent. Not a fallback, not an empty string, not the name itself.
-- A template with an unfilled variable is a message the agency did not write,
-- and the client is the last person who should find that out.
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.whatsapp_templates
  drop constraint if exists whatsapp_templates_parameters_known;

alter table crm.whatsapp_templates
  add constraint whatsapp_templates_parameters_known check (
    parameters <@ array[
      -- From the contact on the other end of the thread.
      'contact_first_name',
      'contact_full_name',
      -- From the organization sending it.
      'agency_name',
      -- From the subject the send is about. Resolvable only when the caller
      -- names one; a template declaring it on a send with no quotation is
      -- refused rather than filled with a guess.
      'quotation_reference',
      'quotation_version'
    ]::text[]
  );

comment on column crm.whatsapp_templates.parameters is
  'Which facts fill the approved template''s {{1}}, {{2}} … in order. NAMES from a closed vocabulary (G-215), never literal copy and never a value: a template is one approved body sent to many people, so a literal here would be the same name for every one of them. An unfillable name is refused at registration; an unfilled one at send time stops the send.';

-- ═══════════════════════════════════════════════════════════════════════════
-- What Meta says about it, which is not what the Admin wants
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `active` was the only state a template had, and it conflated two different
-- facts: whether Meta will carry it, and whether the Admin wants it used.
-- They move independently — Meta pauses a template for poor quality without
-- anybody here doing anything, and an Admin turns one off while it is still
-- perfectly approved — and only one of them is this system's to decide.
--
-- So `status` records what META says, and `active` stays the Admin's switch.
-- A template sends only when both agree.
alter table crm.whatsapp_templates
  add column if not exists status text not null default 'approved';

alter table crm.whatsapp_templates
  drop constraint if exists whatsapp_templates_status_check;

alter table crm.whatsapp_templates
  add constraint whatsapp_templates_status_check check (status in (
    'draft',      -- written here, not yet submitted
    'submitted',  -- with Meta, waiting
    'approved',   -- Meta will carry it
    'rejected',   -- Meta refused it
    'paused',     -- Meta paused it, usually for quality
    'disabled',   -- Meta disabled it
    'archived'    -- retired here; kept because its versions are history
  ));

comment on column crm.whatsapp_templates.status is
  'What META says about this template (G-215). Only ''approved'' may be sent, and `active` is the separate switch the Admin controls — Meta pauses a template without anybody here acting, and an Admin turns one off while it is still approved. Both must agree before a send.';

-- The registry's uniqueness was "one live template per situation". A rejected
-- or archived one is not live, so it must not hold the slot: an Admin whose
-- template was rejected has to be able to register its replacement.
drop index if exists crm.whatsapp_templates_situation_key;

create unique index if not exists whatsapp_templates_situation_key
  on crm.whatsapp_templates (organization_id, situation_key)
  where active and status = 'approved';

-- ═══════════════════════════════════════════════════════════════════════════
-- Versions, because a template's history is the only account of what was sent
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A template is edited in place today, so the answer to "what did we send
-- these four hundred people in March" changes when somebody fixes a typo in
-- April. The row is current state; this is the account.
create table if not exists crm.whatsapp_template_versions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  template_id       uuid not null references crm.whatsapp_templates(id) on delete cascade,

  -- The state AFTER the change this row records.
  template_name     text not null,
  language_code     text not null,
  parameters        text[] not null default '{}'::text[],
  status            text not null,
  active            boolean not null,

  -- Who and why. Null actor for a system write; there is no such path today,
  -- and the column exists so one could not be added without saying so.
  changed_by        uuid references core.users(id) on delete set null,
  change_reason     text check (change_reason is null or length(btrim(change_reason)) between 1 and 500),

  recorded_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists whatsapp_template_versions_template_idx
  on crm.whatsapp_template_versions (template_id, recorded_at desc);

alter table crm.whatsapp_template_versions enable row level security;

drop policy if exists whatsapp_template_versions_select on crm.whatsapp_template_versions;
create policy whatsapp_template_versions_select on crm.whatsapp_template_versions
  for select using (
    core.is_internal() and organization_id = core.current_organization_id()
  );

-- No write policy at all. History is written by the trigger below, on the
-- table's own writes, and a row somebody could edit is not history.

drop trigger if exists org_match_template_versions on crm.whatsapp_template_versions;
create trigger org_match_template_versions
  before insert or update of template_id, organization_id on crm.whatsapp_template_versions
  for each row execute function core.enforce_parent_org('template_id', 'crm.whatsapp_templates');

drop trigger if exists freeze_org_template_versions on crm.whatsapp_template_versions;
create trigger freeze_org_template_versions
  before update on crm.whatsapp_template_versions
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at on crm.whatsapp_template_versions;
create trigger set_updated_at
  before update on crm.whatsapp_template_versions
  for each row execute function core.set_updated_at();

grant select on crm.whatsapp_template_versions to authenticated, service_role;
grant insert on crm.whatsapp_template_versions to service_role;

create or replace function crm.record_template_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Every insert and every change that alters what would be SENT. A row
  -- touched without any of those changing (an `updated_at` bump) writes no
  -- version, because nothing happened worth an account.
  if tg_op = 'UPDATE'
     and new.template_name is not distinct from old.template_name
     and new.language_code is not distinct from old.language_code
     and new.parameters    is not distinct from old.parameters
     and new.status        is not distinct from old.status
     and new.active        is not distinct from old.active then
    return new;
  end if;

  insert into crm.whatsapp_template_versions (
    organization_id, template_id, template_name, language_code,
    parameters, status, active, changed_by
  )
  values (
    new.organization_id, new.id, new.template_name, new.language_code,
    new.parameters, new.status, new.active,
    -- The authenticated writer, when there is one. A service-role write
    -- (there is none today) records null rather than naming somebody.
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  );

  return new;
end;
$$;

comment on function crm.record_template_version() is
  'Writes an immutable version row whenever a template is created or changed in a way that alters what would be sent (G-215). An updated_at bump writes nothing, because nothing happened worth an account.';

drop trigger if exists record_template_version on crm.whatsapp_templates;
create trigger record_template_version
  after insert or update on crm.whatsapp_templates
  for each row execute function crm.record_template_version();

-- ── the Admin's account of what Meta said ─────────────────────────────────
--
-- Separate from registration on purpose. Registering is *"this is the name
-- Meta approved"*; this is *"Meta has since paused it"* — a different fact,
-- learned at a different time, usually from an email rather than from
-- anything happening here.
create or replace function crm.set_whatsapp_template_status(
  p_organization_id uuid,
  p_situation_key text,
  p_status text
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

  if p_status not in ('draft','submitted','approved','rejected','paused','disabled','archived') then
    return query select 'unknown_status'::text, null::uuid; return;
  end if;

  -- The one the Admin is looking at: the live row for this situation,
  -- whatever its current status. Ordered so a re-registration after a
  -- rejection resolves to the newest rather than to the rejected one.
  select t.id into v_id
    from crm.whatsapp_templates t
   where t.organization_id = p_organization_id
     and t.situation_key = p_situation_key
     and t.active
   order by t.created_at desc
   limit 1;

  if v_id is null then
    return query select 'not_registered'::text, null::uuid; return;
  end if;

  update crm.whatsapp_templates t set status = p_status where t.id = v_id;

  perform core.record_audit(
    p_organization_id, 'whatsapp_template.status', 'whatsapp_template', v_id,
    jsonb_build_object('situation_key', p_situation_key, 'status', p_status)
  );

  return query select 'set'::text, v_id;
end;
$$;

comment on function crm.set_whatsapp_template_status(uuid, text, text) is
  'Records what META says about a registered template (G-215) — approved, paused, rejected and the rest. Separate from registration because it is a different fact learned at a different time, usually from an email. Admin-only and audited; only ''approved'' plus the Admin''s own `active` switch permits a send.';

revoke all on function crm.set_whatsapp_template_status(uuid, text, text) from public, anon;
grant execute on function crm.set_whatsapp_template_status(uuid, text, text) to authenticated, service_role;
