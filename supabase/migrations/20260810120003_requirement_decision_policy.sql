-- ═══════════════════════════════════════════════════════════════════════════
-- The approval gate, enforced by the database as well as the application.
--
-- crm.requirement_versions_update gated on core.can_write(), which is
-- owner, ops_admin, delivery_lead and member. The capability the application
-- requires to decide a proposal is `lead.write`, which only owner and
-- ops_admin hold (src/lib/authz/permissions.ts).
--
-- Those two disagreed, and the database's answer is the one that counts. The
-- crm schema is exposed through PostgREST, and a signed-in user's browser holds
-- both the publishable key and their own session token — so a delivery_lead or
-- member could PATCH crm.requirement_versions directly and approve a
-- requirement set without ever reaching decideRequirementVersion, its
-- capability check, or its audit write.
--
-- ARCHITECTURE.md §6.1 makes approval the control plane: no agent may commit an
-- action that alters approved scope without a recorded human approval. A gate
-- two of the four internal roles can walk around, leaving no audit row behind,
-- is not a control plane. This closes it.
--
-- Scope is deliberately narrow. Only the UPDATE policy changes. INSERT still
-- allows any writer, because authoring a requirement version (`source =
-- 'human'`) is ordinary CRM work and is not a decision — the guard trigger
-- keeps a new row from arriving pre-accepted only insofar as status is
-- checked, and a human-authored proposal still has to be decided by somebody
-- who may decide. SELECT is untouched: reading a proposal is not approving one.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the role tier the capability model already draws ───────────────────────
--
-- Named for the tier rather than for this one table, matching core.is_owner,
-- core.is_internal and core.can_write. It is the exact set that holds
-- `lead.write` today; tests/requirement-proposal.test.ts pins the two together
-- so they cannot drift apart silently again.
create or replace function core.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select core.current_user_role() in ('owner', 'ops_admin');
$$;

comment on function core.is_admin() is
  'Owner or ops_admin — the roles the capability model grants approval rights to. Distinct from core.can_write(), which also admits delivery_lead and member.';

-- ── the policy ─────────────────────────────────────────────────────────────
--
-- Same shape as before, one predicate stricter. Organization scoping is
-- unchanged and still first: a decision is refused across tenants before the
-- role is considered at all.
drop policy if exists requirement_versions_update on crm.requirement_versions;
create policy requirement_versions_update on crm.requirement_versions
  for update to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));
