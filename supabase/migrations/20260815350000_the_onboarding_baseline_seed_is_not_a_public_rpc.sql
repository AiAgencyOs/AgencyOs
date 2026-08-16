-- ═══════════════════════════════════════════════════════════════════════════
-- The onboarding-baseline seed is internal infrastructure, not a public RPC.
--
-- projects.install_default_onboarding_baseline(p_organization_id) is SECURITY
-- DEFINER, writes projects.onboarding_baseline with the org it is HANDED, and
-- does not validate that org against the caller — but it was granted to PUBLIC.
-- Its only legitimate caller is the DEFINER trigger install_baseline_for_new_org,
-- which seeds a new organization's checklist on INSERT. The PUBLIC grant made it
-- a caller-supplied-tenant write reachable over the Data API: any authenticated
-- user could call it with ANOTHER organization's id and re-insert the default
-- items a victim admin had removed from their own baseline (`a list the admin can
-- change`, 20260814120012), quietly undoing that customization
-- (`on conflict do nothing` keeps it to re-adding the removed rows).
--
-- The caller-scoping clause the finance reads use — `current_organization_id() is
-- null OR = p_organization_id` — does NOT fit here: the seed is called for a NEW
-- org whose id is never the creator's current organization (an existing admin
-- creating a second org has current_organization_id() = their FIRST org), so the
-- clause would refuse the legitimate seed. The correct boundary is that this is
-- not an end-user RPC at all: revoke it from PUBLIC. The trigger runs SECURITY
-- DEFINER as the owner, which keeps EXECUTE, so seeding a new org is unaffected;
-- a direct Data-API call by an authenticated (or anon) user is now refused.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function projects.install_default_onboarding_baseline(uuid) from public;
revoke execute on function projects.install_default_onboarding_baseline(uuid) from anon, authenticated;
