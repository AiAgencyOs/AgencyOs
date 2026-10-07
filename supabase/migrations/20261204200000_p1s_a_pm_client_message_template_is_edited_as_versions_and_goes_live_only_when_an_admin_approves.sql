-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 2 rest-gaps round 4, step 3 (traceability: docs/phase-1-3-implementation-traceability.md):
--   P2-PM-006 / P2-FLOW-026 / P2-PM-028   the PM's client messages are configurable templates, edited as versions, live only when an Admin approves
--
-- THE INFRASTRUCTURE, NOT THE WORDING. src/modules/projects/pm-messages.ts keeps every sentence it has today, and a sender uses it unless an APPROVED
-- override exists for that (organization, template, language). This migration adds no template text. What the owner's PM wording should say is the owner's
-- decision; this only gives them a controlled way to say it:
--
--   draft -> pending_review (submitted) -> approved (live)  |  rejected (kept as history, with the reason)
--   approving a new version supersedes the previous approved one; a version that has left draft is never edited or deleted.
--
-- A body is validated at draft, at submit and again at approval, against the same rules the code-written wording keeps: only the placeholders the template
-- allows (and the ones it needs), no amount, no discount, no promise, no link, no word about which model or provider is behind the PM. An agent has no
-- auth.uid() and no grant here, so an agent cannot author or approve a template; the sender only READS the approved row (service role).
-- ═══════════════════════════════════════════════════════════════════════════
insert into core.event_types (type, description, canonical) values
  ('pm_template.approved', 'An Admin approved a version of a PM client-message template; it is now the wording the PM sends.', false),
  ('pm_template.rejected', 'An Admin rejected a version of a PM client-message template.', false)
on conflict (type) do nothing;

-- the templates that exist, the placeholders each may use ({name}) and the ones it must use
create or replace function projects.p1s_pm_template_registry()
returns table (template_key text, allowed text[], required text[])
language sql immutable set search_path = '' as $$
  select * from (values
    ('welcome',                  array['agencyName', 'projectName'], array[]::text[]),
    ('billing_question',         array[]::text[],                    array[]::text[]),
    ('gst_details_request',      array[]::text[],                    array[]::text[]),
    ('payment_received',         array[]::text[],                    array[]::text[]),
    ('advance_verified',         array[]::text[],                    array[]::text[]),
    ('payment_verified',         array['invoiceNumber'],             array['invoiceNumber']),
    ('payment_needs_attention',  array['invoiceNumber'],             array['invoiceNumber']),
    ('kickoff',                  array[]::text[],                    array[]::text[]),
    ('clarification_ask',        array['question'],                  array['question']),
    ('follow_up_billing',        array[]::text[],                    array[]::text[]),
    ('follow_up_gst_details',    array[]::text[],                    array[]::text[])
  ) as t(template_key, allowed, required);
$$;

-- why a body may not be a template, or null. The same rules pm-messages.ts states in its header and isSafeClientQuestion enforces for a model's question.
create or replace function projects.p1s_pm_template_problem(p_key text, p_language text, p_body text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  r record; v_token text; v_stripped text;
begin
  select g.* into r from projects.p1s_pm_template_registry() g where g.template_key = p_key;
  if r.template_key is null then return 'unknown template "' || left(coalesce(p_key, ''), 40) || '"'; end if;
  if p_language is null or p_language not in ('en', 'hinglish', 'hindi') then return 'the language must be en, hinglish or hindi'; end if;
  if p_body is null or length(btrim(p_body)) < 8 then return 'the message is too short to be a message'; end if;
  if length(p_body) > 1500 then return 'the message is longer than 1500 characters'; end if;
  for v_token in select (regexp_matches(p_body, '\{([^{}]*)\}', 'g'))[1] loop
    if not (v_token = any (r.allowed)) then return 'the placeholder {' || left(v_token, 40) || '} is not allowed in this template'; end if;
  end loop;
  v_stripped := regexp_replace(p_body, '\{[^{}]*\}', '', 'g');
  if v_stripped ~ '[{}]' then return 'a brace is left open: placeholders are written {name}'; end if;
  foreach v_token in array r.required loop
    if position('{' || v_token || '}' in p_body) = 0 then return 'this template must use {' || v_token || '}'; end if;
  end loop;
  if v_stripped ~* '₹|[$]|\yrs\.?\s*\d|\yinr\y|\yusd\y|\d[\d,]*\s*(k\y|lakh|lac|crore|rupees?|dollars?)|%' then return 'a client message states no amount: the invoice carries it'; end if;
  if v_stripped ~* '\y(discount|free of charge|guarantee[ds]?|we promise|deadline)\y' then return 'a client message makes no promise, discount or deadline'; end if;
  if v_stripped ~* 'https?://|```' then return 'a client message carries no link'; end if;
  if v_stripped ~* '\y(openai|anthropic|claude|chatgpt|gpt-?[0-9]|gemini|openrouter|llama|mistral)\y' then return 'a client message says nothing about which model or provider is behind it'; end if;
  return null;
end $$;

create table if not exists projects.p1s_pm_template_versions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  template_key    text not null check (template_key in ('welcome', 'billing_question', 'gst_details_request', 'payment_received', 'advance_verified', 'payment_verified', 'payment_needs_attention', 'kickoff', 'clarification_ask', 'follow_up_billing', 'follow_up_gst_details')),
  language        text not null check (language in ('en', 'hinglish', 'hindi')),
  version         integer not null check (version > 0),
  status          text not null default 'draft' check (status in ('draft', 'pending_review', 'approved', 'rejected', 'superseded')),
  body            text not null check (length(btrim(body)) between 8 and 1500),
  created_by      uuid not null references core.users(id) on delete restrict,
  created_at      timestamptz not null default clock_timestamp(),
  submitted_by    uuid references core.users(id) on delete restrict,
  submitted_at    timestamptz,
  decided_by      uuid references core.users(id) on delete restrict,
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or length(btrim(decision_note)) between 1 and 500),
  superseded_at   timestamptz,
  unique (organization_id, template_key, language, version),
  constraint p1s_pm_template_submitted_says_who check (status = 'draft' or (submitted_by is not null and submitted_at is not null)),
  constraint p1s_pm_template_decided_says_who check (status not in ('approved', 'rejected', 'superseded') or (decided_by is not null and decided_at is not null)),
  constraint p1s_pm_template_rejected_says_why check (status <> 'rejected' or decision_note is not null)
);
comment on table projects.p1s_pm_template_versions is
  'P2-PM-006. An owner-edited override of one PM client message (template, language), as versions. Only an APPROVED row is ever sent; with none, the wording in pm-messages.ts is. After leaving draft a row''s key, language, version and body never change and it is never deleted. Written only through the projects.p1s_* doors.';
create unique index if not exists p1s_pm_template_one_approved on projects.p1s_pm_template_versions (organization_id, template_key, language) where status = 'approved';
create unique index if not exists p1s_pm_template_one_open on projects.p1s_pm_template_versions (organization_id, template_key, language) where status in ('draft', 'pending_review');
create index if not exists p1s_pm_template_history_idx on projects.p1s_pm_template_versions (organization_id, template_key, language, version desc);

drop trigger if exists freeze_org_p1s_pm_template_versions on projects.p1s_pm_template_versions;
create trigger freeze_org_p1s_pm_template_versions before update of organization_id on projects.p1s_pm_template_versions
  for each row execute function core.freeze_organization_id();

create or replace function projects.p1s_pm_template_versions_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if;
    raise exception 'a template version that left draft is history and is never deleted' using errcode = 'restrict_violation';
  end if;
  if old.status <> 'draft' and (new.template_key is distinct from old.template_key or new.language is distinct from old.language or new.version is distinct from old.version
     or new.body is distinct from old.body or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at) then
    raise exception 'a template version is immutable once submitted' using errcode = 'restrict_violation';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status = 'pending_review')
    or (old.status = 'pending_review' and new.status in ('approved', 'rejected', 'draft'))
    or (old.status = 'approved' and new.status = 'superseded')) then
    raise exception 'a template version cannot move from % to %', old.status, new.status using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p1s_pm_template_versions_guard on projects.p1s_pm_template_versions;
create trigger p1s_pm_template_versions_guard before update or delete on projects.p1s_pm_template_versions for each row execute function projects.p1s_pm_template_versions_guard();

alter table projects.p1s_pm_template_versions enable row level security;
alter table projects.p1s_pm_template_versions force row level security;
drop policy if exists p1s_pm_template_versions_read on projects.p1s_pm_template_versions;
create policy p1s_pm_template_versions_read on projects.p1s_pm_template_versions for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.p1s_pm_template_versions from public, anon, authenticated;
grant select on projects.p1s_pm_template_versions to authenticated;
grant all on projects.p1s_pm_template_versions to service_role;

-- ── the doors ───────────────────────────────────────────────────────────────
-- save or replace the one open draft of (template, language); a version that is awaiting review is not edited under the reviewer
create or replace function projects.p1s_save_pm_template_draft(p_key text, p_language text, p_body text)
returns table (outcome text, template_id uuid, version integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_open projects.p1s_pm_template_versions; v_next integer; v_id uuid; v_problem text; v_body text := btrim(coalesce(p_body, ''));
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid, null::integer; return; end if;
  if v_org is null or not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid, null::integer; return; end if;
  v_problem := projects.p1s_pm_template_problem(p_key, p_language, v_body);
  if v_problem is not null then return query select ('invalid_body: ' || v_problem)::text, null::uuid, null::integer; return; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':pmtpl:' || p_key || ':' || p_language, 13));
  select o.* into v_open from projects.p1s_pm_template_versions o
   where o.organization_id = v_org and o.template_key = p_key and o.language = p_language and o.status in ('draft', 'pending_review') for update;
  if v_open.id is not null and v_open.status = 'pending_review' then return query select 'under_review'::text, v_open.id, v_open.version; return; end if;
  if v_open.id is not null then
    update projects.p1s_pm_template_versions set body = v_body where id = v_open.id;
    v_id := v_open.id; v_next := v_open.version;
  else
    select coalesce(max(x.version), 0) + 1 into v_next from projects.p1s_pm_template_versions x where x.organization_id = v_org and x.template_key = p_key and x.language = p_language;
    insert into projects.p1s_pm_template_versions (organization_id, template_key, language, version, status, body, created_by)
      values (v_org, p_key, p_language, v_next, 'draft', v_body, v_actor) returning id into v_id;
  end if;
  perform core.record_audit(v_org, 'pm_template.draft_saved', 'pm_template', v_id, null, jsonb_build_object('template', p_key, 'language', p_language, 'version', v_next));
  return query select 'saved'::text, v_id, v_next;
end $$;
revoke all on function projects.p1s_save_pm_template_draft(text, text, text) from public, anon;
grant execute on function projects.p1s_save_pm_template_draft(text, text, text) to authenticated;

create or replace function projects.p1s_discard_pm_template_draft(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_row projects.p1s_pm_template_versions;
begin
  if v_actor is null then return 'no_actor'; end if;
  select r.* into v_row from projects.p1s_pm_template_versions r where r.id = p_id and r.organization_id = v_org for update;
  if v_row.id is null then return 'not_found'; end if;
  if not (coalesce((select core.is_admin()), false) or v_row.created_by = v_actor) then return 'not_authorized'; end if;
  if v_row.status <> 'draft' then return 'not_a_draft'; end if;
  delete from projects.p1s_pm_template_versions where id = v_row.id;
  perform core.record_audit(v_org, 'pm_template.draft_discarded', 'pm_template', v_row.id, jsonb_build_object('template', v_row.template_key, 'language', v_row.language, 'version', v_row.version), null);
  return 'discarded';
end $$;
revoke all on function projects.p1s_discard_pm_template_draft(uuid) from public, anon;
grant execute on function projects.p1s_discard_pm_template_draft(uuid) to authenticated;

create or replace function projects.p1s_submit_pm_template(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_row projects.p1s_pm_template_versions; v_problem text;
begin
  if v_actor is null then return 'no_actor'; end if;
  if v_org is null or not coalesce((select core.can_write()), false) then return 'not_authorized'; end if;
  select r.* into v_row from projects.p1s_pm_template_versions r where r.id = p_id and r.organization_id = v_org for update;
  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'draft' then return 'not_a_draft'; end if;
  v_problem := projects.p1s_pm_template_problem(v_row.template_key, v_row.language, v_row.body);
  if v_problem is not null then return 'invalid_body: ' || v_problem; end if;
  update projects.p1s_pm_template_versions set status = 'pending_review', submitted_by = v_actor, submitted_at = clock_timestamp() where id = v_row.id;
  perform core.record_audit(v_org, 'pm_template.submitted', 'pm_template', v_row.id, null, jsonb_build_object('template', v_row.template_key, 'language', v_row.language, 'version', v_row.version));
  return 'submitted';
end $$;
revoke all on function projects.p1s_submit_pm_template(uuid) from public, anon;
grant execute on function projects.p1s_submit_pm_template(uuid) to authenticated;

-- an Admin approves (it becomes the wording the PM sends, superseding the previous approved version) or rejects (with a reason)
create or replace function projects.p1s_decide_pm_template(p_id uuid, p_decision text, p_note text default null)
returns table (outcome text, superseded_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_now timestamptz := clock_timestamp();
  v_row projects.p1s_pm_template_versions; v_old projects.p1s_pm_template_versions; v_problem text; v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if v_org is null or not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_decision not in ('approve', 'reject') then return query select 'invalid_decision'::text, null::uuid; return; end if;
  if p_decision = 'reject' and v_note is null then return query select 'reason_required'::text, null::uuid; return; end if;
  select r.* into v_row from projects.p1s_pm_template_versions r where r.id = p_id and r.organization_id = v_org for update;
  if v_row.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_row.status <> 'pending_review' then return query select 'not_pending'::text, null::uuid; return; end if;
  if p_decision = 'reject' then
    update projects.p1s_pm_template_versions set status = 'rejected', decided_by = v_actor, decided_at = v_now, decision_note = v_note where id = v_row.id;
    perform core.record_audit(v_org, 'pm_template.rejected', 'pm_template', v_row.id, null, jsonb_build_object('template', v_row.template_key, 'language', v_row.language, 'version', v_row.version, 'note', v_note));
    perform core.emit_event(v_org, 'pm_template.rejected', 'pm_template', v_row.id, jsonb_build_object('template', v_row.template_key, 'language', v_row.language));
    return query select 'rejected'::text, null::uuid; return;
  end if;
  -- the body is re-validated at approval: a draft written under an older rule does not slip through
  v_problem := projects.p1s_pm_template_problem(v_row.template_key, v_row.language, v_row.body);
  if v_problem is not null then return query select ('invalid_body: ' || v_problem)::text, null::uuid; return; end if;
  select o.* into v_old from projects.p1s_pm_template_versions o
   where o.organization_id = v_org and o.template_key = v_row.template_key and o.language = v_row.language and o.status = 'approved' for update;
  if v_old.id is not null then
    update projects.p1s_pm_template_versions set status = 'superseded', superseded_at = v_now where id = v_old.id;
  end if;
  update projects.p1s_pm_template_versions set status = 'approved', decided_by = v_actor, decided_at = v_now, decision_note = v_note where id = v_row.id;
  perform core.record_audit(v_org, 'pm_template.approved', 'pm_template', v_row.id,
    case when v_old.id is null then null else jsonb_build_object('version', v_old.version) end,
    jsonb_build_object('template', v_row.template_key, 'language', v_row.language, 'version', v_row.version, 'note', v_note));
  perform core.emit_event(v_org, 'pm_template.approved', 'pm_template', v_row.id, jsonb_build_object('template', v_row.template_key, 'language', v_row.language, 'version', v_row.version));
  return query select 'approved'::text, v_old.id;
end $$;
revoke all on function projects.p1s_decide_pm_template(uuid, text, text) from public, anon;
grant execute on function projects.p1s_decide_pm_template(uuid, text, text) to authenticated;

-- A reviewer can stop reading and give it back: pending_review -> draft (the author, or an Admin)
create or replace function projects.p1s_withdraw_pm_template(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_row projects.p1s_pm_template_versions;
begin
  if v_actor is null then return 'no_actor'; end if;
  select r.* into v_row from projects.p1s_pm_template_versions r where r.id = p_id and r.organization_id = v_org for update;
  if v_row.id is null then return 'not_found'; end if;
  if not (coalesce((select core.is_admin()), false) or v_row.created_by = v_actor) then return 'not_authorized'; end if;
  if v_row.status <> 'pending_review' then return 'not_pending'; end if;
  update projects.p1s_pm_template_versions set status = 'draft', submitted_by = null, submitted_at = null where id = v_row.id;
  perform core.record_audit(v_org, 'pm_template.withdrawn', 'pm_template', v_row.id, null, jsonb_build_object('template', v_row.template_key, 'language', v_row.language, 'version', v_row.version));
  return 'withdrawn';
end $$;
revoke all on function projects.p1s_withdraw_pm_template(uuid) from public, anon;
grant execute on function projects.p1s_withdraw_pm_template(uuid) to authenticated;

-- ── what the sender reads: the approved body for (organization, template, language), or nothing ──
create or replace function projects.p1s_pm_template_approved(p_organization_id uuid, p_key text, p_language text)
returns table (template_id uuid, version integer, body text)
language sql stable security definer set search_path = '' as $$
  select v.id, v.version, v.body from projects.p1s_pm_template_versions v
   where v.organization_id = p_organization_id and v.template_key = p_key and v.language = p_language and v.status = 'approved';
$$;
revoke all on function projects.p1s_pm_template_approved(uuid, text, text) from public, anon, authenticated;
grant execute on function projects.p1s_pm_template_approved(uuid, text, text) to service_role;
