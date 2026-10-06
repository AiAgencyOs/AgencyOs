-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 (part B), the gates and the doors of post-launch maintenance work (tables: 20261105500000).
--
--   projects.maintenance_work_items_guard   identity and state are guarded IN the table: a service-role write is held to the same rules as a person
--   projects.evaluate_maintenance_gates     ten gates read from rows: the authorization is still valid, a paid change is paid on VERIFIED money, one exact
--                                           commit, targeted + regression (+ security when sensitive) QA by someone other than the author on THAT commit,
--                                           the linked Phase 6 defect VERIFIED by an independent retest, no other unresolved S0/S1, a rollback plan, the Admin
--   open / submit / record QA / request release / decide release / record release / cancel   the doors a person uses
--
-- A fix after launch re-enters QA before it is released: a new commit invalidates every earlier result and withdraws a pending release request.
-- A failing QA result opens a Phase 6 qa.defects row on the exact commit and returns the change to the developer.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.maintenance_work_items_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'maintenance work is never deleted: cancel it, with a reason' using errcode = 'restrict_violation'; end if;
  if new.project_id is distinct from old.project_id or new.client_account_id is distinct from old.client_account_id or new.kind is distinct from old.kind
     or new.ticket_id is distinct from old.ticket_id or new.defect_id is distinct from old.defect_id or new.change_request_id is distinct from old.change_request_id
     or new.emergency is distinct from old.emergency or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'a maintenance work item''s project, kind, authorization and emergency flag are fixed: raise a new item' using errcode = 'restrict_violation';
  end if;
  if old.status in ('released', 'cancelled') then
    raise exception 'a % maintenance work item is closed history', old.status using errcode = 'restrict_violation';
  end if;
  if (new.status is distinct from old.status or new.commit_ref is distinct from old.commit_ref or new.approved_commit is distinct from old.approved_commit
      or new.release_approved_by is distinct from old.release_approved_by or new.released_at is distinct from old.released_at)
     and coalesce(current_setting('projects.maintenance_sanctioned', true), '') <> 'on' then
    raise exception 'maintenance work moves through its doors (submit, QA, release review), never by an edit' using errcode = 'restrict_violation';
  end if;
  -- an approved release is of one exact commit: it does not change under the approval
  if old.status = 'release_approved' and new.commit_ref is distinct from old.commit_ref then
    raise exception 'the commit of an approved release is frozen: raise a new work item for different code' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists maintenance_work_items_guard on projects.maintenance_work_items;
create trigger maintenance_work_items_guard before update or delete on projects.maintenance_work_items for each row execute function projects.maintenance_work_items_guard();
drop trigger if exists maintenance_work_items_updated_at on projects.maintenance_work_items;
create trigger maintenance_work_items_updated_at before update on projects.maintenance_work_items for each row execute function core.set_updated_at();

insert into core.event_types (type, description, canonical) values
  ('project.maintenance_work_opened', 'Post-launch maintenance work was opened, tied to a defect, a covered ticket or an approved change request.', true),
  ('project.maintenance_qa_failed', 'Independent post-launch QA failed a maintenance change on its exact commit; it returns to the developer and a defect is recorded.', true),
  ('project.maintenance_release_requested', 'A maintenance change passed QA and awaits its own Admin release approval.', true),
  ('project.maintenance_release_approved', 'An Admin approved the exact commit of a maintenance change for release. AgencyOS deploys nothing.', true),
  ('project.maintenance_released', 'A person recorded that a maintenance change was released, with a deployment reference and smoke evidence.', true)
on conflict (type) do nothing;

-- ── the gates, read from rows ─────────────────────────────────────────────
create or replace function projects.evaluate_maintenance_gates(p_work_item_id uuid)
returns table (gate text, passed boolean, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_i projects.maintenance_work_items; v_cr projects.change_requests; v_d qa.defects; v_t projects.maintenance_items; v_inv finance.invoices;
  g text; v_ok boolean; v_det text; v_n int; v_res record; v_cat text;
begin
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id;
  if v_i.id is null then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and v_i.organization_id is distinct from (select core.current_organization_id()) then return; end if;
  if v_i.change_request_id is not null then select * into v_cr from projects.change_requests c where c.id = v_i.change_request_id; end if;
  if v_i.defect_id is not null then select * into v_d from qa.defects x where x.id = v_i.defect_id; end if;
  if v_i.ticket_id is not null then select * into v_t from projects.maintenance_items m where m.id = v_i.ticket_id; end if;

  for g in select unnest(array['bound_record', 'scope_authorized', 'exact_commit', 'targeted_qa', 'regression_qa', 'security_qa', 'defect_verified', 'no_other_s0_s1', 'rollback', 'admin_approval']) loop
    v_ok := false; v_det := '';
    if g = 'bound_record' then
      v_ok := (v_i.defect_id is null or (v_d.id is not null and v_d.classification = 'product_defect' and v_d.status <> 'wontfix'))
          and (v_i.change_request_id is null or (v_cr.id is not null and v_cr.status in ('approved', 'implemented') and v_cr.classification in ('in_scope', 'free_change', 'paid_change')))
          and (v_i.ticket_id is null or (v_t.id is not null and v_t.coverage in ('warranty', 'maintenance')));
      v_det := case when v_ok then 'the defect, covered ticket or approved change request this work answers to is still valid' else 'the defect, ticket or change request that authorizes this work is no longer valid (closed, declined, reclassified or not approved)' end;
    elsif g = 'scope_authorized' then
      -- a PAID change is paid for before it is built: its invoice is paid on verified money
      if v_cr.id is not null and v_cr.classification = 'paid_change' then
        select * into v_inv from finance.invoices i where i.id = v_cr.invoice_id;
        v_ok := v_inv.id is not null and v_inv.status = 'paid' and v_inv.total_minor > 0 and finance.net_verified_minor(v_inv.id) >= v_inv.total_minor;
        v_det := case when v_ok then 'the paid change''s invoice is paid on verified money' else 'the paid change request has no invoice that is paid and verified' end;
      else v_ok := true; v_det := 'no payment is needed for this authorization'; end if;
    elsif g = 'exact_commit' then
      v_ok := v_i.commit_ref is not null;
      v_det := case when v_ok then 'the work is one exact commit: ' || v_i.commit_ref else 'no commit has been submitted' end;
    elsif g in ('targeted_qa', 'regression_qa', 'security_qa') then
      v_cat := case g when 'targeted_qa' then 'targeted' when 'regression_qa' then 'regression' else 'security' end;
      if g = 'security_qa' and not v_i.sensitive then
        v_ok := true; v_det := 'the author did not mark the change security-sensitive';
      else
        select r.status, r.recorded_by into v_res from projects.maintenance_qa_results r
         where r.work_item_id = v_i.id and r.category = v_cat and r.commit_ref = v_i.commit_ref order by r.recorded_at desc, r.id desc limit 1;
        v_ok := v_res.status = 'pass' and v_res.recorded_by is distinct from v_i.commit_submitted_by;
        v_det := case when v_res.status is null then v_cat || ' QA has no result on this exact commit (unknown is not a pass)'
                      when v_res.status <> 'pass' then v_cat || ' QA is ' || v_res.status || ' on this commit'
                      when v_ok then v_cat || ' QA passed on this exact commit, independently'
                      else v_cat || ' QA was recorded by the person who submitted the commit' end;
      end if;
    elsif g = 'defect_verified' then
      if v_d.id is null then v_ok := true; v_det := 'no defect is linked';
      else
        v_ok := v_d.status = 'verified' and (v_d.retest_commit is null or v_d.retest_commit = v_i.commit_ref);
        v_det := case when v_ok then 'the linked defect was verified by an independent retest' when v_d.status = 'verified' then 'the defect was retested on a different commit' else 'the linked defect is ' || v_d.status || ', not verified' end;
      end if;
    elsif g = 'no_other_s0_s1' then
      select count(*) into v_n from qa.unresolved_product_defects(v_i.project_id) u where u.s_level <= 1 and u.defect_id is distinct from v_i.defect_id;
      v_ok := v_n = 0;
      v_det := case when v_ok then 'no other unresolved S0/S1 product defect on the project' else v_n || ' other unresolved S0/S1 product defect(s)' end;
    elsif g = 'rollback' then
      v_ok := length(btrim(coalesce(v_i.rollback_plan, ''))) > 0 and length(btrim(coalesce(v_i.rollback_owner, ''))) > 0;
      v_det := case when v_ok then 'a rollback plan with an owner is recorded' else 'no rollback plan and owner' end;
    elsif g = 'admin_approval' then
      v_ok := v_i.status in ('release_approved', 'released') and v_i.approved_commit = v_i.commit_ref;
      v_det := case when v_ok then 'an Admin approved this exact commit' else 'awaiting an Admin''s approval of this exact commit' end;
    end if;
    return query select g, v_ok, v_det;
  end loop;
end $$;
revoke all on function projects.evaluate_maintenance_gates(uuid) from public, anon;
grant execute on function projects.evaluate_maintenance_gates(uuid) to authenticated, service_role;

-- ── open ──────────────────────────────────────────────────────────────────
create or replace function projects.open_maintenance_work(
  p_project_id uuid, p_kind text, p_area text, p_title text, p_description text default null,
  p_ticket_id uuid default null, p_defect_id uuid default null, p_change_request_id uuid default null,
  p_emergency boolean default false, p_sensitive boolean default false)
returns table (outcome text, work_item_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_p projects.projects; v_t projects.maintenance_items; v_d qa.defects; v_cr projects.change_requests; v_inv finance.invoices; v_new uuid; v_existing uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind not in ('hotfix', 'patch', 'enhancement') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_area not in ('frontend', 'backend', 'database', 'mobile', 'integration', 'devops', 'dependency') then return query select 'bad_area'::text, null::uuid; return; end if;
  if p_title is null or length(btrim(p_title)) = 0 or length(p_title) > 300 then return query select 'title_required'::text, null::uuid; return; end if;
  select * into v_p from projects.projects p where p.id = p_project_id and p.organization_id = v_org;
  if v_p.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  -- POST-launch: there is a delivered handover to come after (the same rule maintenance tickets live under)
  if not exists (select 1 from projects.handovers h where h.project_id = p_project_id and h.status in ('delivered', 'accepted')) then return query select 'no_handover'::text, null::uuid; return; end if;
  -- never free scope: something authorizes the work, and an enhancement is a change request
  if p_ticket_id is null and p_defect_id is null and p_change_request_id is null then return query select 'unauthorized_work'::text, null::uuid; return; end if;
  if p_kind = 'enhancement' and p_change_request_id is null then return query select 'enhancement_needs_a_change_request'::text, null::uuid; return; end if;
  if p_emergency then
    if p_kind <> 'hotfix' then return query select 'emergency_is_a_hotfix'::text, null::uuid; return; end if;
    if not coalesce((select core.is_admin()), false) then return query select 'emergency_needs_an_admin'::text, null::uuid; return; end if;
  end if;

  if p_ticket_id is not null then
    select * into v_t from projects.maintenance_items m where m.id = p_ticket_id and m.organization_id = v_org and m.project_id = p_project_id;
    if v_t.id is null then return query select 'ticket_not_found'::text, null::uuid; return; end if;
    if v_t.coverage is null then return query select 'ticket_unclassified'::text, null::uuid; return; end if;
    -- a new feature filed as maintenance is how scope escapes approval (Doc 18 section 35)
    if v_t.coverage not in ('warranty', 'maintenance') then return query select 'out_of_scope_needs_a_change_request'::text, null::uuid; return; end if;
    if v_t.status in ('resolved', 'declined') then return query select 'ticket_closed'::text, null::uuid; return; end if;
  end if;
  if p_defect_id is not null then
    select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org and d.project_id = p_project_id;
    if v_d.id is null then return query select 'defect_not_found'::text, null::uuid; return; end if;
    if v_d.classification <> 'product_defect' then return query select 'not_a_product_defect'::text, null::uuid; return; end if;
    if v_d.status in ('verified', 'wontfix') then return query select 'defect_closed'::text, null::uuid; return; end if;
  end if;
  if p_change_request_id is not null then
    select * into v_cr from projects.change_requests c where c.id = p_change_request_id and c.organization_id = v_org and c.project_id = p_project_id;
    if v_cr.id is null then return query select 'change_request_not_found'::text, null::uuid; return; end if;
    if v_cr.classification = 'new_project' then return query select 'new_project_is_not_maintenance'::text, null::uuid; return; end if;
    if v_cr.status <> 'approved' or v_cr.classification not in ('in_scope', 'free_change', 'paid_change') then return query select 'change_request_not_approved'::text, null::uuid; return; end if;
    if v_cr.classification = 'paid_change' then
      select * into v_inv from finance.invoices i where i.id = v_cr.invoice_id;
      if v_inv.id is null or v_inv.status <> 'paid' or v_inv.total_minor <= 0 or finance.net_verified_minor(v_inv.id) < v_inv.total_minor then
        return query select 'change_request_unpaid'::text, null::uuid; return;
      end if;
    end if;
  end if;

  select w.id into v_existing from projects.maintenance_work_items w
   where w.status not in ('released', 'cancelled')
     and ((p_defect_id is not null and w.defect_id = p_defect_id) or (p_change_request_id is not null and w.change_request_id = p_change_request_id) or (p_ticket_id is not null and w.ticket_id = p_ticket_id)) limit 1;
  if v_existing is not null then return query select 'already_open'::text, v_existing; return; end if;

  insert into projects.maintenance_work_items (organization_id, client_account_id, project_id, kind, area, title, description, ticket_id, defect_id, change_request_id, emergency, emergency_authorized_by, emergency_authorized_at, sensitive, created_by)
  values (v_org, v_p.client_account_id, p_project_id, p_kind, p_area, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_ticket_id, p_defect_id, p_change_request_id, coalesce(p_emergency, false),
          case when p_emergency then v_actor end, case when p_emergency then now() end, coalesce(p_sensitive, false), v_actor)
  returning id into v_new;
  perform core.record_audit(v_org, 'maintenance_work.opened', 'maintenance_work_item', v_new, null, jsonb_build_object('projectId', p_project_id, 'kind', p_kind, 'emergency', p_emergency, 'ticketId', p_ticket_id, 'defectId', p_defect_id, 'changeRequestId', p_change_request_id));
  perform core.emit_event(v_org, 'project.maintenance_work_opened', 'maintenance_work_item', v_new, jsonb_build_object('projectId', p_project_id, 'kind', p_kind, 'emergency', coalesce(p_emergency, false)));
  return query select 'opened'::text, v_new;
end $$;
revoke all on function projects.open_maintenance_work(uuid, text, text, text, text, uuid, uuid, uuid, boolean, boolean) from public, anon;
grant execute on function projects.open_maintenance_work(uuid, text, text, text, text, uuid, uuid, uuid, boolean, boolean) to authenticated;

-- ── submit the exact commit ───────────────────────────────────────────────
create or replace function projects.submit_maintenance_fix(p_work_item_id uuid, p_commit_ref text, p_summary text, p_rollback_plan text, p_rollback_owner text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.maintenance_work_items; v_text text;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text; return; end if;
  if v_i.status in ('release_approved', 'released', 'cancelled') then return query select 'commit_frozen'::text; return; end if;
  if p_commit_ref is null or p_commit_ref !~ '^[0-9a-f]{40}$' then return query select 'exact_commit_required'::text; return; end if;
  if p_summary is null or length(btrim(p_summary)) = 0 or length(p_summary) > 4000 then return query select 'summary_required'::text; return; end if;
  if length(btrim(coalesce(p_rollback_plan, ''))) = 0 or length(btrim(coalesce(p_rollback_owner, ''))) = 0 then return query select 'rollback_required'::text; return; end if;
  v_text := p_summary || E'\n' || p_rollback_plan || E'\n' || p_rollback_owner;
  if v_text ~* '(api[_-]?key|secret|token|passwd|password|authorization|bearer)["'' ]*[:=]\s*["'']?[A-Za-z0-9_\-.]{12,}' or v_text ~ '(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})' then
    return query select 'secret_in_text'::text; return;
  end if;
  if v_i.commit_ref = p_commit_ref then return query select 'same_commit'::text; return; end if;
  if exists (select 1 from projects.maintenance_work_commits c where c.work_item_id = v_i.id and c.commit_ref = p_commit_ref) then return query select 'commit_already_superseded'::text; return; end if;

  -- a pending release request was about the OLD commit: it is withdrawn, not carried over
  if v_i.status = 'release_review' then
    insert into projects.maintenance_release_decisions (organization_id, work_item_id, decision, commit_ref, note, decided_by)
    values (v_org, v_i.id, 'withdrawn', v_i.commit_ref, 'a new commit was submitted', v_actor);
  end if;
  insert into projects.maintenance_work_commits (organization_id, work_item_id, commit_ref, summary, submitted_by) values (v_org, v_i.id, p_commit_ref, btrim(p_summary), v_actor);
  perform set_config('projects.maintenance_sanctioned', 'on', true);
  update projects.maintenance_work_items set commit_ref = p_commit_ref, commit_submitted_by = v_actor, commit_submitted_at = now(), fix_summary = btrim(p_summary),
         rollback_plan = btrim(p_rollback_plan), rollback_owner = btrim(p_rollback_owner), release_requested_by = null, release_requested_commit = null, status = 'fix_submitted'
   where id = v_i.id;
  perform core.record_audit(v_org, 'maintenance_work.commit_submitted', 'maintenance_work_item', v_i.id, jsonb_build_object('commit', v_i.commit_ref), jsonb_build_object('commit', p_commit_ref));
  return query select 'submitted'::text;
end $$;
revoke all on function projects.submit_maintenance_fix(uuid, text, text, text, text) from public, anon;
grant execute on function projects.submit_maintenance_fix(uuid, text, text, text, text) to authenticated;

-- ── an independent QA result on that exact commit ─────────────────────────
create or replace function projects.record_maintenance_qa_result(p_work_item_id uuid, p_category text, p_status text, p_commit_ref text, p_evidence_ref text default null, p_reason text default null, p_severity text default 'major')
returns table (outcome text, defect_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.maintenance_work_items; v_def uuid; v_open int;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_category not in ('targeted', 'regression', 'security') then return query select 'bad_category'::text, null::uuid; return; end if;
  if p_status not in ('pass', 'fail', 'blocked') then return query select 'bad_status'::text, null::uuid; return; end if;
  if p_severity not in ('blocker', 'major', 'minor') then return query select 'bad_severity'::text, null::uuid; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_i.status in ('open', 'cancelled', 'released', 'release_approved') then return query select 'not_in_qa'::text, null::uuid; return; end if;
  -- the evidence is about the commit under test; evidence for any other commit is not evidence about this one
  if p_commit_ref is distinct from v_i.commit_ref then return query select 'stale_commit'::text, null::uuid; return; end if;
  -- QA is independent: the person who submitted the commit does not verify it ("developer self-report is not QA evidence")
  if v_actor = v_i.commit_submitted_by then return query select 'self_review'::text, null::uuid; return; end if;
  if p_status = 'pass' and length(btrim(coalesce(p_evidence_ref, ''))) = 0 then return query select 'evidence_required'::text, null::uuid; return; end if;
  if p_status <> 'pass' and length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'reason_required'::text, null::uuid; return; end if;
  if p_category = 'security' and not v_i.sensitive then return query select 'security_not_required'::text, null::uuid; return; end if;

  if p_status = 'fail' then
    -- a failing result opens a Phase 6 QA defect against the exact commit and returns the change to the developer
    insert into qa.defects (organization_id, project_id, severity, title, reproduction, expected, actual, reported_by, found_commit, phase6)
    values (v_org, v_i.project_id, p_severity, left('Post-launch ' || p_category || ' QA failed: ' || v_i.title, 200), btrim(p_reason), 'the change passes ' || p_category || ' QA', btrim(p_reason), v_actor, v_i.commit_ref, false)
    returning id into v_def;
  end if;
  insert into projects.maintenance_qa_results (organization_id, work_item_id, category, status, commit_ref, evidence_ref, reason, defect_id, recorded_by)
  values (v_org, v_i.id, p_category, p_status, v_i.commit_ref, nullif(btrim(coalesce(p_evidence_ref, '')), ''), nullif(btrim(coalesce(p_reason, '')), ''), v_def, v_actor);

  perform set_config('projects.maintenance_sanctioned', 'on', true);
  if p_status <> 'pass' then
    if v_i.status = 'release_review' then
      insert into projects.maintenance_release_decisions (organization_id, work_item_id, decision, commit_ref, note, decided_by) values (v_org, v_i.id, 'withdrawn', v_i.commit_ref, 'QA ' || p_status || ' on this commit', v_actor);
    end if;
    update projects.maintenance_work_items set status = 'changes_requested', release_requested_by = null, release_requested_commit = null where id = v_i.id;
    if p_status = 'fail' then perform core.emit_event(v_org, 'project.maintenance_qa_failed', 'maintenance_work_item', v_i.id, jsonb_build_object('projectId', v_i.project_id, 'category', p_category)); end if;
    perform core.record_audit(v_org, 'maintenance_work.qa_' || p_status, 'maintenance_work_item', v_i.id, null, jsonb_build_object('category', p_category, 'commit', v_i.commit_ref, 'defectId', v_def));
    return query select 'recorded'::text, v_def; return;
  end if;
  -- a pass moves the item to qa_passed only when EVERY QA gate now holds on this commit (the Admin's approval is the last gate and is not one of them)
  select count(*) into v_open from projects.evaluate_maintenance_gates(v_i.id) g where g.gate in ('targeted_qa', 'regression_qa', 'security_qa') and not g.passed;
  if v_open = 0 and v_i.status in ('fix_submitted', 'changes_requested') then
    update projects.maintenance_work_items set status = 'qa_passed' where id = v_i.id;
  end if;
  perform core.record_audit(v_org, 'maintenance_work.qa_pass', 'maintenance_work_item', v_i.id, null, jsonb_build_object('category', p_category, 'commit', v_i.commit_ref));
  return query select 'recorded'::text, null::uuid;
end $$;
revoke all on function projects.record_maintenance_qa_result(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function projects.record_maintenance_qa_result(uuid, text, text, text, text, text, text) to authenticated;

-- ── the release needs its own Admin approval ──────────────────────────────
create or replace function projects.request_maintenance_release(p_work_item_id uuid)
returns table (outcome text, open_gates text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.maintenance_work_items; v_open text;
begin
  if v_actor is null then return query select 'no_actor'::text, null::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::text; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v_i.status = 'release_review' then return query select 'already_requested'::text, null::text; return; end if;
  if v_i.status <> 'qa_passed' then return query select 'wrong_state'::text, null::text; return; end if;
  select string_agg(g.gate, ', ' order by g.gate) into v_open from projects.evaluate_maintenance_gates(v_i.id) g where not g.passed and g.gate <> 'admin_approval';
  if v_open is not null then return query select 'gates_open'::text, v_open; return; end if;
  insert into projects.maintenance_release_decisions (organization_id, work_item_id, decision, commit_ref, decided_by) values (v_org, v_i.id, 'requested', v_i.commit_ref, v_actor);
  perform set_config('projects.maintenance_sanctioned', 'on', true);
  update projects.maintenance_work_items set status = 'release_review', release_requested_by = v_actor, release_requested_commit = v_i.commit_ref where id = v_i.id;
  perform core.emit_event(v_org, 'project.maintenance_release_requested', 'maintenance_work_item', v_i.id, jsonb_build_object('projectId', v_i.project_id));
  return query select 'requested'::text, null::text;
end $$;
revoke all on function projects.request_maintenance_release(uuid) from public, anon;
grant execute on function projects.request_maintenance_release(uuid) to authenticated;

create or replace function projects.decide_maintenance_release(p_work_item_id uuid, p_decision text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.maintenance_work_items; v_open text;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  -- a release approval is HUMAN Admin authority; an agent cannot hold it
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('approve', 'reject') then return query select 'bad_decision'::text; return; end if;
  if p_decision = 'reject' and length(btrim(coalesce(p_note, ''))) = 0 then return query select 'note_required'::text; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text; return; end if;
  if v_i.status <> 'release_review' then return query select 'wrong_state'::text; return; end if;
  -- creator != approver: not the person who opened the work, built the commit, or asked for the release
  if v_actor = v_i.created_by or v_actor = v_i.commit_submitted_by or v_actor = v_i.release_requested_by then return query select 'approver_is_the_author'::text; return; end if;
  if v_i.release_requested_commit is distinct from v_i.commit_ref then return query select 'stale_request'::text; return; end if;

  perform set_config('projects.maintenance_sanctioned', 'on', true);
  if p_decision = 'reject' then
    insert into projects.maintenance_release_decisions (organization_id, work_item_id, decision, commit_ref, note, decided_by) values (v_org, v_i.id, 'rejected', v_i.commit_ref, btrim(p_note), v_actor);
    update projects.maintenance_work_items set status = 'changes_requested', release_requested_by = null, release_requested_commit = null where id = v_i.id;
    perform core.record_audit(v_org, 'maintenance_work.release_rejected', 'maintenance_work_item', v_i.id, null, jsonb_build_object('commit', v_i.commit_ref));
    return query select 'rejected'::text; return;
  end if;
  -- the approval re-checks everything NOW: it is not the review of an hour ago
  select string_agg(g.gate, ', ' order by g.gate) into v_open from projects.evaluate_maintenance_gates(v_i.id) g where not g.passed and g.gate <> 'admin_approval';
  if v_open is not null then return query select 'gates_open'::text; return; end if;
  insert into projects.maintenance_release_decisions (organization_id, work_item_id, decision, commit_ref, note, decided_by) values (v_org, v_i.id, 'approved', v_i.commit_ref, nullif(btrim(coalesce(p_note, '')), ''), v_actor);
  update projects.maintenance_work_items set status = 'release_approved', approved_commit = v_i.commit_ref, release_approved_by = v_actor, release_approved_at = now() where id = v_i.id;
  perform core.record_audit(v_org, 'maintenance_work.release_approved', 'maintenance_work_item', v_i.id, null, jsonb_build_object('commit', v_i.commit_ref));
  perform core.emit_event(v_org, 'project.maintenance_release_approved', 'maintenance_work_item', v_i.id, jsonb_build_object('projectId', v_i.project_id));
  return query select 'approved'::text;
end $$;
revoke all on function projects.decide_maintenance_release(uuid, text, text) from public, anon;
grant execute on function projects.decide_maintenance_release(uuid, text, text) to authenticated;

-- a person records that the deployment happened, elsewhere: AgencyOS deploys nothing and invents no success
create or replace function projects.record_maintenance_release(p_work_item_id uuid, p_deployment_ref text, p_smoke_evidence_ref text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.maintenance_work_items;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if length(btrim(coalesce(p_deployment_ref, ''))) = 0 or length(btrim(coalesce(p_smoke_evidence_ref, ''))) = 0 then return query select 'evidence_required'::text; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text; return; end if;
  if v_i.status <> 'release_approved' then return query select 'not_approved'::text; return; end if;
  perform set_config('projects.maintenance_sanctioned', 'on', true);
  update projects.maintenance_work_items set status = 'released', deployment_ref = btrim(p_deployment_ref), smoke_evidence_ref = btrim(p_smoke_evidence_ref), released_by = v_actor, released_at = now() where id = v_i.id;
  perform core.record_audit(v_org, 'maintenance_work.released', 'maintenance_work_item', v_i.id, null, jsonb_build_object('commit', v_i.commit_ref, 'deploymentRef', btrim(p_deployment_ref)));
  perform core.emit_event(v_org, 'project.maintenance_released', 'maintenance_work_item', v_i.id, jsonb_build_object('projectId', v_i.project_id));
  return query select 'released'::text;
end $$;
revoke all on function projects.record_maintenance_release(uuid, text, text) from public, anon;
grant execute on function projects.record_maintenance_release(uuid, text, text) to authenticated;

create or replace function projects.cancel_maintenance_work(p_work_item_id uuid, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.maintenance_work_items;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'reason_required'::text; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text; return; end if;
  if v_i.status in ('release_approved', 'released', 'cancelled') then return query select 'wrong_state'::text; return; end if;
  perform set_config('projects.maintenance_sanctioned', 'on', true);
  update projects.maintenance_work_items set status = 'cancelled', cancelled_reason = btrim(p_reason) where id = v_i.id;
  perform core.record_audit(v_org, 'maintenance_work.cancelled', 'maintenance_work_item', v_i.id, null, jsonb_build_object('reason', btrim(p_reason)));
  return query select 'cancelled'::text;
end $$;
revoke all on function projects.cancel_maintenance_work(uuid, text) from public, anon;
grant execute on function projects.cancel_maintenance_work(uuid, text) to authenticated;

notify pgrst, 'reload schema';
