-- ═══════════════════════════════════════════════════════════════════════════
-- Two operational settings become settable in-product, audited — Phase 4/6.
--
-- `core.organizations.settings` (JSONB) holds non-secret operational config. Two
-- keys the product needs but could only set by hand-written SQL:
--
--   • whatsapp_phone_number_id — the business number an org claims. INBOUND
--     routing and the WhatsApp config check both read it; with no in-product way
--     to set it, WhatsApp could not be configured without database access.
--   • whatsapp_test_recipient — an owner-controlled number for a controlled test
--     send, before anything reaches a real customer (Phase 6). It did not exist.
--
-- Neither is a secret (a phone number, a numeric id), so both may be shown and
-- set. They go through one audited, whitelisted setter — nothing else about the
-- settings blob is writable through it — and a guard refuses any other
-- authenticated write of these two keys, the same shape the timezone and pilot
-- flags use. Secrets (tokens, keys) are NOT here: they live in the deployment
-- env, and the app cannot and must not write them.
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Only these two non-secret operational keys. Anything else — and any attempt
  -- to smuggle a token in through this door — is refused rather than written.
  if p_key not in ('whatsapp_phone_number_id', 'whatsapp_test_recipient') then
    return query select 'invalid_key'::text; return;
  end if;

  -- Shape the value per key. A non-numeric phone_number_id or a non-phone test
  -- recipient is a mistake worth catching here rather than at send time.
  if v_value is not null then
    if p_key = 'whatsapp_phone_number_id' and v_value !~ '^[0-9]{5,32}$' then
      return query select 'invalid_value'::text; return;
    end if;
    if p_key = 'whatsapp_test_recipient' and v_value !~ '^\+?[0-9]{6,20}$' then
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
  'Sets one WHITELISTED non-secret operational key in core.organizations.settings (whatsapp_phone_number_id, whatsapp_test_recipient), validated per key. Owner/ops_admin only for an authenticated caller, org-pinned; service role trusted. Audited in-transaction; sets the crm.org_setting_write flag the guard checks. Refuses any other key — no secret can be written through it.';

revoke all on function core.set_organization_setting(uuid, text, text) from public;
grant execute on function core.set_organization_setting(uuid, text, text) to authenticated, service_role;

-- The guard: an authenticated write that changes either whitelisted key outside
-- the setter is refused, so the audit trail holds. Fires only when one of the two
-- keys actually changes, so every other settings write — and every other org
-- write — is untouched. Service role and identity-less callers are unrestricted.
create or replace function core.org_setting_write_is_sanctioned()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.settings->>'whatsapp_phone_number_id' is not distinct from old.settings->>'whatsapp_phone_number_id'
     and new.settings->>'whatsapp_test_recipient'   is not distinct from old.settings->>'whatsapp_test_recipient' then
    return new;
  end if;
  if tg_op = 'INSERT'
     and (new.settings->>'whatsapp_phone_number_id') is null
     and (new.settings->>'whatsapp_test_recipient')   is null then
    return new;
  end if;
  if current_setting('crm.org_setting_write', true) = 'on' then
    return new;
  end if;
  if (select auth.uid()) is null then
    return new;
  end if;
  raise exception
    'core.organizations.settings whatsapp_phone_number_id / whatsapp_test_recipient are set only through core.set_organization_setting, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function core.org_setting_write_is_sanctioned() is
  'Refuses any authenticated end-user write that changes settings.whatsapp_phone_number_id or settings.whatsapp_test_recipient outside core.set_organization_setting (which sets the transaction-scoped crm.org_setting_write flag). Fires only when one of those keys changes, so other settings and organization writes are unaffected. Service role and identity-less callers are unrestricted.';

drop trigger if exists org_setting_write_is_sanctioned on core.organizations;
create trigger org_setting_write_is_sanctioned
  before insert or update on core.organizations
  for each row execute function core.org_setting_write_is_sanctioned();
