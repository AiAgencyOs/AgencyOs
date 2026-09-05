-- ═══════════════════════════════════════════════════════════════════════════
-- The pool and the gate agree — G-221
-- ═══════════════════════════════════════════════════════════════════════════
--
-- G-219 made enrolment refuse a contact who is already a client, a live deal,
-- or somebody the agency agreed to come back to on a date. It did not tell
-- the NUMBER an operator plans a campaign from: `crm.reactivation_priority`
-- filtered on consent and on the LEAD'S status and never asked who the
-- CONTACT already is, so a person appeared in the pool and was refused at the
-- gate with nothing to say why the number moved.
--
-- Fixing that is one predicate. Asking WHY the gate refuses turned out to
-- matter far more.
--
-- ── what the fix exposed ──────────────────────────────────────────────────
--
-- `crm.relationship_is_contactable` excluded `active_deal`, and `active_deal`
-- is *any opportunity not won or lost*. G-210's reasoning is sound —
-- *"somebody is working this right now; re-engaging would put two
-- conversations on one deal"* — but the predicate cannot tell a live deal
-- from an opportunity row nobody ever closed.
--
-- After a year, almost every quoted-and-quiet lead is `active_deal`. Measured:
-- a lead quoted long ago, its opportunity still in `proposal`, answers
-- `active_deal`, and `add_lead_to_reactivation_pilot` answers
-- `not_contactable`.
--
-- **That is the exact cohort the reactivation campaign exists for, and G-219
-- made it un-enrollable.** A second consequence: G-141's tiers
-- `previously_quoted` and `previously_replied` became unreachable in the pool,
-- because anyone with a proposal has an opportunity — the ranking that orders
-- the campaign was largely dead.
--
-- Nobody noticed because nothing ENFORCED the rule until G-219. G-210 wrote
-- it and G-211 displayed it; teeth arrived last.
--
-- ── one predicate was answering two questions ─────────────────────────────
--
-- *May we cold-open this person?* and *may we re-engage them?* are different
-- questions with different answers, and `is_contactable` was one name for
-- both. That ambiguity IS the defect.
--
--   client      — never, to either. A sales opening damages a live
--                 relationship however long they have been quiet.
--   nurture     — never before the date. Silence is the POINT: they asked for
--                 it, and writing early breaks an agreement we made.
--   active_deal — refused a cold open, ADMITTED to re-engagement. "Active" is
--                 a claim about a row; whether anybody is really in that
--                 conversation is answered by SILENCE, and the inactive_lead
--                 observer already asks exactly that, downstream of here.
--
-- So the check that belongs here is the re-engagement one, and it is named
-- for the question it answers. The cold-open predicate is NOT written: no
-- cold-open path exists, and a function nothing calls is the defect this
-- file is fixing, told in a different tense.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.relationship_admits_reengagement(p_relationship text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_relationship not in ('client', 'nurture')
$$;

comment on function crm.relationship_admits_reengagement(text) is
  'Whether a relationship class may be RE-ENGAGED (G-221, narrowing G-210). Client is never re-engaged — a sales opening damages a live relationship however long they have been quiet — and nurture is a date we agreed with them, where silence is the point. ACTIVE_DEAL IS ADMITTED, and that is the correction: it means any opportunity not won or lost, which after a year is every quoted-and-quiet lead, and excluding them made the campaign''s own cohort un-enrollable. Whether somebody is really in that conversation is answered by SILENCE, which the inactive_lead observer asks downstream. LOST is admitted — a lost deal is the ordinary subject of re-engagement, and the eleven documented reasons are what an operator reads before deciding.';

-- ── the preview describes what the gate does ──────────────────────────────
create or replace function crm.import_relationship_preview(p_batch_id uuid)
returns table (relationship text, contactable boolean, records bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.relationship,
         -- Renamed underneath, same column: what this preview has always been
         -- about is a re-engagement campaign, and now it says so.
         crm.relationship_admits_reengagement(r.relationship) as contactable,
         count(*) as records
    from (
      select coalesce(
               case when ir.matched_contact_id is null then null
                    else crm.contact_relationship(ir.matched_contact_id) end,
               'unknown'
             ) as relationship
        from crm.import_records ir
       where ir.batch_id = p_batch_id
    ) r
   group by r.relationship
   order by r.relationship;
$$;

comment on function crm.import_relationship_preview(uuid) is
  'Who is already in an import batch, grouped by relationship, with whether each class may be re-engaged (G-210, corrected by G-221). The `contactable` column answers the RE-ENGAGEMENT question — the one an operator is actually asking before a reactivation campaign — so it agrees with what enrolment will do.';

-- ── the gate asks the same question ───────────────────────────────────────
create or replace function crm.add_lead_to_reactivation_pilot(p_lead_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid;
  v_contact uuid;
  v_in      boolean;
begin
  select l.organization_id, l.contact_id, l.in_reactivation_pilot
    into v_org, v_contact, v_in
    from crm.leads l
   where l.id = p_lead_id
     and l.deleted_at is null
   for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text; return;
    end if;
    if v_org is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text; return;
    end if;
  end if;

  if v_contact is null
     or not exists (
       select 1 from crm.communication_consent cc
        where cc.organization_id = v_org
          and cc.contact_id      = v_contact
          and cc.channel         = 'whatsapp'
          and cc.status          = 'granted'
     )
  then
    return query select 'no_consent'::text; return;
  end if;

  -- EDIT (G-221): the re-engagement question, not the cold-open one. G-219
  -- asked `is_contactable`, which excluded active_deal and therefore excluded
  -- every lead quoted long enough ago for its opportunity to still be open —
  -- the campaign's own cohort.
  if not crm.relationship_admits_reengagement(crm.contact_relationship(v_contact)) then
    return query select 'not_contactable'::text; return;
  end if;

  if v_in then
    return query select 'already_in'::text; return;   -- idempotent
  end if;

  perform set_config('crm.reactivation_pilot_write', 'on', true);
  update crm.leads set in_reactivation_pilot = true where id = p_lead_id;

  return query select 'added'::text;
end;
$$;

comment on function crm.add_lead_to_reactivation_pilot(uuid) is
  'Enrolls a lead in the reactivation pilot cohort (G-012, G-140/ADM-87). SECURITY DEFINER; owner/ops_admin, tenant derived from the lead row. REFUSES unless the lead''s contact has a granted whatsapp consent row (G-012) and unless the contact''s relationship ADMITS RE-ENGAGEMENT (G-219, narrowed by G-221 — client and nurture only, because excluding active_deal excluded the campaign''s own cohort). Audited via the crm.leads row-change trigger.';

-- ── and so does the number an operator plans from ─────────────────────────
create or replace function crm.reactivation_priority(
  p_organization_id uuid default null,
  p_limit           int  default 500
)
returns table (
  lead_id        uuid,
  tier           int,
  tier_name      text,
  last_active_at timestamptz,
  contact_id     uuid,
  phone          text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := case
    when (select auth.uid()) is not null then (select core.current_organization_id())
    else p_organization_id
  end;
begin
  return query
  select l.id,
         t.tier,
         case t.tier
           when 4 then 'previously_quoted'
           when 3 then 'previously_replied'
           when 2 then 'has_conversation'
           else 'cold'
         end,
         greatest(
           l.created_at,
           coalesce(act.last_at, l.created_at),
           coalesce(msg.last_at, l.created_at)
         ) as last_active_at,
         l.contact_id,
         c.phone
    from crm.leads l
    join crm.contacts c
      on c.id = l.contact_id
    join crm.communication_consent cc
      on cc.organization_id = l.organization_id
     and cc.contact_id      = l.contact_id
     and cc.channel         = 'whatsapp'
     and cc.status          = 'granted'
    left join lateral (
      select max(la.occurred_at) as last_at
        from crm.lead_activities la
       where la.lead_id = l.id
    ) act on true
    left join lateral (
      select max(cm.occurred_at) as last_at
        from crm.conversation_messages cm
        join crm.conversations cv on cv.id = cm.conversation_id
       where cv.lead_id = l.id
    ) msg on true
    cross join lateral (
      select case
        when exists (
          select 1 from sales.proposals p
            join sales.opportunities o on o.id = p.opportunity_id
           where o.lead_id = l.id
        ) then 4
        when exists (
          select 1 from crm.conversations cv
            join crm.conversation_messages cm on cm.conversation_id = cv.id
           where cv.lead_id = l.id and cm.author_type = 'client'
        ) then 3
        when exists (
          select 1 from crm.conversations cv where cv.lead_id = l.id
        ) then 2
        else 1
      end as tier
    ) t
   where l.organization_id = v_org
     and l.status in ('new', 'qualifying', 'qualified')
     and l.deleted_at is null
     /**
      * EDIT (G-221): and who this contact ALREADY IS.
      *
      * The lead's status says this lead is open. It does not say the person
      * behind it became a client on a different one, and `contact_relationship`
      * answers exactly that.
      *
      * Called rather than restated: the gate uses this function too, so the
      * pool and the gate cannot drift. The cost is a function call per
      * candidate row on a read that runs when somebody opens a screen, which
      * is the right place to spend it.
      */
     and crm.relationship_admits_reengagement(crm.contact_relationship(l.contact_id))
   order by t.tier desc,
            greatest(
              l.created_at,
              coalesce(act.last_at, l.created_at),
              coalesce(msg.last_at, l.created_at)
            ) desc,
            c.phone asc,
            l.id asc
   limit greatest(coalesce(p_limit, 500), 0);
end;
$$;

comment on function crm.reactivation_priority(uuid, int) is
  'Ranks reactivation-eligible leads by recorded fact-tiers (G-141, ADM-88): previously_quoted > previously_replied > has_conversation > cold, then most-recently-active first with a stable phone/id tie-break. No numeric score — ADM-88 declines to invent a scoring model. Only leads whose contact holds a granted whatsapp consent row are ranked, and since G-221 only those whose relationship admits re-engagement — the same predicate the enrolment gate uses, so the number an operator plans from is the number they get. An authenticated caller is pinned to its own organization. Read-only: ranks, never enrols, never sends.';

-- One name for one question. `is_contactable` answered two and that ambiguity
-- was the defect; leaving it would leave the next reader a way to ask the
-- wrong one.
drop function if exists crm.relationship_is_contactable(text);
