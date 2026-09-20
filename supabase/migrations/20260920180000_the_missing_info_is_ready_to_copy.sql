-- ═══════════════════════════════════════════════════════════════════════════
-- The missing info is ready to copy.
--
-- PM §4.2, §6 PM-03; G-266, ADM-109.
--
-- `outstanding_client_requests` (20260917220000) answers WHICH ONE THING to
-- ask next. It does not say WHAT TO WRITE — the onboarding page shows a PM
-- the item's internal label ("Ask next: GST/Non-GST confirmation") and leaves
-- composing an actual message to them, every time, for every project.
--
-- 20260919200000 solved exactly this problem for Phase 3 (`render_design_message`):
-- render the words from live backend state, refuse rather than claim something
-- untrue, and stop there — IT DOES NOT SEND. This is the same door for
-- onboarding's single next question, because a PM copying wording by hand is
-- the interim state ADM-109 already named ("what is built here is the part
-- that does not depend on it") and giving them nothing to copy was never part
-- of that decision — it was simply not built yet.
--
-- This does NOT touch ADM-109's open half (cadence, channel, policy-based
-- follow-up). It renders one message for the one item `outstanding_client_requests`
-- already says is askable; if the caller has no such item, it refuses rather
-- than inventing one.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.render_missing_info_message(p_project_id uuid)
returns table (
  -- 'rendered'        the body, naming the one outstanding item
  -- refusals: 'no_actor' | 'forbidden' | 'unknown_project' | 'nothing_to_ask'
  outcome text,
  body    text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_project  projects.projects;
  v_client   text;
  v_item     record;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::text; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id;
  if v_project.id is null then
    return query select 'unknown_project'::text, null::text; return;
  end if;

  -- RLS on projects.projects already scopes this read to the caller's
  -- organisation and to internal staff; a caller who cannot see the row above
  -- reaches this point with v_project.id null, which the check above already
  -- refused. Nothing further to assert here — unlike render_design_message,
  -- which is SECURITY DEFINER and therefore checks the organisation and role
  -- itself, this function is SECURITY INVOKER, exactly like
  -- outstanding_client_requests beside it: the caller's own session and RLS
  -- do that work.

  select r.item_id, r.key, r.label
    into v_item
    from projects.outstanding_client_requests(p_project_id) r
   where r.ask_next;

  if v_item.item_id is null then
    return query select 'nothing_to_ask'::text, null::text; return;
  end if;

  select ca.name into v_client
    from core.client_accounts ca where ca.id = v_project.client_account_id;

  return query select 'rendered'::text, (
    'Hi' || coalesce(' ' || v_client, '') || ', quick one — could you share the following so we can move '
    || 'your project forward: ' || v_item.label || '?'
  );
end;
$$;

comment on function projects.render_missing_info_message(uuid) is
  'PM section 4.2, G-266, ADM-109 (the half that does not depend on it). Renders the words for the ONE outstanding item outstanding_client_requests names as askable. A project with nothing askable is refused (nothing_to_ask) rather than rendering stale or invented wording. IT RENDERS; IT DOES NOT SEND, and it does not touch ADM-109''s open half (cadence, channel, policy-based follow-up) — that is a decision still awaiting the owner, not a fact this door can compute.';

revoke all on function projects.render_missing_info_message(uuid) from public, anon;
grant execute on function projects.render_missing_info_message(uuid) to authenticated;
