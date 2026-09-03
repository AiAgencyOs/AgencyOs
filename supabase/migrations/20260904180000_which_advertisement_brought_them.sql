-- ═══════════════════════════════════════════════════════════════════════════
-- Which advertisement brought them — G-204 (Doc 09 §3 and §4, audit LC-A)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- §3 asks for campaign and ad metadata and the landing or source URL "where
-- available"; §4 lists campaign information among a lead's minimum fields.
-- Neither had a column, and `crm.leads.source` said `whatsapp` for every lead
-- that ever arrived.
--
-- For an agency whose leads come from Facebook advertising, that is the
-- difference between knowing WhatsApp brought them and knowing WHICH
-- ADVERTISEMENT did — which is the difference between a marketing budget with
-- a feedback loop and one without.
--
-- ── the data exists, and was being thrown away at the door ────────────────
--
-- A Click-to-WhatsApp ad delivers a `referral` block on the first message:
-- the source type, the ad or post id, the URL the person came from, and the
-- ad's own headline. `parseDelivery` dropped all of it.
--
-- So nothing here is inferred or asked of a model. It is Meta's own field,
-- carried the last few inches it was never carried.
--
-- ── first touch, and frozen ───────────────────────────────────────────────
--
-- A lead may click a second advertisement later. The question these columns
-- answer is "what brought them", so the FIRST referral is the answer and a
-- later one does not overwrite it — enforced at the row rather than left to
-- the caller, because the caller is a webhook that runs concurrently with
-- itself.
--
-- ── and what is NOT recorded ──────────────────────────────────────────────
--
-- `ctwa_clid`, Meta's click identifier. It is a per-click tracking token tied
-- to an individual, it answers no question this agency has asked, and §3 asks
-- for campaign metadata rather than for everything the envelope carries.
-- Storing an identifier because it arrived is how a CRM accumulates data
-- nobody can say the purpose of.

alter table crm.leads
  add column if not exists campaign_source_type text
    check (campaign_source_type is null or campaign_source_type in ('ad', 'post')),
  add column if not exists campaign_source_id text
    check (campaign_source_id is null or length(btrim(campaign_source_id)) between 1 and 120),
  add column if not exists campaign_source_url text
    check (campaign_source_url is null or length(btrim(campaign_source_url)) between 1 and 2000),
  add column if not exists campaign_headline text
    check (campaign_headline is null or length(btrim(campaign_headline)) between 1 and 300);

comment on column crm.leads.campaign_source_id is
  'Meta''s ad or post id from the Click-to-WhatsApp referral block, recorded on FIRST contact and frozen. The answer to "which advertisement brought them", which crm.leads.source could only ever answer with "whatsapp".';

comment on column crm.leads.campaign_source_url is
  'Doc 09 section 3''s "landing or source URL where available" - the URL the person came from, as Meta reported it. Never composed, never guessed.';

create index if not exists leads_campaign_idx
  on crm.leads (organization_id, campaign_source_id)
  where campaign_source_id is not null;

-- ── first touch wins, at the row ──────────────────────────────────────────

create or replace function crm.the_first_advertisement_is_the_answer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Only ever set from null. A lead who clicks a second advertisement has not
  -- changed what brought them, and the webhook that would write it runs
  -- concurrently with itself — so this is the rule rather than a caller's
  -- good behaviour.
  if old.campaign_source_id is not null
     and new.campaign_source_id is distinct from old.campaign_source_id then
    raise exception 'which advertisement brought this lead is a record of what happened, and does not change'
      using errcode = 'restrict_violation';
  end if;

  -- A source id with nothing to open is half a record. Both, or neither.
  if new.campaign_source_id is not null and new.campaign_source_type is null then
    raise exception 'a campaign source must say whether it was an ad or a post'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists the_first_advertisement_is_the_answer on crm.leads;
create trigger the_first_advertisement_is_the_answer
  before update on crm.leads
  for each row execute function crm.the_first_advertisement_is_the_answer();

comment on function crm.the_first_advertisement_is_the_answer() is
  'Doc 09 section 3''s campaign metadata, recorded on first contact and frozen: a lead who clicks a second advertisement has not changed what brought them. Enforced at the row because the writer is a webhook that runs concurrently with itself.';

notify pgrst, 'reload schema';
