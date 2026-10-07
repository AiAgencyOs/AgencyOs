-- The Test Automation and Documentation agents propose; a person decides (P10, P514). This migration adds the human doors for their two drafts.
--   * a test case draft is accepted or rejected by someone who manages delivery (owner, ops admin, delivery lead). Accepting records the decision
--     and who made it; it does NOT create a test, a run or a result: no table here holds a proposed test of this shape without an invented plan,
--     category or acceptance criterion, so a person writes the test and an agent draft is never evidence.
--   * a documentation draft is promoted ONLY by an Admin, and only through the existing document rules: an implemented document names its
--     evidence (and the guard trigger still refuses an unverified integration). A rejected draft is deprecated, never deleted.

-- ── 1. test case drafts: a reviewed state ────────────────────────────────
alter table projects.test_case_drafts
  add column if not exists reviewed_by uuid references core.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;
alter table projects.test_case_drafts drop constraint if exists test_case_drafts_status_check;
alter table projects.test_case_drafts add constraint test_case_drafts_status_check check (status in ('draft', 'accepted', 'rejected'));
alter table projects.test_case_drafts drop constraint if exists test_case_drafts_review_shape;
alter table projects.test_case_drafts add constraint test_case_drafts_review_shape
  check (status = 'draft' or (reviewed_by is not null and reviewed_at is not null));
alter table projects.test_case_drafts drop constraint if exists test_case_drafts_review_note_cap;
alter table projects.test_case_drafts add constraint test_case_drafts_review_note_cap check (review_note is null or length(review_note) <= 1000);
alter table projects.test_case_drafts drop constraint if exists test_case_drafts_rejection_says_why;
alter table projects.test_case_drafts add constraint test_case_drafts_rejection_says_why
  check (status <> 'rejected' or (review_note is not null and length(btrim(review_note)) > 0));

-- a decision is a record: a reviewed draft is never reopened or rewritten
create or replace function projects.test_case_drafts_decision_is_final() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'draft' then raise exception 'a reviewed test case draft is a record: it is never rewritten' using errcode = 'restrict_violation'; end if;
  return new;
end $$;
drop trigger if exists test_case_drafts_decision_is_final on projects.test_case_drafts;
create trigger test_case_drafts_decision_is_final before update on projects.test_case_drafts for each row execute function projects.test_case_drafts_decision_is_final();

create or replace function projects.review_test_case_draft(p_draft_id uuid, p_decision text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_draft projects.test_case_drafts;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_draft from projects.test_case_drafts d where d.id = p_draft_id for update;
  if v_draft.id is null or v_draft.organization_id is distinct from (select core.current_organization_id()) then return query select 'not_found'::text; return; end if;
  if p_decision is null or p_decision not in ('accepted', 'rejected') then return query select 'bad_decision'::text; return; end if;
  if v_draft.status <> 'draft' then return query select 'already_reviewed'::text; return; end if;
  if p_decision = 'rejected' and v_note is null then return query select 'note_required'::text; return; end if;
  if v_note is not null and length(v_note) > 1000 then return query select 'note_too_long'::text; return; end if;
  update projects.test_case_drafts set status = p_decision, reviewed_by = v_actor, reviewed_at = now(), review_note = v_note where id = v_draft.id;
  return query select p_decision::text;
end $$;
revoke all on function projects.review_test_case_draft(uuid, text, text) from public, anon;
grant execute on function projects.review_test_case_draft(uuid, text, text) to authenticated;

-- ── 2. documentation drafts ──────────────────────────────────────────────
-- A draft is a document the Documentation agent wrote: status 'partial', and a body that starts with the DRAFT marker. An Admin either promotes it to
-- a status they choose (the same rules as record_technical_document: implemented names evidence; the guard trigger decides the rest) or
-- rejects it, which deprecates it. Nothing is promoted automatically, and the marker is removed only by this door.
create or replace function projects.review_documentation_draft(p_document_id uuid, p_decision text, p_status text default null, p_evidence_ref text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_doc projects.technical_documents;
  v_marker constant text := 'DRAFT (written by the Documentation agent; not reviewed by a person)' || E'\n\n';
  v_evidence text := nullif(btrim(coalesce(p_evidence_ref, '')), '');
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_doc from projects.technical_documents t where t.id = p_document_id for update;
  if v_doc.id is null or v_doc.organization_id is distinct from (select core.current_organization_id()) then return query select 'not_found'::text; return; end if;
  if p_decision is null or p_decision not in ('accepted', 'rejected') then return query select 'bad_decision'::text; return; end if;
  if v_doc.status <> 'partial' or v_doc.derived or left(coalesce(v_doc.body, ''), length(v_marker)) <> v_marker then return query select 'not_a_draft'::text; return; end if;
  begin
    if p_decision = 'rejected' then
      update projects.technical_documents set status = 'deprecated' where id = v_doc.id;
      return query select 'rejected'::text; return;
    end if;
    if p_status is null or p_status not in ('implemented', 'partial', 'not_implemented', 'not_required', 'manual_external') then return query select 'bad_status'::text; return; end if;
    if p_status = 'implemented' and v_evidence is null then return query select 'evidence_required'::text; return; end if;
    update projects.technical_documents
       set status = p_status, evidence_ref = v_evidence, body = substr(v_doc.body, length(v_marker) + 1)
     where id = v_doc.id;
  exception
    when restrict_violation then return query select 'refused'::text; return;
    when check_violation then return query select 'invalid'::text; return;
  end;
  return query select 'accepted'::text;
end $$;
revoke all on function projects.review_documentation_draft(uuid, text, text, text) from public, anon;
grant execute on function projects.review_documentation_draft(uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';
