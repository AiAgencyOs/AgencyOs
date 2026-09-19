-- ═══════════════════════════════════════════════════════════════════════════
-- Figma is recorded, not claimed.
--
-- Designer §8 and §24; Master §20. A token now exists, and the honest
-- question is what a token actually changes.
--
-- ── what it does NOT change ───────────────────────────────────────────
--
-- **A designer still designs.** §24: *"do not claim automated editing if the
-- actual integration only supports assisted/manual steps."* Figma's REST API
-- reads files; it does not compose a visual direction. The assisted step —
-- a person creates the frame and pastes its reference — stays exactly as it
-- was, and nothing here will ever report that AgencyOS made a Figma file.
--
-- ── what it does change ───────────────────────────────────────────────
--
-- Three things, each of which was previously an act of faith:
--
--   **The reference can be checked.** A pasted file key and node id either
--   resolve against the real file or they do not. Before, a typo was
--   indistinguishable from a correct reference until Phase 4 opened it.
--
--   **The version comes from Figma.** §8 requires the version association
--   between preview and artifact to be preserved, and a human typing a
--   version string is recording what they believed. The provider reads the
--   file's own `version`.
--
--   **A revoked token is visible.** §24 asks for permission errors and
--   revoked tokens to be detected and handled. Unverified-because-nobody-
--   tried and unverified-because-the-token-was-rejected are different states,
--   and only one of them is somebody's job to fix.
--
-- ── the rule this migration exists for ────────────────────────────────
--
-- §24: *"Do not silently replace a Figma file/node and reuse the same version
-- identifier."*
--
-- That is not a warning about carelessness. A version identifier is what
-- Phase 4 opens and what the handoff promises; pointing it at different
-- artwork while the version stays the same makes every record that cites it
-- wrong at once, including ones a client already approved. So changing the
-- file or the node **while keeping the version** is refused at the door.
--
-- Changing both is fine — that is a new artifact honestly described.
-- Clearing the version and re-linking is fine — that is saying "this is
-- different and I do not know its version yet". What cannot happen is the
-- artifact moving underneath a version that stays still.
--
-- ── and verification is recorded separately from the reference ────────
--
-- `figma_verified_at` is not the same fact as `figma_linked_at`. A reference
-- that was pasted and never checked, and one that was checked and matched,
-- look identical in a column that only records when somebody typed. The
-- handoff can then say which it is.
--
-- G-281 is fixed here too: `link_theme_figma` read `not (select
-- core.can_write())`, which is NULL for a role-less token and therefore fails
-- open. The same reasoning as G-300 — this unit replaces the function.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.theme_options
  add column if not exists figma_verified_at timestamptz;

alter table projects.theme_options
  add column if not exists figma_node_name text
    check (figma_node_name is null or length(btrim(figma_node_name)) between 1 and 300);

comment on column projects.theme_options.figma_verified_at is
  'Designer section 24. When the reference was last CHECKED against the real file - a different fact from figma_linked_at, which is when somebody typed it. A reference pasted and never checked and one checked and matched look identical in a column that only records typing.';

comment on column projects.theme_options.figma_node_name is
  'What the node is actually called in Figma, read from the file. Recorded so a person can see they linked the frame they meant: a node id is not something anybody recognises by eye.';

-- ── the door, with §24's rule ───────────────────────────────────────────

create or replace function projects.link_theme_figma(
  p_theme_option_id uuid,
  p_file_key        text,
  p_node_id         text,
  p_page_id         text default null,
  p_figma_version   text default null,
  p_preview_url     text default null,
  -- Set only by the verifier, which read them from Figma itself. A caller
  -- pasting a reference by hand leaves them null and the row records that it
  -- is unverified — which is the truth.
  p_verified        boolean default false,
  p_node_name       text default null
)
returns table (
  -- 'linked' | 'unknown_option' | 'incomplete_reference' | 'version_reused'
  -- | 'no_actor' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.theme_options;
  v_file  text := btrim(coalesce(p_file_key, ''));
  v_node  text := btrim(coalesce(p_node_id, ''));
  v_ver   text := nullif(btrim(coalesce(p_figma_version, '')), '');
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if v_file = '' or v_node = '' then
    return query select 'incomplete_reference'::text; return;
  end if;

  select t.* into v_row from projects.theme_options t where t.id = p_theme_option_id for update;
  if v_row.id is null then
    return query select 'unknown_option'::text; return;
  end if;

  -- G-281: `not NULL` is NULL and plpgsql's `if` does not execute it, so an
  -- uncoalesced guard fails OPEN for a token with an organisation and no role.
  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;

  -- §24's rule. The artifact must not move underneath a version that stays
  -- still: a version identifier is what Phase 4 opens and what the handoff
  -- promises, and repointing it makes every record citing it wrong at once —
  -- including ones a client already approved.
  --
  -- Only bites when a version is actually being carried forward. Changing
  -- both is a new artifact honestly described; clearing the version is saying
  -- "this is different and I do not know its version yet".
  if v_row.figma_version is not null
     and v_ver is not distinct from v_row.figma_version
     and (v_file is distinct from v_row.figma_file_key
          or v_node is distinct from v_row.figma_node_id) then
    return query select 'version_reused'::text; return;
  end if;

  update projects.theme_options
     set figma_file_key  = v_file,
         figma_node_id   = v_node,
         figma_page_id   = nullif(btrim(coalesce(p_page_id, '')), ''),
         figma_version   = v_ver,
         preview_asset_url = nullif(btrim(coalesce(p_preview_url, '')), ''),
         figma_linked_at = now(),
         figma_linked_by = v_actor,
         -- A re-link is unverified until it is verified again. Carrying the
         -- old timestamp forward would say the NEW reference had been checked.
         figma_verified_at = case when p_verified then now() else null end,
         figma_node_name = case when p_verified
           then nullif(btrim(coalesce(p_node_name, '')), '') else null end
   where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'theme_option.figma_linked', 'theme_option', v_row.id,
    jsonb_build_object('figmaFileKey', v_row.figma_file_key, 'figmaNodeId', v_row.figma_node_id,
                       'figmaVersion', v_row.figma_version),
    jsonb_build_object('figmaFileKey', v_file, 'figmaNodeId', v_node,
                       'figmaVersion', v_ver, 'verified', p_verified)
  );

  return query select 'linked'::text;
end;
$$;

comment on function projects.link_theme_figma(uuid, text, text, text, text, text, boolean, text) is
  'Designer sections 8 and 24. Records the canonical reference; it never creates one. REFUSES A SILENT SWAP: changing the file or the node while keeping the same version identifier is version_reused, because a version is what Phase 4 opens and what the handoff promises, and repointing it makes every record citing it wrong at once - including ones a client already approved. Changing both is fine, and clearing the version is fine. A re-link resets figma_verified_at to null: carrying the old timestamp forward would say the NEW reference had been checked.';

revoke all on function projects.link_theme_figma(uuid, text, text, text, text, text, boolean, text) from public, anon;
grant execute on function projects.link_theme_figma(uuid, text, text, text, text, text, boolean, text) to authenticated;

-- The old six-argument signature would otherwise linger as a second door with
-- none of the rules above.
drop function if exists projects.link_theme_figma(uuid, text, text, text, text, text);

notify pgrst, 'reload schema';
