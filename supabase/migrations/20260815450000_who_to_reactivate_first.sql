-- ═══════════════════════════════════════════════════════════════════════════
-- Who to reactivate first — G-141 / ADM-88.
--
-- Reactivation runs on a chosen few (G-140). This decides, among the eligible,
-- WHO to enrol first — and it does so from RECORDED FACTS, not a made-up score.
-- The repository has no approved scoring model and ADM-88 declines to invent
-- one: no numeric weight, no tunable coefficients. Instead a deterministic
-- fact-tier order the owner chose:
--
--   4  previously_quoted   — a proposal was sent to the lead
--   3  previously_replied  — the lead sent an inbound ('client') message
--   2  has_conversation    — a thread exists, but they never replied
--   1  cold                — no meaningful prior engagement
--
-- Within a tier, most-recently-active first (the greatest of the lead's last
-- activity, its last message, and its creation), then a STABLE tie-break on
-- phone then lead id so the order never wobbles between runs.
--
-- Two safety properties are enforced in the query itself, not left to the
-- caller — because ADM-87 requires exactly this:
--   · CONSENT FIRST. Only leads whose contact holds a GRANTED whatsapp consent
--     row are ranked at all. An unknown/withdrawn-consent lead is not "low
--     priority", it is ABSENT — it can never enter an outbound queue by ranking
--     highly, because it never appears.
--   · TENANT-SAFE. An authenticated caller is pinned to its own organization;
--     the org parameter is honoured only for the identity-less service role.
--
-- Read-only and side-effect-free: this ranks, it never enrols and never sends.
-- Deduplication is an import-time concern (the importer keys on phone); this
-- assumes the leads it reads are already deduplicated.
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- An authenticated caller may only rank its OWN tenant; the identity-less
  -- service role may name any org (jobs, and this file's own verification).
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
    -- Consent-eligibility, as an INNER join: no granted whatsapp row, no place
    -- in the ranking at all.
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
          select 1 from crm.conversation_messages cm
            join crm.conversations cv on cv.id = cm.conversation_id
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
   order by t.tier desc, last_active_at desc, c.phone nulls last, l.id
   limit greatest(p_limit, 0);
end;
$$;

comment on function crm.reactivation_priority(uuid, int) is
  'Ranks reactivation-eligible leads by recorded fact-tiers (G-141, ADM-88): previously_quoted > previously_replied > has_conversation > cold, then most-recently-active first with a stable phone/id tie-break. No numeric score - ADM-88 declines to invent a scoring model. Only leads whose contact holds a granted whatsapp consent row are ranked; an unknown/withdrawn-consent lead never appears, so it cannot enter an outbound queue by ranking highly. An authenticated caller is pinned to its own organization; the org parameter is honoured only for the service role. Read-only: ranks, never enrols, never sends.';

revoke all on function crm.reactivation_priority(uuid, int) from public, anon;
grant execute on function crm.reactivation_priority(uuid, int) to authenticated, service_role;

notify pgrst, 'reload schema';
