-- ═══════════════════════════════════════════════════════════════════════════
-- One *open* deal per lead, held where a second click cannot dodge it.
--
-- Audit finding D21, and the same shape as D9 one table along.
-- createOpportunity already means to be idempotent — it reads
-- sales.opportunities by lead_id and returns the existing deal if it finds one
-- — but that read and the insert that follows are two statements with a gap,
-- and nothing in the database held the rule. sales.opportunities carried only a
-- NON-unique index on lead_id (20260807120005_sales.sql:37).
--
-- Two clicks on "Open deal", or a double-submitted form, both read nothing and
-- both insert. What follows is not merely a duplicate row:
--
--   The lead page reads one deal and renders it, so the second is invisible
--   while still being counted by anything that aggregates.
--
--   Each deal can be won and converted independently, and
--   projects_opportunity_key is keyed on the *opportunity*, so it permits both
--   — two projects and two client accounts for one prospect, which is exactly
--   the outcome D9 exists to prevent, reached by the door D9 did not cover.
--
-- ── Why `open`, and not simply one deal per lead ──────────────────────────
--
-- The first draft of this index had no stage predicate. It would have closed
-- the race just as well, and it would have cemented a rule the rest of the
-- product contradicts.
--
-- The race is between two inserts that are both `stage = 'discovery'`, because
-- that is the only stage createOpportunity ever inserts. Excluding settled
-- deals therefore costs the fix nothing: when a lead already has a won or lost
-- deal, the pre-check finds it and returns it, so there is no concurrent insert
-- to lose.
--
-- What the broader version would have cost is a returning client.
-- `leads_source_ref_key` keys a lead on (organization_id, source, source_ref)
-- with no soft-delete predicate, and crm.ingest_whatsapp_message resolves one
-- lead per `wa:<phone>` permanently — "every message from one number continues
-- one lead rather than opening a new one per message". So a client who comes
-- back a year later lands on the same lead, and under a rule of one-deal-ever
-- could never have a second engagement recorded.
--
-- The only alternative that rule leaves is reopening the settled deal in place,
-- and that path is not currently sound: `value_minor`, `name` and
-- `expected_close_on` are written once at insert with no update anywhere in the
-- module, and `closed_at` / `lost_reason` are never cleared on `lost →
-- discovery`. A deal lost at one value and re-won at another would convert into
-- a project budgeted at the old one.
--
-- So the schema holds the part that must hold under concurrency — no two open
-- deals on one lead — and the application keeps the part that is policy, where
-- changing it costs an edit rather than a migration.
--
-- Stated precisely, because the difference is easy to overstate: this does not
-- *enable* a second engagement today. `createOpportunity`'s pre-check has no
-- stage filter, so a click on a lead whose only deal is lost still hands back
-- that lost deal rather than raising a new one (gap G-088). What the narrowing
-- buys is only that the prohibition is not made permanent in DDL — the day
-- somebody decides a returning client should get a fresh deal, it is an edit
-- to one function rather than a migration against live data.
--
-- One consequence worth naming: reopening a settled deal, `lost → discovery`,
-- can now collide with this index when the lead has since acquired another
-- open deal. `setOpportunityStage` recognises it by name and says so, rather
-- than reporting a generic failure.
--
-- Partial on `lead_id is not null` for intent rather than for correctness —
-- Postgres already lets a unique index hold many nulls. It says out loud that
-- a deal raised without a lead is a real thing. It does *not* claim that
-- `on delete set null` frees the slot in practice: nothing in the application
-- hard-deletes a lead, only soft-deletes it, so that path is theoretical.
--
-- No table, column or constraint is added, altered or dropped.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Refuse legibly on a database that has already raced ───────────────────
--
-- CREATE UNIQUE INDEX on existing duplicates fails with "Key (lead_id)=(…) is
-- duplicated" and nothing else — and that is exactly the population this
-- migration exists for. Worse, supabase/_bundle.sql wraps every migration in
-- one transaction, so a single raced pair would roll back the whole install
-- with a message that names neither the cause nor the remedy.
--
-- Which duplicate should survive is a judgement — the deals may carry
-- different values, owners and stages — so this does not choose. It stops with
-- the affected lead ids and says what to do, which is the difference between a
-- migration that failed and a migration nobody can act on.
do $$
declare
  v_leads text;
begin
  select string_agg(distinct o.lead_id::text, ', ')
    into v_leads
    from sales.opportunities o
   where o.lead_id is not null
     and o.stage not in ('won', 'lost')
   group by o.lead_id
  having count(*) > 1;

  if v_leads is not null then
    raise exception
      'D21: these leads already carry more than one open deal: %. '
      'Decide which survives and settle or delete the others, then re-run. '
      'They cannot be merged automatically: the deals may differ in value, '
      'owner and expected close date.', v_leads;
  end if;
end;
$$;

create unique index if not exists opportunities_open_lead_key
  on sales.opportunities (lead_id)
  where lead_id is not null and stage not in ('won', 'lost');

comment on index sales.opportunities_open_lead_key is
  'One OPEN deal per lead. Settled deals are excluded so a returning client — who lands on the same lead, because WhatsApp ingest keys a lead to a phone number permanently — can have a second engagement. createOpportunity still returns any existing deal whatever its stage; that part is policy and lives in the application.';
