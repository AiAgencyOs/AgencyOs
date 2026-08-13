-- ═══════════════════════════════════════════════════════════════════════════
-- The lead that is not a lead.
--
-- Gap G-117. `projects.projects.lead_id` is a foreign key to **core.users** —
-- the *delivery* lead, a member of staff. Every other `lead_id` in this system
-- is a `crm.leads` reference: `crm.conversations.lead_id`,
-- `crm.lead_activities.lead_id`, `sales.opportunities.lead_id`.
--
-- The intent was never in doubt — the migration that created it carries the
-- inline comment `-- delivery lead`. The name is what misleads, and an inline
-- comment is not visible to somebody reading a query, a report, or a column
-- list.
--
-- ── how it was found ──────────────────────────────────────────────────────
--
-- G-020's first draft checked that a requirement version belonged to the
-- project's engagement by comparing `projects.lead_id` to
-- `crm.conversations.lead_id`. The comparison could never have matched, so
-- **every requirement breakdown would have been refused**. It failed on a
-- foreign key during a smoke test before it could run — luck, not design, and
-- the next person to write that join gets the same trap.
--
-- ── the rename, and why it is safe ────────────────────────────────────────
--
-- Nothing in the application reads it: `grep` over src/ and app/ finds no
-- reference, and the generated types carry it only as a column of the row. The
-- one SQL reader is G-020's `requirement_coverage`, which deliberately goes
-- through `opportunity_id → sales.opportunities.lead_id` instead and does not
-- touch this column at all.
--
-- `alter table ... rename column` preserves the data, the foreign key and the
-- index; it is not a drop-and-add. Postgres rewrites dependent views and
-- constraints itself.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.projects
  rename column lead_id to delivery_lead_id;

comment on column projects.projects.delivery_lead_id is
  'The member of staff leading delivery on this project - a core.users reference. Renamed from lead_id (G-117), which read like the crm.leads reference every other lead_id in this system is, and which G-020''s first draft duly mistook for one. The route to a project''s CRM lead is opportunity_id -> sales.opportunities.lead_id.';
