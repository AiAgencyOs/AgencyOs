-- The recall names its tenant — G-189.
--
-- ── the defect, reproduced before it was fixed ────────────────────────────
--
-- `ai.recall` is SECURITY INVOKER and filters by scope, never by
-- organization: **RLS is its tenancy**, which is correct for a signed-in
-- caller and is the reason it must not become a definer.
--
-- The two organization-scoped callers are not signed in. `pricingDecisionsFor`
-- (G-180) and `revisionCorrectionsFor` (G-185) run inside the job runner with
-- the **service role**, which bypasses RLS — so `recall` hands them every
-- organization's memories and a `.filter()` in TypeScript is what keeps
-- another agency's decisions out of this agency's drafting prompt.
--
-- That filter works. What it cannot fix is the LIMIT, which the database
-- applies **before** the caller ever sees a row:
--
--     ten memories belonging to another agency, one belonging to ours
--     → recall(scope: organization, limit: 8) returns 8 rows
--     → 7 of them are the other agency's, 1 is ours
--
-- Measured on this database, not reasoned about. So on a deployment with a
-- second agency on it, the feature G-180 was built for — *the owner corrects
-- the same mistake and the next draft knows* — silently degrades to one
-- decision, and with enough tenants to none at all, while every test and every
-- verification script stays green because the demo deployment has one
-- organization in it.
--
-- ── the fix, and why it is in the database ────────────────────────────────
--
-- The tenant becomes a parameter. When it is given, the filter and the LIMIT
-- are applied in the same statement, in that order, so eight rows means eight
-- of YOURS. When it is null the function behaves exactly as it did — RLS
-- decides, which is what every signed-in caller wants and what the two
-- lead-scoped callers already rely on.
--
-- The TypeScript organization filter goes with it. A rule held in two places
-- is a rule whose test can pass while either half is broken — and the half
-- nobody can see failing is the one that rots.
--
-- ── dropped and recreated, not replaced ───────────────────────────────────
--
-- A fourth parameter with a default would make every existing three-argument
-- call ambiguous rather than resolving it, so the old signature goes. Every
-- caller in this repository passes named arguments, which PostgREST and
-- PostgreSQL both resolve by name.

drop function if exists ai.recall(text, uuid, int);

create or replace function ai.recall(
  p_scope           text,
  p_scope_id        uuid default null,
  p_limit           int  default 50,
  p_organization_id uuid default null
)
returns setof ai.memory_records
language sql
stable
security invoker
set search_path = ''
as $$
  select m.*
    from ai.memory_records m
   where m.scope = p_scope
     and m.scope_id is not distinct from p_scope_id
     -- G-189. Null means "whatever RLS allows", which is what a signed-in
     -- caller wants and how this function behaved before. A service-role
     -- caller has no RLS to rely on and must say whose memories it is asking
     -- for; the filter runs BEFORE the limit below, so eight means eight of
     -- theirs.
     and (p_organization_id is null or m.organization_id = p_organization_id)
     and m.superseded_by is null
     and (m.expires_at is null or m.expires_at > now())
   order by
     -- Doc 05 §18's ordering, as an ordering. What a client actually said
     -- outranks what a process confirmed, which outranks what a model guessed.
     case m.confidence
       when 'explicit'   then 0
       when 'verified'   then 1
       when 'conflicted' then 2
       when 'inferred'   then 3
       when 'temporary'  then 4
       when 'stale'      then 5
       else 6
     end,
     m.created_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function ai.recall(text, uuid, int, uuid) is
  'Relevant memory for one scope, newest first within confidence order - what a client said outranks what a process confirmed, which outranks what a model guessed (Doc 05 §18). Superseded and expired rows are never returned. SECURITY INVOKER: the RLS policy is the authorization, and a definer function here would be a way around it. p_organization_id (G-189) is for the callers that have no RLS to rely on: the job runner reads this with the service role, and without naming its tenant the LIMIT was spent on other organizations rows - eight memories of which seven belonged to another agency, measured. Null keeps the original behaviour exactly.';
