-- ═══════════════════════════════════════════════════════════════════════════
-- A member belongs to a department.
--
-- Owner decision 2 (2026-10-03): department only, from a FIXED list — Design,
-- Development, QA, Sales, Management, Operations. No "Online" indicator (the
-- Team tab keeps "last active"). The list is fixed in the schema, not a lookup
-- an admin can extend: a CHECK on core.memberships.department.
--
-- Written only through core.set_member_department(user, department | null):
-- security definer, re-checks that the caller is an owner or an ops admin of
-- the same organisation, audited. (memberships_write already lets an owner
-- write the row directly; this door is the one the app uses and the one that
-- lets an ops admin, who has no write policy, set it.)
-- ═══════════════════════════════════════════════════════════════════════════

alter table core.memberships add column if not exists department text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'memberships_department_check' and conrelid = 'core.memberships'::regclass) then
    alter table core.memberships
      add constraint memberships_department_check
      check (department is null or department in ('Design', 'Development', 'QA', 'Sales', 'Management', 'Operations'));
  end if;
end
$$;

comment on column core.memberships.department is
  'The department the member works in, from a fixed list (Design, Development, QA, Sales, Management, Operations); null = not set. Written by core.set_member_department.';

create or replace function core.set_member_department(p_user_id uuid, p_department text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_dept   text := nullif(btrim(coalesce(p_department, '')), '');
  v_member core.memberships;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if v_dept is not null and v_dept not in ('Design', 'Development', 'QA', 'Sales', 'Management', 'Operations') then
    return query select 'invalid_department'::text; return;
  end if;
  select * into v_member from core.memberships m where m.user_id = p_user_id and m.organization_id = v_org for update;
  if v_member.id is null then
    return query select 'not_a_member'::text; return;
  end if;
  if v_member.department is not distinct from v_dept then
    return query select 'unchanged'::text; return;
  end if;

  update core.memberships set department = v_dept where id = v_member.id;

  perform core.record_audit(
    v_org, 'membership.department_set', 'membership', v_member.id,
    jsonb_build_object('department', v_member.department),
    jsonb_build_object('department', v_dept, 'userId', p_user_id)
  );
  return query select 'set'::text;
end;
$$;

comment on function core.set_member_department(uuid, text) is
  'Sets (or clears, with null) a member''s department from the fixed list. Owner or ops admin of the same organisation only; audited membership.department_set.';

revoke all on function core.set_member_department(uuid, text) from public, anon;
grant execute on function core.set_member_department(uuid, text) to authenticated, service_role;
