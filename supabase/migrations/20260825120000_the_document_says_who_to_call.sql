-- The document says who to call — G-171.
--
-- Every one of the 45 quotations the corpus study read carried a contact
-- block: an email, a phone number and a place. The generated PDF carries the
-- agency's NAME and nothing else, so a client who forwards it to a partner —
-- which is the whole reason a PDF exists rather than a WhatsApp message —
-- has no way to reach the agency from the document in their hand.
--
-- Three new keys, and they go through the same door as the two that already
-- exist, for the same reasons: the whitelist lives HERE rather than in the
-- service, so no key can be smuggled in from a caller; each value is shaped
-- on the way in, because a malformed phone number on a client-facing document
-- is caught cheaply here and expensively later; and the write is audited.
--
-- They are contact details, not secrets, and the setter's own comment already
-- says what it refuses to carry. Nothing about this widens what may be
-- written — only which of the non-secret operational keys are recognised.

create or replace function core.set_organization_setting(
  p_organization_id uuid,
  p_key text,
  p_value text
)
returns table (outcome text)   -- 'set' | 'cleared' | 'forbidden' | 'not_found' | 'invalid_key' | 'invalid_value'
language plpgsql
volatile
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
    'quotation_contact_location'
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
  'Sets one WHITELISTED non-secret operational key in core.organizations.settings (whatsapp_phone_number_id, whatsapp_test_recipient, quotation_contact_email, quotation_contact_phone, quotation_contact_location), validated per key. Owner/ops_admin only for an authenticated caller, org-pinned; service role trusted. Audited in-transaction; sets the crm.org_setting_write flag the guard checks. Refuses any other key — no secret can be written through it.';

grant execute on function core.set_organization_setting(uuid, text, text) to authenticated, service_role;

-- The guard travels with the whitelist, or it stops guarding.
--
-- It refuses an authenticated write that changes a whitelisted key outside
-- the setter, so the audit trail holds. Widened here for the same reason the
-- whitelist was: a contact block printed on a client-facing document must not
-- be changeable without a record of who changed it. The key list is written
-- once as an array so the two halves cannot drift apart the way they would if
-- each key were named again in its own condition.
create or replace function core.org_setting_write_is_sanctioned()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_keys text[] := array[
    'whatsapp_phone_number_id',
    'whatsapp_test_recipient',
    'quotation_contact_email',
    'quotation_contact_phone',
    'quotation_contact_location'
  ];
  v_key text;
  v_changed boolean := false;
begin
  if tg_op = 'UPDATE' then
    foreach v_key in array v_keys loop
      if new.settings->>v_key is distinct from old.settings->>v_key then
        v_changed := true;
        exit;
      end if;
    end loop;
    if not v_changed then
      return new;
    end if;
  end if;

  if tg_op = 'INSERT' then
    foreach v_key in array v_keys loop
      if (new.settings->>v_key) is not null then
        v_changed := true;
        exit;
      end if;
    end loop;
    if not v_changed then
      return new;
    end if;
  end if;

  if current_setting('crm.org_setting_write', true) = 'on' then
    return new;
  end if;
  if (select auth.uid()) is null then
    return new;
  end if;
  raise exception
    'core.organizations.settings whitelisted operational keys are set only through core.set_organization_setting, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function core.org_setting_write_is_sanctioned() is
  'Refuses any authenticated end-user write that changes a whitelisted operational settings key (whatsapp_phone_number_id, whatsapp_test_recipient, quotation_contact_email, quotation_contact_phone, quotation_contact_location) outside core.set_organization_setting (which sets the transaction-scoped crm.org_setting_write flag). Fires only when one of those keys changes, so other settings and organization writes are unaffected. Service role and identity-less callers are unrestricted.';

drop trigger if exists org_setting_write_is_sanctioned on core.organizations;
create trigger org_setting_write_is_sanctioned
  before insert or update on core.organizations
  for each row execute function core.org_setting_write_is_sanctioned();
