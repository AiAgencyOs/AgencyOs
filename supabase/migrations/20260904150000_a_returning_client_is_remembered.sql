-- ═══════════════════════════════════════════════════════════════════════════
-- A returning client is remembered — G-199 (Doc 05 §4, audit LM-08)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `ai.memory_records` has had a `client` scope since the day it was created,
-- and not one row has ever been written at it. Lead memory works — the intent
-- read records what a client says about themselves, scoped to the lead (G-137,
-- Doc 05 §5). But a lead ends.
--
-- So a client who came back — the same person, a second project, six months
-- later — met an agency that had forgotten them. Everything it knew was
-- attached to a lead that was closed, and the new conversation started from
-- nothing. The audit's words for it: *a returning client is recognised as a
-- record, not as a remembered relationship.*
--
-- ── who is allowed to write a client fact ─────────────────────────────────
--
-- Not an agent, and not on its own judgement. Doc 05 §35: *"Never store a
-- model-generated assumption as a verified client fact without provenance"*,
-- and §18 defines VERIFIED as *"confirmed by an authoritative business
-- process."*
--
-- **Winning the deal is that process.** It is the moment the system learns
-- this person is a client, it is recorded in a row nobody can write by hand
-- (`sales.opportunities.stage`), and it happens exactly once. So the promotion
-- lives in a trigger on that transition rather than in a job, a prompt or an
-- agent: it cannot be reached through language, which is Doc 19 §38's rule.
--
-- ── what is carried, and what is not ──────────────────────────────────────
--
-- Two different things, and the difference is the whole of the design.
--
-- **The win itself** becomes a VERIFIED fact, authored by no agent, pointing
-- at the opportunity. That is a fact about the world, confirmed by a business
-- process, and the trigger is the process.
--
-- **What the client said about themselves** is CARRIED, not promoted. An
-- `explicit` lead memory keeps its own confidence, its own source message and
-- its own author when it becomes a client fact. It was the client's own words
-- before the deal and it is the client's own words after; winning does not
-- make it truer, it only makes it worth keeping.
--
-- **An inference is left behind.** A model's guess about a lead has no
-- business outliving the lead: `inferred` rows are not carried, because
-- carrying them is exactly how a guess becomes a permanent client fact — the
-- one thing Doc 05 §35 names.

create or replace function sales.remember_the_client_on_a_win()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact uuid;
  v_carried int := 0;
begin
  -- The transition, and only the transition. `closed_at` already makes a win
  -- one-way, but this is read from the delta rather than from the state so a
  -- routine update of a won deal writes nothing.
  if new.stage <> 'won' or old.stage is not distinct from 'won' then
    return new;
  end if;

  if new.lead_id is null then
    return new;
  end if;

  select l.contact_id into v_contact
    from crm.leads l
   where l.id = new.lead_id
     and l.organization_id = new.organization_id;

  -- A deal with no contact behind it is a deal nobody can be reminded of.
  -- Silent rather than raised: refusing the WIN because the memory cannot be
  -- written would be a memory feature blocking a sale.
  if v_contact is null then
    return new;
  end if;

  -- Idempotent by provenance rather than by a flag: the fact points at this
  -- opportunity, so a second attempt finds it already written.
  if not exists (
    select 1 from ai.memory_records m
     where m.organization_id = new.organization_id
       and m.scope = 'client' and m.scope_id = v_contact
       and m.source_kind = 'sales.opportunity' and m.source_id = new.id
       and m.superseded_by is null
  ) then
    insert into ai.memory_records (
      organization_id, scope, scope_id, kind, fact,
      confidence, source_kind, source_id, authored_by_agent
    )
    values (
      new.organization_id, 'client', v_contact, 'became_a_client',
      'They became a client on ' || to_char(coalesce(new.closed_at, now()), 'FMDD Month YYYY')
        || ' with ' || coalesce(nullif(btrim(new.name), ''), 'a project'),
      -- VERIFIED, and authored by no agent: this row is written by the
      -- transition itself, which is what section 18 means by an authoritative
      -- business process. An agent writing this would be an agent confirming
      -- its own inference.
      'verified', 'sales.opportunity', new.id, null
    );
  end if;

  /**
   * And what they told us themselves, carried across.
   *
   * `explicit` only. An inference has no business outliving the lead it was
   * made about, and carrying one is precisely how a model's guess becomes a
   * permanent client fact.
   *
   * Provenance travels with the row: the same source message, the same
   * confidence, the same author. Winning does not make a sentence truer.
   *
   * Deduplicated on the fact itself, because a client who says the same thing
   * across two leads should be remembered once.
   */
  insert into ai.memory_records (
    organization_id, scope, scope_id, kind, fact,
    confidence, source_kind, source_id, authored_by_agent
  )
  select m.organization_id, 'client', v_contact, m.kind, m.fact,
         m.confidence, m.source_kind, m.source_id, m.authored_by_agent
    from ai.memory_records m
   where m.organization_id = new.organization_id
     and m.scope = 'lead' and m.scope_id = new.lead_id
     and m.confidence = 'explicit'
     and m.superseded_by is null
     and (m.expires_at is null or m.expires_at > now())
     and not exists (
       select 1 from ai.memory_records c
        where c.organization_id = new.organization_id
          and c.scope = 'client' and c.scope_id = v_contact
          and c.kind = m.kind and c.fact = m.fact
          and c.superseded_by is null
     );

  get diagnostics v_carried = row_count;

  perform core.record_audit(
    new.organization_id, 'client.remembered', 'contact', v_contact,
    null,
    jsonb_build_object('opportunityId', new.id, 'carried', v_carried),
    null
  );

  return new;
end;
$$;

comment on function sales.remember_the_client_on_a_win() is
  'Doc 05 section 4''s client memory, written by the one authoritative business process that says somebody IS a client: winning the deal. The win itself becomes a VERIFIED fact authored by no agent; what the client said about themselves is CARRIED at its own confidence with its own provenance; an INFERENCE is left behind, because carrying a guess is how a guess becomes a permanent client fact (section 35).';

drop trigger if exists remember_the_client_on_a_win on sales.opportunities;
create trigger remember_the_client_on_a_win
  after update of stage on sales.opportunities
  for each row execute function sales.remember_the_client_on_a_win();

notify pgrst, 'reload schema';
