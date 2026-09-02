-- The project group's name — G-188.
--
-- ── the requirement, quoted, because it is unusually specific ─────────────
--
-- The brief that commissioned the zero-trust audit ends at the last step of
-- the flow — PROJECT WHATSAPP GROUP CREATION — and states the title format
-- literally:
--
--     PROJECT NAME // FINAL QUOTATION PRICE // PROJECT START DATE //
--     CLIENT NAME // [remaining configured identifier]
--
-- The audit found (PG-03) that `crm.conversations.title` is free text on the
-- link form and **nothing composes that name anywhere**. The owner types
-- whatever they type, and the one part of this step AgencyOS can actually do
-- was not being done.
--
-- ── what this can and cannot do, stated before the SQL ────────────────────
--
-- **It cannot create the group.** Meta's WhatsApp Cloud API has no Groups
-- API; the owner established that against the real Graph API (error #131215)
-- and §17 of the audit records it as a platform limitation rather than a
-- missing feature. A human creates the group in WhatsApp and links it here.
--
-- So the honest half is this: **compose the exact name, and hand it to them.**
-- A name a person retypes from five different screens is a name that will be
-- wrong on the third project.
--
-- ── it refuses to invent a segment, and says which one is missing ─────────
--
-- Every segment is a FACT about a row: the project's name, the accepted
-- quotation's total, the project's start date, the client account's name. A
-- title assembled with a guessed price is worse than no title — it would be
-- read as the price the client agreed. So the function returns the segments it
-- has AND the names of the ones it does not, and the page says what to fix.
--
-- The fifth segment is the owner's own: `project_group_identifier`, one
-- setting, appended when set and omitted entirely when not. The brief writes
-- it in brackets, which is how an optional field is written.
--
-- ── which date, and why it is not started_at ──────────────────────────────
--
-- `projects.started_at` is when the project OFFICIALLY started, and ADM-13
-- makes the linked group one of the three conditions for that. So at the
-- moment this name is needed, `started_at` is null by definition. The honest
-- source is `starts_on`, the planned start date, which is what the client is
-- being told in the group's own name.

-- ── 1. the owner's own fifth segment ──────────────────────────────────────

create or replace function core.set_organization_setting(
  p_organization_id uuid,
  p_key text,
  p_value text
)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_value text := nullif(btrim(coalesce(p_value, '')), '');
  v_old   text;
  v_settings jsonb;
begin
  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text; return;
    end if;
    if p_organization_id is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text; return;
    end if;
  end if;

  -- The whitelist. Anything else — and any attempt to smuggle a token in
  -- through this door — is refused rather than written.
  if p_key not in (
    'whatsapp_phone_number_id',
    'whatsapp_test_recipient',
    'quotation_contact_email',
    'quotation_contact_phone',
    'quotation_contact_location',
    -- G-179 — the pricing model's own inputs.
    'pricing_day_rate_rupees',
    'pricing_ai_day_rate_rupees',
    'pricing_multiplier_min',
    'pricing_multiplier_target',
    'pricing_multiplier_max',
    -- G-188 — the fifth segment of the project group's name.
    'project_group_identifier'
  ) then
    return query select 'invalid_key'::text; return;
  end if;

  -- Shape the value per key. A non-numeric phone_number_id or a non-phone test
  -- recipient is a mistake worth catching here rather than at send time — and
  -- the three contact keys are printed on a document a client keeps, which is
  -- a worse place to discover a typo than this one.
  if v_value is not null then
    if p_key = 'whatsapp_phone_number_id' and v_value !~ '^[0-9]{5,32}$' then
      return query select 'invalid_value'::text; return;
    end if;
    if p_key = 'whatsapp_test_recipient' and v_value !~ '^\+?[0-9]{6,20}$' then
      return query select 'invalid_value'::text; return;
    end if;
    -- Deliberately loose but not absent: one @, no spaces, a dot after it.
    -- Anything stricter starts refusing addresses that work.
    if p_key = 'quotation_contact_email'
       and v_value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
      return query select 'invalid_value'::text; return;
    end if;
    -- Digits, spaces, hyphens and an optional leading +: the shapes a person
    -- actually writes a phone number in.
    if p_key = 'quotation_contact_phone' and v_value !~ '^\+?[0-9][0-9 -]{5,24}$' then
      return query select 'invalid_value'::text; return;
    end if;
    if p_key = 'quotation_contact_location' and length(v_value) > 80 then
      return query select 'invalid_value'::text; return;
    end if;

    -- G-179. Whole rupees, no separators: a rate typed as "8,000" would
    -- parse to 8 on the way out and quietly divide the agency's costs by a
    -- thousand. Bounded at ten lakh a day, which is far above any real rate
    -- and far below a slipped decimal point.
    if p_key in ('pricing_day_rate_rupees', 'pricing_ai_day_rate_rupees') then
      if v_value !~ '^[0-9]{1,7}$' then
        return query select 'invalid_value'::text; return;
      end if;
      if v_value::numeric > 1000000 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- A multiplier, written the way the owner says it: 2, 2.5, 3. Refused
    -- at or below 1, because a "band" that prices at or under cost is not a
    -- band anybody meant to configure — it is a percentage typed into the
    -- wrong field, which is exactly the mistake 250 would be.
    if p_key in ('pricing_multiplier_min', 'pricing_multiplier_target', 'pricing_multiplier_max') then
      if v_value !~ '^[0-9]{1,2}(\.[0-9]{1,2})?$' then
        return query select 'invalid_value'::text; return;
      end if;
      if v_value::numeric <= 1 or v_value::numeric > 10 then
        return query select 'invalid_value'::text; return;
      end if;
    end if;

    -- G-188. The fifth segment of a WhatsApp group's name, which a person
    -- reads on their phone: short enough that the four facts before it are
    -- still visible, and free of the separator the format itself uses.
    if p_key = 'project_group_identifier' then
      if length(v_value) > 40 or v_value like '%//%' then
        return query select 'invalid_value'::text; return;
      end if;
    end if;
  end if;

  select o.settings into v_settings
    from core.organizations o
   where o.id = p_organization_id
   for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;
  v_old := v_settings->>p_key;

  perform set_config('crm.org_setting_write', 'on', true);
  update core.organizations
     set settings = case
       when v_value is null then (coalesce(settings, '{}'::jsonb) - p_key)
       else coalesce(settings, '{}'::jsonb) || jsonb_build_object(p_key, v_value)
     end
   where id = p_organization_id;

  perform core.record_audit(
    p_organization_id,
    'organization.setting_set',
    'organization',
    p_organization_id,
    jsonb_build_object('key', p_key, 'value', v_old),
    jsonb_build_object('key', p_key, 'value', v_value)
  );

  return query select case when v_value is null then 'cleared' else 'set' end;
end;
$$;

comment on function core.set_organization_setting(uuid, text, text) is
  'The one door for an organization setting, whitelisted by key and audited as organization.setting_set. Regenerated from the live definition on G-188 to admit project_group_identifier - the owner''s own fifth segment of a project group''s name - and never retyped, because a hand-rewritten function drops a branch and every structural test stays green (the PR #113 near miss, recorded as G-126).';

-- ── 2. the name itself ────────────────────────────────────────────────────

create or replace function crm.project_group_title(p_project_id uuid)
returns table (title text, missing text[])
language plpgsql
stable
set search_path = ''
as $$
declare
  v_project    record;
  v_client     text;
  v_price      bigint;
  v_currency   text;
  v_identifier text;
  v_missing    text[] := '{}';
  v_parts      text[] := '{}';
begin
  select p.id, p.name, p.starts_on, p.organization_id, p.client_account_id, p.proposal_id
    into v_project
    from projects.projects p
   where p.id = p_project_id;

  if v_project.id is null then
    return query select null::text, array['project']::text[];
    return;
  end if;

  select a.name into v_client
    from core.client_accounts a
   where a.id = v_project.client_account_id;

  -- The FINAL QUOTATION price, from the quotation the project was raised
  -- from (G-017 carries it forward as `proposal_id`). Deliberately not
  -- `budget_minor`: a budget is what the agency planned, and the brief asks
  -- for the number the client agreed to.
  select pr.total_minor, pr.currency into v_price, v_currency
    from sales.proposals pr
   where pr.id = v_project.proposal_id;

  select o.settings->>'project_group_identifier' into v_identifier
    from core.organizations o
   where o.id = v_project.organization_id;

  if coalesce(btrim(v_project.name), '') = '' then
    v_missing := v_missing || 'project name'::text;
  else
    v_parts := v_parts || btrim(v_project.name)::text;
  end if;

  if v_price is null then
    v_missing := v_missing || 'accepted quotation'::text;
  else
    -- Whole rupees with Indian grouping, the way every other figure this
    -- system shows a person is written. `to_char` with FM strips the padding
    -- Postgres would otherwise leave in front of it.
    v_parts := v_parts || (
      case when coalesce(v_currency, 'INR') = 'INR' then '₹' else coalesce(v_currency, '') || ' ' end
      || to_char(round(v_price / 100.0), 'FM99,99,99,999')
    )::text;
  end if;

  if v_project.starts_on is null then
    v_missing := v_missing || 'start date'::text;
  else
    -- Written the way a person reads a date on their phone, not ISO: the
    -- name is for humans in a WhatsApp list, and 2026-09-14 beside a rupee
    -- figure reads as another number.
    v_parts := v_parts || to_char(v_project.starts_on, 'FMDD Mon YYYY')::text;
  end if;

  if coalesce(btrim(v_client), '') = '' then
    v_missing := v_missing || 'client name'::text;
  else
    v_parts := v_parts || btrim(v_client)::text;
  end if;

  -- The fifth is optional, and its absence is NOT a missing fact: the brief
  -- writes it in brackets, which is how an optional field is written. An
  -- organization that has not set one gets a four-part name rather than a
  -- name with an empty tail.
  if coalesce(btrim(coalesce(v_identifier, '')), '') <> '' then
    v_parts := v_parts || btrim(v_identifier)::text;
  end if;

  -- A partial title is not offered. A name assembled around a missing price
  -- would be read as a name whose price is simply absent, and pasted.
  if array_length(v_missing, 1) is not null then
    return query select null::text, v_missing;
    return;
  end if;

  return query select array_to_string(v_parts, ' // '), '{}'::text[];
end;
$$;

comment on function crm.project_group_title(uuid) is
  'The project WhatsApp group''s name, composed exactly as the brief specifies it (G-188): PROJECT NAME // FINAL QUOTATION PRICE // PROJECT START DATE // CLIENT NAME // identifier. Every segment is a fact about a row and none is invented - a title assembled around a guessed price would be read as the price the client agreed, so when a fact is missing this returns null and names what is missing instead. The fifth segment is the organization''s own project_group_identifier setting and is omitted entirely when unset. It cannot create the group: Meta''s Cloud API has no Groups API (#131215), so a person creates it and links it, and the one thing this system can do is hand them the exact name.';

-- ── 3. and the linker uses it ─────────────────────────────────────────────
--
-- REGENERATED FROM THE LIVE DEFINITION, not retyped. The body below is
-- `pg_get_functiondef` output with exactly one block added and one identifier
-- changed; the three unique-violation branches, the two failed attempts
-- recorded in its own comments and the G-176 announcement all survive because
-- nothing here was written from memory. That is the PR #113 near miss, which
-- G-126 records: a hand-rewritten function drops a branch and every structural
-- test stays green.

CREATE OR REPLACE FUNCTION crm.link_whatsapp_group(p_organization_id uuid, p_kind text, p_external_ref text, p_project_id uuid DEFAULT NULL::uuid, p_title text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, conversation_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $$
declare
  v_id    uuid;
  v_title text := p_title;
begin
  if p_kind not in ('project_group', 'internal_group') then
    return query select 'bad_kind'::text, null::uuid;
    return;
  end if;

  /**
   * The name, when the caller did not bring one — G-188.
   *
   * A project group's name is specified exactly (PROJECT NAME // FINAL
   * QUOTATION PRICE // PROJECT START DATE // CLIENT NAME // identifier), and
   * before this the column was free text on a form: the one part of this step
   * AgencyOS can do was not being done. `project_group_title` answers null
   * when a fact is missing rather than assembling a name around a guess, and a
   * null title is exactly what this function stored before — so a project that
   * cannot be named yet links exactly as it always did.
   *
   * A title the caller DID supply is never overwritten. An owner renaming a
   * group they created is not a mistake to correct.
   */
  if v_title is null and p_kind = 'project_group' and p_project_id is not null then
    select t.title into v_title from crm.project_group_title(p_project_id) t;
  end if;

  begin
    insert into crm.conversations (
      organization_id, kind, project_id, channel, external_ref, status, title
    )
    values (
      p_organization_id, p_kind, p_project_id, 'whatsapp', p_external_ref, 'active', v_title
    )
    returning id into v_id;
  exception
    when unique_violation then
      -- Three indexes can raise this and they mean different things, so the
      -- handler has to tell them apart.
      --
      -- Two attempts at that failed against real Postgres before this one.
      -- `get stacked diagnostics ... constraint_name` came back empty from
      -- inside a nested block, and still did not identify a partial unique
      -- *index* once the declaration was moved out — so a group held by another
      -- agency was reported to the caller as their own, twice, with every
      -- structural test green both times.
      --
      -- Asking the data settles it. The rows are right there in the same
      -- transaction, they cannot be empty, and they are not prose that a
      -- server's locale can translate.

      -- Does somebody already hold this group id? That is the refusal a retry
      -- cannot fix, and it is checked first because it outranks the others: a
      -- group belonging to another tenant is not "already linked" to this one.
      if exists (
        select 1
          from crm.conversations c
         where c.external_ref = p_external_ref
           and c.kind in ('project_group', 'internal_group')
           and c.status <> 'abandoned'
           and not (
             (p_kind = 'project_group' and c.project_id is not distinct from p_project_id)
             or (p_kind = 'internal_group' and c.organization_id = p_organization_id and c.kind = 'internal_group')
           )
      ) then
        return query select 'group_taken'::text, null::uuid;
        return;
      end if;

      -- Otherwise this project, or this organization, already has a live group.
      select c.id into v_id
        from crm.conversations c
       where c.kind = p_kind
         and c.status <> 'abandoned'
         and (
           (p_kind = 'project_group' and c.project_id = p_project_id)
           or (p_kind = 'internal_group' and c.organization_id = p_organization_id)
         )
       limit 1;

      -- A violation that matches neither is one this function does not
      -- understand, and answering it as success would be a guess.
      if v_id is null then
        raise;
      end if;

      return query select 'already_linked'::text, v_id;
      return;
  end;

  -- G-176, and only for the internal channel — see the header above.
  if p_kind = 'internal_group' then
    perform crm.announce_waiting_approvals(p_organization_id);
  end if;

  return query select 'linked'::text, v_id;
end;
$$;

comment on function crm.link_whatsapp_group(uuid, text, text, uuid, text) is
  'Links a WhatsApp group as a conversation (G-015, G-109), and since G-188 names a project group with crm.project_group_title when the caller brings no title of their own. A title the caller DID supply is never overwritten - an owner renaming a group they created is not a mistake to correct - and a project whose name cannot yet be composed links with a null title exactly as it always did.';
