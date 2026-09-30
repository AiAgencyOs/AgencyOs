-- ═══════════════════════════════════════════════════════════════════════════
-- A project has a type, a technology and tags.
--
-- Owner decision 4 (2026-10-03): the TYPE comes from a fixed list — Website,
-- Web app, Mobile app, SaaS, E-commerce, Branding, Other. TECHNOLOGY and TAGS
-- are free-text chips.
--
--   projects.projects.project_type   fixed list (CHECK), null = not set
--   projects.projects.technology     text[]  ≤ 12 chips
--   projects.projects.tags           text[]  ≤ 10 chips
--
-- A chip is trimmed, lower-cased, 1–30 characters, and appears once. The
-- normalising and the length rule are the door's
-- (projects.set_project_classification); the COUNTS (12 and 10) are also CHECKs,
-- so no other path can exceed them. Written through the door only by a
-- task.write role (core.can_write()), audited project.classification_set.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.projects add column if not exists project_type text;
alter table projects.projects add column if not exists technology text[] not null default '{}';
alter table projects.projects add column if not exists tags text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'projects_project_type_check' and conrelid = 'projects.projects'::regclass) then
    alter table projects.projects add constraint projects_project_type_check
      check (project_type is null or project_type in ('Website', 'Web app', 'Mobile app', 'SaaS', 'E-commerce', 'Branding', 'Other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'projects_technology_bounded' and conrelid = 'projects.projects'::regclass) then
    alter table projects.projects add constraint projects_technology_bounded
      check (coalesce(cardinality(technology), 0) <= 12);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'projects_tags_bounded' and conrelid = 'projects.projects'::regclass) then
    alter table projects.projects add constraint projects_tags_bounded
      check (coalesce(cardinality(tags), 0) <= 10);
  end if;
end
$$;

comment on column projects.projects.project_type is
  'What kind of project this is, from a fixed list (Website, Web app, Mobile app, SaaS, E-commerce, Branding, Other); null = not set.';
comment on column projects.projects.technology is
  'Technology chips (react, node, flutter …): lower-cased, trimmed, unique, at most 12, each 1–30 characters. Written by projects.set_project_classification.';
comment on column projects.projects.tags is
  'Free tag chips: lower-cased, trimmed, unique, at most 10, each 1–30 characters. Written by projects.set_project_classification.';

-- One place that says what a chip list is: trimmed, lower-cased, blanks and
-- duplicates dropped, first-seen order kept.
create or replace function projects.normalise_chips(p_chips text[])
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(x.chip order by x.first_at), '{}')
    from (
      select lower(u.chip) as chip, min(u.ord) as first_at
        from (
          select btrim(c) as chip, o as ord
            from unnest(coalesce(p_chips, '{}')) with ordinality as t(c, o)
        ) u
       where u.chip <> ''
       group by lower(u.chip)
    ) x;
$$;

create or replace function projects.set_project_classification(
  p_project_id uuid,
  p_type       text,
  p_technology text[],
  p_tags       text[]
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_type  text := nullif(btrim(coalesce(p_type, '')), '');
  v_tech  text[] := projects.normalise_chips(p_technology);
  v_tags  text[] := projects.normalise_chips(p_tags);
  v_proj  projects.projects;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_proj from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null for update;
  if v_proj.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_type is not null and v_type not in ('Website', 'Web app', 'Mobile app', 'SaaS', 'E-commerce', 'Branding', 'Other') then
    return query select 'invalid_type'::text; return;
  end if;
  if cardinality(v_tech) > 12 then
    return query select 'too_many_technology'::text; return;
  end if;
  if cardinality(v_tags) > 10 then
    return query select 'too_many_tags'::text; return;
  end if;
  if exists (select 1 from unnest(v_tech || v_tags) as c where char_length(c) > 30) then
    return query select 'chip_too_long'::text; return;
  end if;

  update projects.projects set project_type = v_type, technology = v_tech, tags = v_tags where id = p_project_id;

  perform core.record_audit(
    v_org, 'project.classification_set', 'project', p_project_id,
    jsonb_build_object('type', v_proj.project_type, 'technology', v_proj.technology, 'tags', v_proj.tags),
    jsonb_build_object('type', v_type, 'technology', v_tech, 'tags', v_tags, 'projectId', p_project_id)
  );
  return query select 'set'::text;
end;
$$;

comment on function projects.set_project_classification(uuid, text, text[], text[]) is
  'Sets a project''s type (fixed list, or null), technology chips (≤12) and tags (≤10): lower-cased, trimmed, de-duplicated, each ≤30 characters. Any task.write role of the same organisation; audited project.classification_set.';

revoke all on function projects.normalise_chips(text[]) from public, anon;
grant execute on function projects.normalise_chips(text[]) to authenticated, service_role;
revoke all on function projects.set_project_classification(uuid, text, text[], text[]) from public, anon;
grant execute on function projects.set_project_classification(uuid, text, text[], text[]) to authenticated, service_role;
