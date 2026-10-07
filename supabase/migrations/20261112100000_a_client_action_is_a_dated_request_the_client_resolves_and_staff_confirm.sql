-- ═══════════════════════════════════════════════════════════════════════════
-- P702 §7, §12 / P708: ClientActionRequest. A thing the CLIENT must do (point a DNS record, open a store account, supply a login, send content), with a deadline.
--
--   * STAFF raise it (create_client_action_request): what, the exact instruction, and a due date in the future.
--   * the CLIENT reads its own requests (client_action_requests_for_client, a SECURITY DEFINER read that filters by the caller's client_account_id claim and
--     exposes no internal column) and RESOLVES one with a note and an optional reference (resolve_client_action_request). That is a CLAIM: the request becomes
--     'submitted', never 'confirmed'.
--   * a PERSON with delivery rights CONFIRMS the evidence (settle_client_action_request 'confirmed', with their own verification in words), sends it back
--     ('rejected', with the reason the client sees) or cancels it. Overdue is DERIVED (open and past its due date): nothing is chased or messaged from here.
--
-- Nothing is sent to the client. The request row is written only by these doors; every change is also an append-only event row.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.client_action_requested', 'Staff asked the client to do something by a date (a ClientActionRequest). Nothing was sent to the client.', true),
  ('project.client_action_submitted', 'The client said it did what was asked and gave a note and a reference. It is a CLAIM: a person confirms or sends it back.', true),
  ('project.client_action_settled', 'A person confirmed, sent back or cancelled a client action request.', true)
on conflict (type) do nothing;

create table if not exists projects.p7c_client_action_requests (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  kind              text not null check (kind in ('dns_change', 'store_account', 'account_access', 'content_supply', 'approval_input', 'other')),
  title             text not null check (length(btrim(title)) between 1 and 200 and not projects.p7_has_secret(title)),
  instructions      text not null check (length(btrim(instructions)) between 1 and 4000 and not projects.p7_has_secret(instructions)),
  due_at            timestamptz not null,
  status            text not null default 'open' check (status in ('open', 'submitted', 'confirmed', 'cancelled')),
  created_by        uuid references core.users(id) on delete set null,
  created_at        timestamptz not null default clock_timestamp(),
  updated_at        timestamptz not null default clock_timestamp(),
  -- the client's claim
  submitted_by      uuid references core.users(id) on delete set null,
  submitted_name    text,
  submitted_at      timestamptz,
  submission_note   text check (not projects.p7_has_secret(submission_note)),
  submission_ref    text check (not projects.p7_has_secret(submission_ref)),
  -- a person's answer to it (the returned note is what the CLIENT sees when a claim is sent back; the confirmation note stays internal)
  returned_note     text check (not projects.p7_has_secret(returned_note)),
  returned_at       timestamptz,
  confirmed_by      uuid references core.users(id) on delete set null,
  confirmed_at      timestamptz,
  confirmation_note text check (not projects.p7_has_secret(confirmation_note)),
  cancelled_by      uuid references core.users(id) on delete set null,
  cancelled_at      timestamptz,
  cancel_reason     text check (not projects.p7_has_secret(cancel_reason)),
  -- a submitted request is evidenced by a person's name, a time and a note; a confirmed one by a person and a verification in words; a cancelled one says why
  constraint p7c_car_submitted_is_evidenced check (status <> 'submitted' or (submitted_by is not null and submitted_at is not null and length(btrim(coalesce(submission_note, ''))) >= 10)),
  constraint p7c_car_confirmed_is_verified check ((status = 'confirmed') = (confirmed_by is not null and confirmed_at is not null and length(btrim(coalesce(confirmation_note, ''))) >= 10)),
  constraint p7c_car_cancelled_says_why check ((status = 'cancelled') = (cancelled_by is not null and cancelled_at is not null and length(btrim(coalesce(cancel_reason, ''))) >= 5))
);
comment on table projects.p7c_client_action_requests is 'A client-visible request for the client to do something by a date. The client RESOLVES it (a claim: submitted); a person with delivery rights CONFIRMS the evidence. Overdue is derived, never stored.';
-- one live request per (project, kind, title): a duplicate raise is the same request
create unique index if not exists p7c_car_one_live on projects.p7c_client_action_requests (project_id, kind, lower(btrim(title))) where status in ('open', 'submitted');
create index if not exists p7c_car_project_idx on projects.p7c_client_action_requests (project_id, status, due_at);

create table if not exists projects.p7c_client_action_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  request_id       uuid not null references projects.p7c_client_action_requests(id) on delete restrict,
  event            text not null check (event in ('raised', 'submitted', 'confirmed', 'returned', 'cancelled')),
  actor_user       uuid references core.users(id) on delete set null,
  actor_kind       text not null check (actor_kind in ('staff', 'client')),
  note             text check (not projects.p7_has_secret(note)),
  at               timestamptz not null default clock_timestamp()
);
comment on table projects.p7c_client_action_events is 'Everything that happened to a client action request. Append-only.';

select projects.p7_guard_fk('p7c_client_action_requests', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p7c_client_action_requests', 'client_account_id', 'core.client_accounts');
select projects.p7_guard_fk('p7c_client_action_events', 'request_id', 'projects.p7c_client_action_requests');
select projects.p7_harden('projects', 'p7c_client_action_requests');
select projects.p7_harden('projects', 'p7c_client_action_events');
drop trigger if exists p7c_client_action_requests_door_only on projects.p7c_client_action_requests;
create trigger p7c_client_action_requests_door_only before insert or update or delete on projects.p7c_client_action_requests for each row execute function projects.p7_door_only();
drop trigger if exists p7c_client_action_requests_updated_at on projects.p7c_client_action_requests;
create trigger p7c_client_action_requests_updated_at before update on projects.p7c_client_action_requests for each row execute function core.set_updated_at();
drop trigger if exists p7c_client_action_events_append_only on projects.p7c_client_action_events;
create trigger p7c_client_action_events_append_only before insert or update or delete on projects.p7c_client_action_events for each row execute function projects.p7_append_only();

-- a request keeps its identity: what was asked, of whom and by when never changes (only its answer does)
create or replace function projects.p7c_car_identity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.project_id is distinct from old.project_id or new.client_account_id is distinct from old.client_account_id or new.kind is distinct from old.kind
     or new.title is distinct from old.title or new.instructions is distinct from old.instructions or new.due_at is distinct from old.due_at or new.created_by is distinct from old.created_by then
    raise exception 'a client action request keeps what was asked, of whom and by when: raise a new one instead' using errcode = 'restrict_violation';
  end if;
  if old.status in ('confirmed', 'cancelled') then raise exception 'a % client action request is history' , old.status using errcode = 'restrict_violation'; end if;
  return new;
end $$;
drop trigger if exists p7c_client_action_requests_identity on projects.p7c_client_action_requests;
create trigger p7c_client_action_requests_identity before update on projects.p7c_client_action_requests for each row execute function projects.p7c_car_identity();

-- ── staff raise a request ──────────────────────────────────────────────────
create or replace function projects.create_client_action_request(p_project_id uuid, p_kind text, p_title text, p_instructions text, p_due_at timestamptz)
returns table (outcome text, request_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.projects; v_id uuid; v_title text := nullif(btrim(coalesce(p_title, '')), ''); v_ins text := nullif(btrim(coalesce(p_instructions, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind not in ('dns_change', 'store_account', 'account_access', 'content_supply', 'approval_input', 'other') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if v_title is null or length(v_title) > 200 then return query select 'bad_title'::text, null::uuid; return; end if;
  if v_ins is null or length(v_ins) > 4000 then return query select 'instructions_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(v_title) or projects.p7_has_secret(v_ins) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if p_due_at is null or p_due_at <= clock_timestamp() then return query select 'due_in_the_past'::text, null::uuid; return; end if;
  select * into v_p from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null;
  if v_p.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.phase_seven s where s.project_id = p_project_id) then return query select 'not_in_phase_seven'::text, null::uuid; return; end if;
  select r.id into v_id from projects.p7c_client_action_requests r where r.project_id = p_project_id and r.kind = p_kind and lower(btrim(r.title)) = lower(v_title) and r.status in ('open', 'submitted');
  if v_id is not null then return query select 'already_open'::text, v_id; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7c_client_action_requests (organization_id, project_id, client_account_id, kind, title, instructions, due_at, created_by)
  values (v_org, p_project_id, v_p.client_account_id, p_kind, v_title, v_ins, p_due_at, v_actor) returning id into v_id;
  insert into projects.p7c_client_action_events (organization_id, request_id, event, actor_user, actor_kind, note) values (v_org, v_id, 'raised', v_actor, 'staff', null);
  perform core.record_audit(v_org, 'client_action.requested', 'client_action_request', v_id, null, jsonb_build_object('projectId', p_project_id, 'kind', p_kind, 'dueAt', p_due_at));
  perform core.emit_event(v_org, 'project.client_action_requested', 'client_action_request', v_id, jsonb_build_object('projectId', p_project_id, 'kind', p_kind));
  return query select 'raised'::text, v_id;
end $$;
revoke all on function projects.create_client_action_request(uuid, text, text, text, timestamptz) from public, anon, service_role;
grant execute on function projects.create_client_action_request(uuid, text, text, text, timestamptz) to authenticated;

-- ── the client resolves it: a CLAIM with a note and an optional reference ──
create or replace function projects.resolve_client_action_request(p_request_id uuid, p_note text, p_reference text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_r projects.p7c_client_action_requests; v_p projects.projects; v_name text; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_client()), false) then return query select 'not_a_client'::text; return; end if;
  select * into v_r from projects.p7c_client_action_requests r where r.id = p_request_id for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  v_p := projects.p7b_portal_project(v_r.project_id);
  if v_p.id is null or v_r.client_account_id is distinct from (select core.current_client_account_id()) then return query select 'not_found'::text; return; end if;
  if projects.p7b_portal_access(v_r.project_id) <> 'open' then return query select 'portal_read_only'::text; return; end if;
  if v_note is null or length(v_note) < 10 or length(v_note) > 4000 then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(v_note) or projects.p7_has_secret(v_ref) then return query select 'contains_secret'::text; return; end if;
  if v_r.status = 'submitted' then return query select 'already_submitted'::text; return; end if;
  if v_r.status <> 'open' then return query select 'not_open'::text; return; end if;
  select coalesce(nullif(btrim(u.full_name), ''), u.email, 'portal user') into v_name from core.users u where u.id = v_actor;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7c_client_action_requests set status = 'submitted', submitted_by = v_actor, submitted_name = v_name, submitted_at = clock_timestamp(), submission_note = v_note, submission_ref = left(v_ref, 500),
         returned_note = null, returned_at = null where id = v_r.id;
  insert into projects.p7c_client_action_events (organization_id, request_id, event, actor_user, actor_kind, note) values (v_r.organization_id, v_r.id, 'submitted', v_actor, 'client', v_note);
  perform core.record_audit(v_r.organization_id, 'client_action.submitted', 'client_action_request', v_r.id, null, jsonb_build_object('projectId', v_r.project_id));
  perform core.emit_event(v_r.organization_id, 'project.client_action_submitted', 'client_action_request', v_r.id, jsonb_build_object('projectId', v_r.project_id));
  return query select 'submitted'::text;
end $$;
revoke all on function projects.resolve_client_action_request(uuid, text, text) from public, anon, service_role;
grant execute on function projects.resolve_client_action_request(uuid, text, text) to authenticated;

-- ── a person confirms the evidence, sends it back, or cancels ──────────────
create or replace function projects.settle_client_action_request(p_request_id uuid, p_decision text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.p7c_client_action_requests; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('confirmed', 'rejected', 'cancelled') then return query select 'bad_decision'::text; return; end if;
  select * into v_r from projects.p7c_client_action_requests r where r.id = p_request_id and r.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if v_r.status in ('confirmed', 'cancelled') then return query select 'already_settled'::text; return; end if;
  if projects.p7_has_secret(v_note) then return query select 'contains_secret'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  if p_decision = 'confirmed' then
    if v_r.status <> 'submitted' then return query select 'nothing_to_confirm'::text; return; end if;
    -- the client's word is not the evidence: a person checks (the record, the DNS answer, the account) and says what they checked
    if v_note is null or length(v_note) < 10 then return query select 'verification_required'::text; return; end if;
    update projects.p7c_client_action_requests set status = 'confirmed', confirmed_by = v_actor, confirmed_at = clock_timestamp(), confirmation_note = v_note where id = v_r.id;
    insert into projects.p7c_client_action_events (organization_id, request_id, event, actor_user, actor_kind, note) values (v_org, v_r.id, 'confirmed', v_actor, 'staff', v_note);
  elsif p_decision = 'rejected' then
    if v_r.status <> 'submitted' then return query select 'nothing_to_return'::text; return; end if;
    if v_note is null then return query select 'note_required'::text; return; end if;
    update projects.p7c_client_action_requests set status = 'open', returned_note = v_note, returned_at = clock_timestamp(),
           submitted_by = null, submitted_name = null, submitted_at = null, submission_note = null, submission_ref = null where id = v_r.id;
    insert into projects.p7c_client_action_events (organization_id, request_id, event, actor_user, actor_kind, note) values (v_org, v_r.id, 'returned', v_actor, 'staff', v_note);
  else
    if v_note is null or length(v_note) < 5 then return query select 'reason_required'::text; return; end if;
    update projects.p7c_client_action_requests set status = 'cancelled', cancelled_by = v_actor, cancelled_at = clock_timestamp(), cancel_reason = v_note where id = v_r.id;
    insert into projects.p7c_client_action_events (organization_id, request_id, event, actor_user, actor_kind, note) values (v_org, v_r.id, 'cancelled', v_actor, 'staff', v_note);
  end if;
  perform core.record_audit(v_org, 'client_action.' || p_decision, 'client_action_request', v_r.id, null, jsonb_build_object('projectId', v_r.project_id));
  perform core.emit_event(v_org, 'project.client_action_settled', 'client_action_request', v_r.id, jsonb_build_object('projectId', v_r.project_id, 'decision', p_decision));
  return query select p_decision::text;
end $$;
revoke all on function projects.settle_client_action_request(uuid, text, text) from public, anon, service_role;
grant execute on function projects.settle_client_action_request(uuid, text, text) to authenticated;

-- ── the client-safe read: the caller's own account, no internal column ─────
create or replace function projects.client_action_requests_for_client(p_project_id uuid)
returns table (request_id uuid, kind text, title text, instructions text, due_at timestamptz, status text, overdue boolean, submitted_at timestamptz, returned_note text, confirmed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_p projects.projects;
begin
  if not coalesce((select core.is_client()), false) then return; end if;
  v_p := projects.p7b_portal_project(p_project_id);
  if v_p.id is null or projects.p7b_portal_access(p_project_id) = 'expired' then return; end if;
  return query
    select r.id, r.kind, r.title, r.instructions, r.due_at, r.status, (r.status = 'open' and r.due_at < clock_timestamp()), r.submitted_at, r.returned_note, r.confirmed_at
      from projects.p7c_client_action_requests r
     where r.project_id = p_project_id and r.client_account_id = (select core.current_client_account_id()) and r.client_account_id = v_p.client_account_id and r.status <> 'cancelled'
     order by r.due_at, r.id;
end $$;
revoke all on function projects.client_action_requests_for_client(uuid) from public, anon, service_role;
grant execute on function projects.client_action_requests_for_client(uuid) to authenticated;

notify pgrst, 'reload schema';
