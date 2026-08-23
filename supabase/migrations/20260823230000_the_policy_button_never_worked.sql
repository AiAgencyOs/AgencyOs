-- The Set policy button never worked — gap G-158.
--
-- Found by the owner, on production, on the exact five-minute setup step the
-- §44 report named as the gap between YELLOW and GREEN: "Could not save the
-- approval policy." Every time, including the first.
--
-- The cause is a meeting of two correct decisions. The uniqueness rule for
-- policy rungs is a PARTIAL index — one active rung per (organization,
-- subject, amount), `where active` — so a deactivated rung does not block the
-- next one. The service wrote through PostgREST's upsert, which emits
-- `ON CONFLICT (organization_id, subject_type, min_amount_minor)` with no
-- predicate — and Postgres refuses to match a bare column list against a
-- partial index (42P10), at plan time, conflict or no conflict. So the
-- statement has never once executed.
--
-- Nothing caught it because every prover used a different door: the live
-- scripts plant policies with plain POSTs, the unit tests mock the client,
-- and the form's own test stubbed the service. The one shape that runs in
-- production — supabase-js `.upsert(..., { onConflict })` — ran nowhere.
-- That is the half-a-check family again, wearing a new coat: a rule held by
-- the database, tested through a path that never consults it.
--
-- The fix moves the write into the database, where the partial predicate can
-- be SAID: `on conflict (...) where active do update`. SECURITY INVOKER, so
-- RLS keeps its rule — only the owner of the organization writes policy —
-- and the money floor stays where it always was, in the constraint.

create or replace function approvals.set_policy(
  p_subject_type     text,
  p_min_amount_minor bigint,
  p_required_role    text,
  p_sla_hours        int,
  p_audience         text default 'internal',
  p_note             text default null
)
returns table (
  -- 'saved' | 'forbidden'
  outcome   text,
  policy_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org uuid;
  v_row approvals.approval_policies;
begin
  v_org := core.current_organization_id();

  -- No identity, no organization, nothing to write against. The service
  -- refuses earlier with better words; this is the belt under the braces.
  if v_org is null then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;

  insert into approvals.approval_policies (
    organization_id, subject_type, min_amount_minor,
    required_role, sla_hours, audience, note, active
  )
  values (
    v_org, p_subject_type, p_min_amount_minor,
    p_required_role, p_sla_hours, p_audience, p_note, true
  )
  on conflict (organization_id, subject_type, min_amount_minor) where active
  do update set
    required_role = excluded.required_role,
    sla_hours     = excluded.sla_hours,
    audience      = excluded.audience,
    note          = excluded.note
  returning * into v_row;

  return query select 'saved'::text, v_row.id;
end;
$$;

comment on function approvals.set_policy(text, bigint, text, int, text, text) is
  'Writes one approval-policy rung, replacing the active rung at the same (subject, amount) if one exists — the "setting the same subject and amount again replaces that rung" the settings page promises. SECURITY INVOKER on purpose: RLS admits only the organization''s owner, and approval_policies_money_floor still refuses a rung below what money demands. Exists because the uniqueness rule is a partial index (one ACTIVE rung per threshold), and a partial index can only be an upsert''s conflict target when the statement states the predicate — which PostgREST''s upsert cannot, so the service''s upsert failed with 42P10 on every press of Set policy, including the first (G-158).';

revoke all on function approvals.set_policy(text, bigint, text, int, text, text) from public;
grant execute on function approvals.set_policy(text, bigint, text, int, text, text) to authenticated;

notify pgrst, 'reload schema';
