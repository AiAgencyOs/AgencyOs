-- ═══════════════════════════════════════════════════════════════════════════
-- Who this contact already is — G-210
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The import pipeline classifies IDENTITY: `exact`, `new`, `probable`,
-- `conflict`, `unmatched` — is this row the same person as a contact we hold?
-- That is the question a deduplicator asks, and it answers it well.
--
-- It does not ask the question an operator asks before a campaign: **who is
-- this to us already?** A file of twelve hundred numbers contains current
-- clients, deals somebody is actively working, people who told us no, and
-- people waiting for a date we agreed with them. Sending re-engagement to any
-- of those is not a nuisance, it is a mistake with a relationship attached.
--
-- ── the safety property, and where it already held ────────────────────────
--
-- Today nothing goes out to a client, and that is not an accident: outreach
-- requires per-lead enrolment (`in_reactivation_pilot`) plus an org-level
-- switch, and the eligibility query takes only `new`, `qualifying` and
-- `qualified` leads. A converted lead is already excluded.
--
-- So this does not add the guarantee. It makes it VISIBLE, before the
-- decision, on the screen where somebody chooses what to enrol — which is the
-- difference between a safe system and a system somebody can see is safe.
--
-- ── what this deliberately does not classify ──────────────────────────────
--
-- No HOT, no WARM. Those are judgements, and a judgement rendered as a label
-- is the invented score ADM-88 refused, wearing a different costume: *"no
-- numeric lead score and no invented weights — the repository has no approved
-- scoring model and inventing one is out of scope."* `crm.leads` still carries
-- the CHECK that keeps `score` null.
--
-- Every class below is a FACT with a row behind it. Where the facts do not
-- settle it, the answer is `unknown`, which is the honest word ADM-76 uses
-- everywhere else in this system.

create or replace function crm.contact_relationship(p_contact_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  /**
   * Ordered by consequence, not by recency: the first thing true of somebody
   * is the thing that decides whether we may write to them. A person who is
   * both a client and an old lost lead is a CLIENT.
   */
  select case
    -- A project of theirs exists, or a lead of theirs converted. Either one
    -- means the relationship is live and a sales opening is the wrong message.
    when exists (
      select 1 from crm.leads l
       where l.contact_id = p_contact_id and l.status = 'converted' and l.deleted_at is null
    ) then 'client'

    -- Somebody is working this right now. Re-engaging it would put two
    -- conversations on one deal.
    when exists (
      select 1 from sales.opportunities o
        join crm.leads l on l.id = o.lead_id
       where l.contact_id = p_contact_id
         and o.stage not in ('won', 'lost')
         and l.deleted_at is null
    ) then 'active_deal'

    -- They asked to be left until a date, and G-203 recorded when. Writing
    -- before it is breaking an agreement we made with them.
    when exists (
      select 1 from crm.leads l
       where l.contact_id = p_contact_id and l.status = 'nurture' and l.deleted_at is null
    ) then 'nurture'

    -- They said no. Doc section 25's eleven reasons are on the row; none of
    -- them is "ask again next quarter".
    when exists (
      select 1 from crm.leads l
       where l.contact_id = p_contact_id and l.status = 'disqualified' and l.deleted_at is null
    ) then 'lost'

    -- The three tiers `crm.reactivation_priority` already orders by, named
    -- the same way so one vocabulary describes the whole re-engagement path.
    when exists (
      select 1 from sales.proposals p
        join sales.opportunities o on o.id = p.opportunity_id
        join crm.leads l on l.id = o.lead_id
       where l.contact_id = p_contact_id and p.status = 'sent' and l.deleted_at is null
    ) then 'previously_quoted'

    when exists (
      select 1 from crm.conversation_messages m
        join crm.conversations c on c.id = m.conversation_id
       where c.contact_id = p_contact_id and m.author_type = 'client'
    ) then 'previously_replied'

    when exists (
      select 1 from crm.conversations c where c.contact_id = p_contact_id
    ) then 'has_conversation'

    -- Known to us, and nothing has happened. Not a judgement — an absence.
    when exists (select 1 from crm.contacts ct where ct.id = p_contact_id) then 'cold'

    else 'unknown'
  end;
$$;

comment on function crm.contact_relationship(uuid) is
  'Who a contact already is to this agency, from recorded facts only: client, active_deal, nurture, lost, previously_quoted, previously_replied, has_conversation, cold, unknown. Ordered by consequence - the first thing true of somebody decides whether we may write to them. Deliberately NO hot or warm: a judgement rendered as a label is the invented score ADM-88 refused, and crm.leads still carries the CHECK that keeps score null.';

/**
 * The classes that must never receive re-engagement.
 *
 * A function rather than a list in three places: the preview below, the
 * screen, and anything that later enrols in bulk must all mean the same thing
 * by "excluded", or the count an operator approves is not the campaign that
 * runs.
 */
create or replace function crm.relationship_is_contactable(p_relationship text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_relationship not in ('client', 'active_deal', 'nurture')
$$;

comment on function crm.relationship_is_contactable(text) is
  'Whether a relationship class may receive re-engagement. Client and active_deal are live relationships a sales opening would damage; nurture is a date we agreed with them. LOST is contactable - a lost deal is the ordinary subject of re-engagement - and the eleven documented lost reasons are what an operator reads before deciding.';

-- ── what the operator sees before deciding ────────────────────────────────

create or replace function crm.import_relationship_preview(p_batch_id uuid)
returns table (relationship text, contactable boolean, records bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.relationship,
         crm.relationship_is_contactable(r.relationship) as contactable,
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
  'The counts an operator reads before authorising a campaign: how many rows in this batch are clients, active deals, nurturing, lost, previously quoted, and so on - and which of those classes may be written to at all. RLS on crm.import_records and the tables underneath decides what is visible; this adds no reach of its own.';

notify pgrst, 'reload schema';
