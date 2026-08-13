-- G-093 — the history is written by the database, in the transaction it describes.
--
-- ADM-51: table triggers. Thirteen audit rows were written in a request of
-- their own, after the change they describe had already committed:
--
--   await supabase.schema('crm').from('leads').update({ status });  -- commits
--   await recordAudit({ action: 'lead.status_changed', ... });      -- separate
--
-- Between those two the process can die and the lead is converted with the
-- history saying nobody did it. `audit.audit_log` is append-only by trigger, so
-- a row never written can never be written later — no repair, no backfill.
--
-- G-079 fixed the four writes that already sat beside a Postgres function.
-- These thirteen had none, and putting each behind a function would have turned
-- every future CRM change into a migration — a permanent tax for a rare hole.
--
-- The trigger fixes something a function could not: it covers **every path**.
-- A write made through PostgREST directly, from a psql session, or by a service
-- nobody has written yet is audited the same as one from the service layer. A
-- trail that depends on everybody remembering to call `recordAudit` has exactly
-- the weakness D16 had, where RLS was wider than the code that guarded it.
--
-- ── the objection this answers ────────────────────────────────────────────
--
-- The decision document argued triggers would cost the vocabulary: a trigger
-- sees rows, not intent, so it can say `leads.status` changed from `qualified`
-- to `converted` but not `lead.converted` — and that name is what makes the log
-- readable. It recommended accepting the loss.
--
-- The loss is avoidable. The vocabulary is not intent at all: every one of the
-- thirteen action names is *derivable from the diff*, because the service that
-- wrote it derived it from the same diff a moment earlier. Encoding that here
-- moves the naming to where it cannot be bypassed instead of discarding it.
--
-- So this is option C without its stated cost, and it is deliberately not
-- option D: there is one mechanism, not two. After this migration no service
-- writes an audit row for these tables, and a reader never has to ask which
-- mechanism answered.

-- ── the writer ────────────────────────────────────────────────────────────

create or replace function audit.record_row_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_action  text;
  v_subject text;
  v_before  jsonb;
  v_after   jsonb;
  v_org     uuid;
begin
  v_after := to_jsonb(new);
  v_before := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;

  v_org := (v_after->>'organization_id')::uuid;

  -- Without a tenant the row cannot be filed, and audit.audit_log requires one.
  -- Refusing is right: a business row with no organization is a bug upstream,
  -- and silently dropping its history would hide it.
  if v_org is null then
    raise exception 'audit.record_row_change: % has no organization_id', tg_table_name;
  end if;

  -- The vocabulary, derived from the diff exactly as the services derived it.
  -- A change that matches nothing named still audits, under `<subject>.updated`
  -- — silence would be the one outcome worse than a vague name.
  case tg_table_name
    when 'leads' then
      v_subject := 'lead';
      v_action :=
        case
          when tg_op = 'INSERT' then 'lead.created'
          when new.status = 'converted' and old.status is distinct from 'converted' then 'lead.converted'
          when new.status is distinct from old.status then 'lead.status_changed'
          when new.qualification is distinct from old.qualification then 'lead.qualification_updated'
          when new.next_follow_up_at is distinct from old.next_follow_up_at then 'lead.follow_up_scheduled'
          else 'lead.updated'
        end;

    when 'lead_activities' then
      v_subject := 'lead';
      v_action := 'lead.note_added';

    when 'requirement_versions' then
      v_subject := 'requirement_version';
      v_action :=
        case
          when tg_op = 'INSERT' then 'requirement.proposed'
          when new.status is distinct from old.status then 'requirement.' || new.status
          else 'requirement.updated'
        end;

    when 'client_accounts' then
      v_subject := 'client_account';
      v_action := case when tg_op = 'INSERT' then 'client_account.created' else 'client_account.updated' end;

    when 'opportunities' then
      v_subject := 'opportunity';
      v_action :=
        case
          when tg_op = 'INSERT' then 'opportunity.created'
          when new.stage = 'won' and old.stage is distinct from 'won' then 'opportunity.won'
          when new.stage is distinct from old.stage then 'opportunity.stage_changed'
          when new.value_minor is distinct from old.value_minor then 'opportunity.value_changed'
          else 'opportunity.updated'
        end;

    when 'projects' then
      v_subject := 'project';
      v_action :=
        case
          when tg_op = 'INSERT' then 'project.created'
          when new.status is distinct from old.status then 'project.status_changed'
          else 'project.updated'
        end;

    when 'defects' then
      v_subject := 'defect';
      v_action :=
        case
          when tg_op = 'INSERT' then 'defect.raised'
          when new.status is distinct from old.status then 'defect.' || new.status
          else 'defect.updated'
        end;

    else
      -- A table was given this trigger without being given a name. Refusing is
      -- the point: the alternative is a log full of rows nobody can read.
      raise exception 'audit.record_row_change: no vocabulary for table %', tg_table_name;
  end case;

  -- An UPDATE that changed nothing this table names, and changed no column at
  -- all, is not history. `updated_at` alone is not either.
  if tg_op = 'UPDATE' and (v_before - 'updated_at') = (v_after - 'updated_at') then
    return null;
  end if;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org,
    case when (select auth.uid()) is null then 'system' else 'user' end,
    (select auth.uid()),
    v_action,
    v_subject,
    (v_after->>'id')::uuid,
    v_before,
    v_after
  );

  return null;
end;
$$;

comment on function audit.record_row_change() is
  'Writes audit.audit_log from inside the transaction that changed the row (G-093, ADM-51). Replaces thirteen service-layer recordAudit calls that wrote in a request of their own. Covers every path into the table, including PostgREST and psql, which no service-layer call could. The action vocabulary is derived from the column diff, exactly as the services derived it, so the readable names survive the move. AFTER trigger returning null: it cannot alter the row it records.';

-- ── the tables ────────────────────────────────────────────────────────────
--
-- Narrow on purpose, as the decision asked: the tables whose changes are
-- business-significant, and nothing else. Not jobs, not outbox_events, not
-- agent runs — those are machinery, and auditing them would bury the log in
-- rows nobody reads.

do $$
declare
  t text;
begin
  foreach t in array array[
    'crm.leads',
    'crm.lead_activities',
    'crm.requirement_versions',
    'core.client_accounts',
    'sales.opportunities',
    'projects.projects',
    'qa.defects'
  ]
  loop
    execute format('drop trigger if exists audit_row_change on %s', t);
    execute format(
      'create trigger audit_row_change after insert or update on %s
         for each row execute function audit.record_row_change()',
      t
    );
  end loop;
end;
$$;

-- ── the contradiction this surfaced ───────────────────────────────────────
--
-- Found by CI, not by reasoning: every functional check passed and the
-- *cleanup* failed. Deleting a temporary organization raised
-- `audit.audit_log is append-only (attempted DELETE)`.
--
-- Two rules had always disagreed and nothing had made them collide:
--
--   `audit.audit_log.organization_id references core.organizations(id)
--    on delete cascade`   — deleting a tenant takes its history with it
--
--   `audit_log_no_delete before delete ... raise exception`
--                        — nothing may ever be deleted, cascade included
--
-- So an organization with any history at all could not be deleted, and the
-- FK's promise was decorative. Before this migration the collision was
-- theoretical, because the audit rows were written by a service layer these
-- scripts never call. Now every lead insert writes one.
--
-- The guard exists to stop *tampering*. Erasing a tenant is not tampering: it
-- is the thing the foreign key already says happens, and a tenant who asks to
-- be forgotten should not be refused by a trigger nobody chose for that.
--
-- So the rule becomes exactly what was always meant: **history may only
-- disappear together with the tenant it belongs to.** During a cascade the
-- parent row is already gone by the time the child trigger runs, which is what
-- makes this checkable rather than a guess about intent. A direct DELETE, with
-- the organization still present, still raises — and that is the case the
-- guard was written for.
--
-- UPDATE is untouched. Rewriting history stays impossible, which is the
-- property everything else in this system leans on.

create or replace function audit.reject_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and not exists (select 1 from core.organizations o where o.id = old.organization_id)
  then
    -- The organization is being removed in this transaction; its history goes
    -- with it. Nothing else can reach this branch: outside a cascade the row
    -- is still there.
    return old;
  end if;

  raise exception 'audit.audit_log is append-only (attempted %)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function audit.reject_mutation() is
  'Keeps audit.audit_log append-only. UPDATE is always refused. DELETE is refused unless the organization the row belongs to has already been removed in this transaction - the cascade the foreign key has always declared, which the original guard refused, making an organization with any history undeletable (found by CI when G-093 gave every lead a history).';
