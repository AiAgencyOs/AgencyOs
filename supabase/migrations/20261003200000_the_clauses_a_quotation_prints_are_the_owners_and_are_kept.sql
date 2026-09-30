-- ═══════════════════════════════════════════════════════════════════════════
-- The clauses a quotation prints are the owner's, and are kept.
--
-- Configurability audit B-6. Clauses 2-5 of the standard commercial terms —
-- the acceptance window, cancellation, the liability cap and the
-- jurisdiction — were code constants (`COMMERCIAL_TERMS` in
-- src/modules/sales/quotation-standards.ts) printed on every quotation PDF.
-- They are legal wording an agency will want in its own words, and they are
-- the one part of a quotation a client can later hold the agency to.
--
-- Two promises, and the second is the reason this is a table and not four
-- settings keys:
--
--   1. The owner (or an ops admin) can publish new wording — through one
--      door, validated, audited with the key, the version and who.
--   2. A quotation keeps the clause it PRINTED. Wording is APPENDED, never
--      edited: every publish is a new version, and the first time a
--      non-draft quotation is rendered it takes a snapshot of the versions
--      then in force (`sales.proposals.clauses_printed`). Every later render
--      of that quotation reads the snapshot, never today's clauses — the same
--      rule that freezes its price and its signature.
--
-- Unset means the code constants, exactly as before: a key with no published
-- version is simply absent from the snapshot, and the renderer fills it from
-- the constants. Nothing changes for an organization that never edits.
--
-- ── who may do what ───────────────────────────────────────────────────────
--
-- Publishing is OWNER or OPS_ADMIN (core.is_admin(), primary or secondary
-- role). Reading is every internal role. The table grants `authenticated`
-- SELECT only, behind an organization policy; there is no INSERT, UPDATE or
-- DELETE grant, and a trigger refuses any UPDATE and any DELETE that is not
-- the service role's (retention and the live verifier's cleanup), so a
-- published clause cannot be edited in place by anybody a session can be.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists sales.quotation_clauses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  clause_key      text not null
                  check (clause_key in ('acceptance_window', 'cancellation', 'liability_cap', 'jurisdiction')),
  version         integer not null check (version >= 1),
  -- Printed on a document a client keeps, one line per clause: long enough to
  -- be a sentence of law, short enough to stay a clause, and neither markup
  -- nor a line break.
  body            text not null
                  check (char_length(body) between 10 and 1200)
                  check (body !~ '[<>]')
                  check (body !~ '[\r\n]'),
  effective_from  timestamptz not null default now(),
  created_by      uuid not null references core.users(id),
  unique (organization_id, clause_key, version)
);

comment on table sales.quotation_clauses is
  'Configurability audit B-6. The wording of quotation clauses 2-5, appended a version at a time and never edited. A key with no row here prints the code constant. Written only through core.publish_quotation_clause; a quotation keeps the versions in force when it was first rendered outside draft (sales.proposals.clauses_printed).';

alter table sales.quotation_clauses enable row level security;
alter table sales.quotation_clauses force row level security;

drop policy if exists quotation_clauses_read on sales.quotation_clauses;
create policy quotation_clauses_read on sales.quotation_clauses
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists quotation_clauses_service on sales.quotation_clauses;
create policy quotation_clauses_service on sales.quotation_clauses
  for all to service_role
  using (true)
  with check (true);

revoke all on table sales.quotation_clauses from public, anon, authenticated;
grant select on table sales.quotation_clauses to authenticated;
grant select, insert, delete on table sales.quotation_clauses to service_role;

-- Appended, never edited. UPDATE is refused for everyone; DELETE only for the
-- service role (retention, and the live verifier removing what it wrote).
create or replace function sales.quotation_clauses_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'a published clause is never edited; publish version % instead', old.version + 1
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' and current_user in ('authenticated', 'anon') then
    raise exception 'a published clause is history and is not deleted'
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists quotation_clauses_append_only on sales.quotation_clauses;
create trigger quotation_clauses_append_only
  before update or delete on sales.quotation_clauses
  for each row execute function sales.quotation_clauses_append_only();

-- ── publish: the one door that writes ──────────────────────────────────────

create or replace function core.publish_quotation_clause(p_key text, p_body text)
returns table (
  -- 'published' | 'unchanged' (the text is already the version in force)
  -- refusals: 'no_actor' | 'not_authorized' | 'invalid_key' | 'invalid_body'
  outcome text,
  version integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_body   text := btrim(coalesce(p_body, ''));
  v_latest record;
  v_next   integer;
  v_id     uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::integer; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text, null::integer; return;
  end if;
  if p_key is null or p_key not in ('acceptance_window', 'cancellation', 'liability_cap', 'jurisdiction') then
    return query select 'invalid_key'::text, null::integer; return;
  end if;
  if char_length(v_body) < 10 or char_length(v_body) > 1200 or v_body ~ '[<>]' or v_body ~ '[\r\n]' then
    return query select 'invalid_body'::text, null::integer; return;
  end if;

  -- One publish at a time per clause, so two people cannot both take v3.
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || p_key, 0));

  select c.version, c.body into v_latest
    from sales.quotation_clauses c
   where c.organization_id = v_org and c.clause_key = p_key
   order by c.version desc
   limit 1;

  if found and v_latest.body = v_body then
    return query select 'unchanged'::text, v_latest.version; return;
  end if;

  v_next := coalesce(v_latest.version, 0) + 1;

  insert into sales.quotation_clauses (organization_id, clause_key, version, body, created_by)
  values (v_org, p_key, v_next, v_body, v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org,
    'quotation_clause.published',
    'quotation_clause',
    v_id,
    case when v_latest.version is null then null
         else jsonb_build_object('key', p_key, 'version', v_latest.version, 'body', v_latest.body) end,
    jsonb_build_object('key', p_key, 'version', v_next, 'body', v_body, 'by', v_actor)
  );

  return query select 'published'::text, v_next;
end;
$$;

comment on function core.publish_quotation_clause(text, text) is
  'Appends a new version of one quotation clause (acceptance_window, cancellation, liability_cap, jurisdiction). Owner or ops admin, re-checked here; 10-1200 characters, no markup, no line break; never edits an earlier version. Audited as quotation_clause.published with the key, the version, the body and who.';

revoke all on function core.publish_quotation_clause(text, text) from public, anon;
grant execute on function core.publish_quotation_clause(text, text) to authenticated;

-- ── list: every version, for the screen and its history ────────────────────

create or replace function core.list_quotation_clauses()
returns table (
  clause_key      text,
  version         integer,
  body            text,
  effective_from  timestamptz,
  created_by      uuid,
  created_by_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.clause_key, c.version, c.body, c.effective_from, c.created_by,
         coalesce(u.full_name, u.email)
    from sales.quotation_clauses c
    left join core.users u on u.id = c.created_by
   where c.organization_id = (select core.current_organization_id())
     and coalesce((select core.is_internal()), false)
   order by c.clause_key, c.version desc;
$$;

comment on function core.list_quotation_clauses() is
  'Every published version of every quotation clause for the session''s organization, newest first per clause — any internal role. Empty for a role that is not internal; an unset clause has no row and prints the code constant.';

revoke all on function core.list_quotation_clauses() from public, anon;
grant execute on function core.list_quotation_clauses() to authenticated;

-- ── what a quotation printed ───────────────────────────────────────────────

alter table sales.proposals add column if not exists clauses_printed jsonb;

comment on column sales.proposals.clauses_printed is
  'Configurability audit B-6. The clause versions in force the first time this quotation was rendered outside draft, as {clause_key: {version, body}} — a key the owner had never published is absent and prints the code constant. Null while a draft. Set once by sales.clauses_for_proposal and never changed, so re-rendering an issued quotation never reads today''s clauses.';

create or replace function sales.proposals_clauses_printed_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.clauses_printed is distinct from old.clauses_printed then
    if old.clauses_printed is not null then
      raise exception 'the clauses proposal v% printed are a record of what happened, and do not change', old.version
        using errcode = 'restrict_violation';
    end if;
    if new.status = 'draft' then
      raise exception 'a draft has not printed anything yet; its clauses are frozen when it is first rendered outside draft'
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists proposals_clauses_printed_guard on sales.proposals;
create trigger proposals_clauses_printed_guard
  before update on sales.proposals
  for each row execute function sales.proposals_clauses_printed_guard();

-- The clauses to print for one quotation. A draft answers with the versions in
-- force NOW and stores nothing; the first ask on anything past draft takes the
-- snapshot under the row lock, and every ask after returns that snapshot.
create or replace function sales.clauses_for_proposal(p_proposal_id uuid)
returns table (
  -- 'live' (a draft: today's clauses, nothing stored) | 'frozen' (the snapshot)
  -- refusals: 'not_found' | 'forbidden'
  outcome text,
  clauses jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_row     record;
  v_current jsonb;
begin
  select p.id, p.organization_id, p.status, p.clauses_printed into v_row
    from sales.proposals p
   where p.id = p_proposal_id
   for update;
  if not found then
    return query select 'not_found'::text, null::jsonb; return;
  end if;

  -- A signed-in caller must be internal and in the quotation's own
  -- organization; the service role (the worker that attaches the PDF for the
  -- owner) has no session and is trusted as the runtime it is.
  if v_actor is not null then
    if not coalesce((select core.is_internal()), false)
       or v_row.organization_id is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text, null::jsonb; return;
    end if;
  end if;

  if v_row.clauses_printed is not null then
    return query select 'frozen'::text, v_row.clauses_printed; return;
  end if;

  select coalesce(jsonb_object_agg(l.clause_key, jsonb_build_object('version', l.version, 'body', l.body)), '{}'::jsonb)
    into v_current
    from (
      select distinct on (c.clause_key) c.clause_key, c.version, c.body
        from sales.quotation_clauses c
       where c.organization_id = v_row.organization_id
       order by c.clause_key, c.version desc
    ) l;

  if v_row.status = 'draft' then
    return query select 'live'::text, v_current; return;
  end if;

  update sales.proposals set clauses_printed = v_current where id = v_row.id;
  return query select 'frozen'::text, v_current;
end;
$$;

comment on function sales.clauses_for_proposal(uuid) is
  'The quotation clauses to print for one quotation (configurability audit B-6). A draft gets the versions in force now and stores nothing; the first call on a non-draft quotation stores them as sales.proposals.clauses_printed under the row lock and every later call returns that snapshot — so an issued quotation keeps the clause it printed however the wording is edited afterwards.';

revoke all on function sales.clauses_for_proposal(uuid) from public, anon;
grant execute on function sales.clauses_for_proposal(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
