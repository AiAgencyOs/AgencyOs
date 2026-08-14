-- ═══════════════════════════════════════════════════════════════════════════
-- A list the Admin maintains.
--
-- Gap G-013 (parts 1 and 2), decision ADM-12, as written at
-- docs/business-os/02-business-rules.md §5.3:
--
--   *"AgencyOS may send samples, demos and past work **only from a list the
--   Admin maintains**. The list is empty until the Admin fills it; until then
--   AgencyOS sends nothing from it."*
--
-- ── built from the rule, because the record was wrong ─────────────────────
--
-- ADM-12's entry in `roadmap.json` read *"The table is built; it stays empty"*.
-- No portfolio, sample, demo or catalog table existed in any migration. The
-- claim was corrected on 2026-08-14; this is the table it described.
--
-- That is why every column below is traced to §5.3 rather than to the decision
-- record. The document was always accurate; the record was not, and it is the
-- record that a gap analysis reads — which is how G-013 came to be described
-- as needing only a screen.
--
-- ── what §5.3 gives, and what it does not ─────────────────────────────────
--
-- **`kind` is the rule's own three words.** Samples, demos and past work.
-- Not a taxonomy anybody invented, and not extensible without a decision.
--
-- **`url` is an engineering decision and is labelled as one.** §5.3 says the
-- list holds things AgencyOS may *send*, and does not say what an item is. A
-- catalogue of sendable things whose items cannot be sent would satisfy the
-- schema and not the rule, so an item carries something to send. A URL is the
-- narrowest thing that works on the one channel that exists.
--
-- **`is_active` is an engineering decision and is labelled as one.** §5.3 says
-- the Admin maintains the list. Retiring an item by deletion would erase what
-- was sendable when a past message went out; deactivating keeps the history
-- honest. If the Admin should be able to delete outright, that is a decision
-- nobody has taken and this does not prevent it.
--
-- ── what this deliberately does not do ────────────────────────────────────
--
-- **It seeds nothing.** §5.3 is explicit that the list is empty until the
-- Admin fills it, and ADM-73 established the wider principle: an empty
-- configuration table is not a delivered feature. This ships the table and the
-- screen; the list is not a thing anybody but the Admin can supply, and
-- inventing three plausible portfolio items would be exactly the fabrication
-- ADM-76 refused for qualification dates.
--
-- **It sends nothing.** Selecting an item and putting it in front of a client
-- is G-013 part 3, which needs the agent architecture and — because a sample
-- reaching a client is client communication — ADM-70's consent gate. Neither
-- exists. This is the list, not the sending.
--
-- **It is not added to the audit trigger.** That list is narrow on purpose
-- (G-093/ADM-51), and `audit.record_row_change` raises for any table it has no
-- vocabulary for, so adding one is a two-part change. Worth doing when the
-- sending path exists and a catalogue entry can actually reach a client;
-- premature while nothing reads the table.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.portfolio_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- §5.3's own three words, and no fourth without a decision.
  kind             text not null check (kind in ('sample', 'demo', 'past_work')),

  title            text not null check (length(trim(title)) > 0),
  description      text,

  -- What actually gets sent. See the header: an engineering decision, because
  -- §5.3 does not say what an item is, only that items may be sent.
  url              text not null check (length(trim(url)) > 0),

  -- Retired rather than deleted, so a past send still points at something.
  is_active        boolean not null default true,

  position         int not null default 0 check (position >= 0),

  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table crm.portfolio_items is
  'The list of samples, demos and past work AgencyOS may send (ADM-12, business rules section 5.3). Empty until the Admin fills it, and AgencyOS sends nothing from it until then. Built 2026-08-14 - ADM-12''s decision record had claimed since 2026-08-13 that this table existed, and it did not.';

comment on column crm.portfolio_items.kind is
  'sample, demo or past_work - the three section 5.3 names. A fourth needs a decision, not a migration.';

comment on column crm.portfolio_items.url is
  'What gets sent. An engineering decision recorded in the migration header: section 5.3 says the list holds sendable things and does not say what an item is.';

comment on column crm.portfolio_items.is_active is
  'Whether this item may be sent today. Retiring by deactivation rather than deletion keeps a past send pointing at something. An engineering decision, recorded as one.';

create index if not exists portfolio_items_org_idx
  on crm.portfolio_items (organization_id, kind, position)
  where is_active;

create unique index if not exists portfolio_items_org_url_key
  on crm.portfolio_items (organization_id, url);

-- ── who may read it, and who may change it ───────────────────────────────
--
-- Read is internal, because anything that eventually sends from this list runs
-- as internal. Write is `core.is_admin()`, which is what §5.3 means by "a list
-- the Admin maintains" — the same shape ADM-08b gave approval policies, where
-- the people bound by a rule are not the people who rewrite it.

alter table crm.portfolio_items enable row level security;

drop policy if exists portfolio_items_select on crm.portfolio_items;
create policy portfolio_items_select on crm.portfolio_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists portfolio_items_write on crm.portfolio_items;
create policy portfolio_items_write on crm.portfolio_items
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  );

grant select on crm.portfolio_items to authenticated;
grant insert, update, delete on crm.portfolio_items to authenticated;

-- `updated_at` maintained the way every other table here maintains it.
drop trigger if exists set_updated_at on crm.portfolio_items;
create trigger set_updated_at
  before update on crm.portfolio_items
  for each row execute function core.set_updated_at();
