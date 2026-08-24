-- ═══════════════════════════════════════════════════════════════════════════
-- The client asks, and the agent redrafts — ADM-96's second half, G-163.
--
-- G-157 closed the revision loop with a person in the middle: the client's
-- change-ask became an objection row, the queue said `revision_asked`, and a
-- PERSON drafted the next version. ADM-96 ("agent sab kuch kre mai bs pdf
-- approve changes karo") moved the drafting to the agent for the OWNER's
-- changes-note in PR #329; this migration is the same move for the CLIENT's
-- ask: a scope-change objection now becomes an event, the rework job drafts
-- and prices the next version, submits it, and the owner's phone gets the
-- PDF. The owner's two verbs stay the only human acts — and the price
-- objection stays out of this loop entirely (see the emitter's comment).
--
-- Emitted BY TRIGGER, WHERE THE STATE CHANGES (the PR #277 principle): the
-- objection row is written by the objection-read job in TypeScript, so no
-- SQL emitter exists to edit — the insert itself is the fact, and anything
-- less than a trigger would be a second copy of "an objection now exists"
-- for two writers to disagree about.
-- ═══════════════════════════════════════════════════════════════════════════

-- `canonical` NULL, checked against Doc 23 §7 rather than assumed: the
-- nearest name, ChangeRequestSubmitted, is the DELIVERY scope-change engine's
-- (already mapped to change_request.submitted) — a pre-project sales
-- objection is a different fact, and borrowing the name would inflate the
-- coverage number (the vocabulary migration's own refusal, PR #277).
insert into core.event_types (type, description, canonical)
values (
  'objection.recorded',
  'A client pushback became a structured objection row; subscribers may act on its kind (G-163).',
  null
)
on conflict (type) do nothing;

create or replace function sales.emit_objection_recorded()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- INSERT only, and that is load-bearing twice over. An objection is
  -- written once and answered by a PERSON (objections_agent_writes_no_answer
  -- holds that); re-emitting on the answer would hand the rework job the
  -- objection AFTER a person already settled it. And the payload carries
  -- CLAIMS for plan-time filtering only — `kind` decides whether a job is
  -- worth enqueuing, and the workflow re-reads the row as the authority
  -- (the PR #178 rule).
  perform core.emit_event(
    new.organization_id, 'objection.recorded', 'objection', new.id,
    jsonb_build_object(
      'leadId',     new.lead_id,
      'messageId',  new.message_id,
      'proposalId', new.proposal_id,
      'kind',       new.kind,
      'round',      new.round
    )
  );
  return new;
end;
$$;

comment on function sales.emit_objection_recorded() is
  'Emits objection.recorded when an objection row is written (G-163). Insert only: the answer is a person''s and must not re-fire the loop. The payload''s kind is a plan-time filter claim; the workflow re-reads the row.';

drop trigger if exists emit_objection_recorded on sales.objections;
create trigger emit_objection_recorded
  after insert on sales.objections
  for each row execute function sales.emit_objection_recorded();


-- ── 2. The draft names its base, and the database refuses a stale one ──────
--
-- Found by this change's own adversarial review: QUOTATION_REWORK's and
-- QUOTATION_REVISE's view of "the live version" is read before a model call
-- that can outlast a cron tick, and with client asks now minting independent
-- rework jobs, two cycles against one deal are ordinary — the slower one
-- superseded the faster one's just-submitted version and silently dropped
-- its ask. The guard belongs where the lock is. Carried forward VERBATIM
-- from 20260823170000 (the live definition), with the two edits marked.
create or replace function sales.draft_proposal(
  p_opportunity_id         uuid,
  p_title                  text,
  p_body                   text default null,
  p_valid_until            date default null,
  p_requirement_version_id uuid default null,
  p_created_by             uuid default null,
  -- The one addition to the signature. Appended with a default, so every
  -- existing call means precisely what it meant before.
  p_generated_by_run_id    uuid default null,
  -- ── EDIT (G-163 review, 2026-08-24): the caller can name its base ────────
  -- A drafting job's read of "what is live" is minutes old by the end of a
  -- model call, and two agent cycles against one deal are now ordinary. When
  -- the caller names the version it reworked FROM, this function refuses to
  -- supersede anything else — the check runs under the opportunity lock, so
  -- there is no window left at all. Null keeps the old behaviour for callers
  -- (a person's UI) whose base is "whatever is live right now".
  p_expected_supersede     uuid default null
)
returns table (
  -- 'created' | 'not_found' | 'settled' | 'stale'
  outcome     text,
  proposal_id uuid,
  version     int,
  superseded  uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_opportunity sales.opportunities;
  v_next        int;
  v_live        sales.proposals;
  v_row         sales.proposals;
begin
  -- The lock is on the opportunity, so two people drafting at the same moment
  -- serialise: one allocates v2 and the other v3, and neither loses
  -- `proposals_live_version_key` to the other. The same reason
  -- add_deliverable locks the project.
  select o.* into v_opportunity
    from sales.opportunities o
   where o.id = p_opportunity_id
   for update;

  if v_opportunity.id is null then
    return query select 'not_found'::text, null::uuid, null::int, null::uuid;
    return;
  end if;

  -- A won or lost deal is not one that takes new quotes. Refused here rather
  -- than left to look like it worked, because a quote drafted against a
  -- settled deal is invisible in every pipeline view there is.
  if v_opportunity.stage in ('won', 'lost') then
    return query select 'settled'::text, null::uuid, null::int, null::uuid;
    return;
  end if;

  select coalesce(max(p.version), 0) + 1 into v_next
    from sales.proposals p
   where p.opportunity_id = p_opportunity_id;

  -- §16: V2 is generated, V1 remains historical. The earlier live version is
  -- superseded rather than deleted, and this is what keeps
  -- `proposals_live_version_key` satisfiable — one live version, always.
  --
  -- Superseding a *sent* quote is deliberate and is what §16 describes: the
  -- client asked for a change, so the number they were looking at is no
  -- longer the number on the table.
  select p.* into v_live
    from sales.proposals p
   where p.opportunity_id = p_opportunity_id
     and p.status in ('draft', 'pending_approval', 'approved', 'sent')
   for update;

  -- ── EDIT (G-163 review, 2026-08-24): the stale gate ──────────────────────
  -- Under the same lock as the supersede itself. `is distinct from` on
  -- purpose: expecting a base that has vanished is as stale as finding a
  -- different one.
  if p_expected_supersede is not null and v_live.id is distinct from p_expected_supersede then
    return query select 'stale'::text, null::uuid, null::int, v_live.id;
    return;
  end if;

  if v_live.id is not null then
    update sales.proposals
       set status = 'superseded'
     where sales.proposals.id = v_live.id;

    -- A version on its way out takes its pending question with it. Leaving the
    -- request open would put a quote in the owner's queue that can never be
    -- sent, and ADM-08's whole point is that the queue means something.
    --
    -- Through the engine's own function, not with an UPDATE from here: sales
    -- has no write policy on that table, so an UPDATE would have matched zero
    -- rows and reported success.
    if v_live.approval_request_id is not null then
      perform approvals.cancel_request(
        v_live.approval_request_id,
        'Superseded by quotation v' || v_next
      );
    end if;
  end if;

  insert into sales.proposals (
    organization_id, opportunity_id, version, title, body,
    valid_until, requirement_version_id, currency, created_by,
    -- The second and last addition. The column has existed since the schema's
    -- first day, commented "set when an AI agent drafted it", and nothing ever
    -- set it - so an agent-drafted quotation was indistinguishable from one a
    -- person typed, which is exactly the provenance an owner approving it
    -- needs.
    generated_by_run_id
  )
  values (
    v_opportunity.organization_id, p_opportunity_id, v_next, p_title, p_body,
    p_valid_until, p_requirement_version_id, v_opportunity.currency, p_created_by,
    p_generated_by_run_id
  )
  returning * into v_row;

  return query select 'created'::text, v_row.id, v_next, v_live.id;
end;
$$;

comment on function sales.draft_proposal(uuid, text, text, date, uuid, uuid, uuid, uuid) is
  'Allocates the next version under the opportunity lock, superseding the live one; p_expected_supersede lets a drafting job name the base it reworked from, refused as stale when the live version is anything else (G-163).';

-- The seven-arg overload retires the way the six-arg one did in 20260823170000:
-- one function, one meaning per call.
drop function if exists sales.draft_proposal(uuid, text, text, date, uuid, uuid, uuid);

grant execute on function sales.draft_proposal(uuid, text, text, date, uuid, uuid, uuid, uuid) to authenticated, service_role;
