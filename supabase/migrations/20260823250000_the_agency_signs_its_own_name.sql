-- The agency signs its own name — gap G-160.
--
-- Found by the §44 preflight, one step before the first real client:
-- `core.organizations.name` still said **"Demo Agency"**, and that name is
-- the letterhead on every quotation PDF a client keeps (G-156 renders it as
-- the document's own branding, §12's word). Nothing could change it — no
-- form, no setter, only SQL — so the one column a client actually reads had
-- no owner-operable write.
--
-- The shape is the timezone's (20260818150000), copied deliberately: an
-- audited SECURITY DEFINER setter that re-checks authority in the database,
-- and a column guard so no other authenticated write can sidestep the audit
-- trail. An agency's name on money documents is identity; identity changes
-- are worth a row in the ledger.

create or replace function core.set_organization_name(p_organization_id uuid, p_name text)
returns table (outcome text)   -- 'set' | 'forbidden' | 'not_found' | 'invalid'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_was   text;
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_actor is not null then
    -- The owner alone: this is the signature on every quotation. Narrower
    -- than the timezone's owner-or-ops on purpose — an ops admin may fix a
    -- clock, not rename the agency.
    if not (select core.is_owner()) then
      return query select 'forbidden'::text; return;
    end if;
    if p_organization_id is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text; return;
    end if;
  end if;

  -- The same bound the column's own CHECK holds (non-empty), plus a ceiling
  -- a letterhead can actually wear.
  if v_name is null or length(v_name) > 120 then
    return query select 'invalid'::text; return;
  end if;

  select o.name into v_was
    from core.organizations o
   where o.id = p_organization_id
   for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  perform set_config('crm.name_write', 'on', true);
  update core.organizations set name = v_name where id = p_organization_id;

  perform core.record_audit(
    p_organization_id,
    'organization.renamed',
    'organization',
    p_organization_id,
    jsonb_build_object('name', v_was),
    jsonb_build_object('name', v_name)
  );

  return query select 'set'::text;
end;
$$;

comment on function core.set_organization_name(uuid, text) is
  'Renames the organization — the name every quotation PDF wears as its letterhead (G-156, brief section 12 "branded"). Owner only, audited as organization.renamed with the old and new name, and the column guard below refuses any other authenticated write so the trail cannot be sidestepped. SECURITY DEFINER on the timezone setter''s pattern: authority is re-checked in the body, and an identity-less caller (service_role) passes because it already holds the database (G-160).';

revoke all on function core.set_organization_name(uuid, text) from public;
grant execute on function core.set_organization_name(uuid, text) to authenticated, service_role;

create or replace function core.name_write_is_sanctioned()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.name is not distinct from old.name then
    return new;
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if current_setting('crm.name_write', true) = 'on' then
    return new;
  end if;
  if (select auth.uid()) is null then
    return new;
  end if;
  raise exception
    'core.organizations.name is set only through core.set_organization_name, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists name_write_is_sanctioned on core.organizations;
create trigger name_write_is_sanctioned
  before insert or update on core.organizations
  for each row execute function core.name_write_is_sanctioned();

notify pgrst, 'reload schema';
