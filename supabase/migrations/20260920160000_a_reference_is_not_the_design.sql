-- ═══════════════════════════════════════════════════════════════════════════
-- A reference is not the design — G-308, ADM-111.
--
-- Designer §9's Image Generation Policy: "optional support, not the default
-- design workflow" — an illustration, reference, texture, mood-board element
-- or visual asset, never "a whole fake app screenshot ... treated as the
-- Phase 3 source of truth." Master §5 repeats it as canon: "screenshots or
-- generated images must never replace the underlying Figma artifact." This
-- table exists to hold exactly that, and the same guardrail `theme_options`
-- already carries for `preview_asset_url` applies here by construction: there
-- is no Figma column on this table to confuse for one.
--
-- ── the reuse key, reused rather than reinvented ──────────────────────────
--
-- §18's "same visual regenerated repeatedly" cost risk is the same one
-- `theme_options` was built against (20260918160000): `source_context_version`
-- is `projects.design_context_version(project_id)`, already written and
-- already the reuse key the whole design-directions workflow keys off. One
-- reference asset per project per context version — a changed scope, baseline
-- or client answer earns a new one; nothing else does.
--
-- ── who triggers it (ADM-111) ─────────────────────────────────────────────
--
-- Designer §9 does not say who decides to generate. Raised and answered
-- 2026-09-20: the `ui_designer` agent decides autonomously, inside its
-- existing `design.directions` workflow — not a person clicking a button. The
-- workflow attempts at most ONE generation per run, after directions are
-- written, best-effort: a failed or unconfigured image call never fails the
-- run that proposed the directions, because directions are what Phase 3
-- actually needs and the image is Designer §9's own "optional support."
--
-- ── append-only, admin-invisible-only-until-read ───────────────────────────
--
-- No update policy exists: a reference image is not edited, only regenerated
-- under a new context version, or left alone. Same shape as `audit.audit_log`.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.design_assets (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  project_id               uuid not null references projects.projects(id) on delete cascade,
  phase_three_id           uuid not null references projects.phase_three(id) on delete cascade,

  -- Designer §9's own vocabulary, not invented.
  kind                     text not null default 'mood_board'
                              check (kind in ('illustration', 'reference', 'texture', 'mood_board', 'visual_asset')),

  prompt                   text not null check (length(btrim(prompt)) between 1 and 4000),
  image_base64             text not null check (length(image_base64) > 0),
  media_type               text not null check (media_type in ('image/png', 'image/jpeg', 'image/webp')),
  model                    text not null check (length(btrim(model)) > 0),

  -- §9's "preserve asset/source linkage and usage rights metadata" —
  -- deterministic, not modelled: what generated it and under what terms, not
  -- a field a caller can override with a claim.
  rights_note              text not null,

  -- THE REUSE KEY (§18), same function `theme_options` already keys off.
  source_context_version   text not null check (length(btrim(source_context_version)) > 0),

  -- Which run produced it — §9's traceability, and ai.agent_runs already
  -- carries the model, the cost and the moment. No `created_by`: no person
  -- drew this, the same rule G-303 states for an agent-authored theme option.
  run_id                   uuid references ai.agent_runs(id) on delete set null,

  created_at               timestamptz not null default now(),

  -- §18's idempotency for this table: same project, same inputs, one asset.
  unique (project_id, source_context_version)
);

create index if not exists design_assets_project_idx
  on projects.design_assets (organization_id, project_id, source_context_version);

comment on table projects.design_assets is
  'Designer section 9 - AI-generated reference imagery (illustration/reference/texture/mood-board/visual asset), optional support for the design workflow and NEVER a canonical artifact. UNIQUE on (project, source_context_version) is section 18s idempotency, reusing projects.design_context_version() rather than a second hash. No update policy: append-only, regenerated only under a new context version.';

drop trigger if exists org_match_design_assets_project on projects.design_assets;
create trigger org_match_design_assets_project
  before insert or update of project_id, organization_id on projects.design_assets
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_design_assets_phase on projects.design_assets;
create trigger org_match_design_assets_phase
  before insert or update of phase_three_id, organization_id on projects.design_assets
  for each row execute function core.enforce_parent_org('phase_three_id', 'projects.phase_three');

drop trigger if exists org_match_design_assets_run on projects.design_assets;
create trigger org_match_design_assets_run
  before insert or update of run_id, organization_id on projects.design_assets
  for each row execute function core.enforce_parent_org('run_id', 'ai.agent_runs');

drop trigger if exists freeze_org_design_assets on projects.design_assets;
create trigger freeze_org_design_assets
  before update of organization_id on projects.design_assets
  for each row execute function core.freeze_organization_id();

alter table projects.design_assets enable row level security;
alter table projects.design_assets force row level security;

drop policy if exists design_assets_select on projects.design_assets;
create policy design_assets_select on projects.design_assets
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.design_assets to authenticated, service_role;

-- ── the event ────────────────────────────────────────────────────────────

insert into core.event_types (type, description, canonical) values
  ('project.design_asset_generated',
   'Designer section 9 - an optional reference/mood-board image exists for a design context version. Never implies a canonical design artifact.',
   true)
on conflict (type) do nothing;

-- ── the door ─────────────────────────────────────────────────────────────
--
-- Written with the service-role escape from the start (G-303's lesson, not
-- rediscovered): the trigger is `design.directions`' own run, which is the
-- service role, and a person has no reason to call this directly — there is
-- no form that accepts an image, on the same rule ADM-84 §9 held for secrets
-- and never revisited for pixels. If that ever changes, the actor path this
-- already carries (`v_actor is not null`) is what a person's call would use.

create or replace function projects.record_design_asset(
  p_project_id     uuid,
  p_kind           text,
  p_prompt         text,
  p_image_base64   text,
  p_media_type     text,
  p_model          text,
  p_run_id         uuid default null
)
returns table (
  -- 'recorded' | 'already_recorded' | 'no_phase_three' | 'no_baseline' | 'no_actor' | 'forbidden'
  outcome           text,
  design_asset_id   uuid,
  context_version   text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_context  text;
  v_existing projects.design_assets;
  v_new      uuid;
  v_baseline int;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::text; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.project_id = p_project_id
   for update;

  if v_phase3.id is null then
    return query select 'no_phase_three'::text, null::uuid, null::text; return;
  end if;

  if v_actor is not null
     and (v_phase3.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::text; return;
  end if;

  select count(*) into v_baseline
    from projects.screen_baselines sb
   where sb.project_id = p_project_id and sb.status = 'finalized';

  if v_baseline = 0 then
    return query select 'no_baseline'::text, null::uuid, null::text; return;
  end if;

  v_context := projects.design_context_version(p_project_id);

  select d.* into v_existing
    from projects.design_assets d
   where d.project_id = p_project_id
     and d.source_context_version = v_context;

  if v_existing.id is not null then
    return query select 'already_recorded'::text, v_existing.id, v_context; return;
  end if;

  insert into projects.design_assets (
    organization_id, project_id, phase_three_id, kind, prompt, image_base64,
    media_type, model, rights_note, source_context_version, run_id
  ) values (
    v_phase3.organization_id, p_project_id, v_phase3.id,
    coalesce(nullif(btrim(p_kind), ''), 'mood_board'),
    btrim(p_prompt), p_image_base64, p_media_type, btrim(p_model),
    'AI-generated by ' || btrim(p_model) || ' via OpenRouter — reference only, not licensed stock or a client-supplied asset. Not the canonical design artifact (Designer section 9, Master section 5).',
    v_context, p_run_id
  )
  returning id into v_new;

  perform core.record_audit(
    v_phase3.organization_id, 'project.design_asset_generated', 'design_asset', v_new, null,
    jsonb_build_object('projectId', p_project_id, 'contextVersion', v_context, 'model', btrim(p_model))
  );

  perform core.emit_event(
    v_phase3.organization_id, 'project.design_asset_generated', 'design_asset', v_new,
    jsonb_build_object('projectId', p_project_id, 'contextVersion', v_context)
  );

  return query select 'recorded'::text, v_new, v_context;
end;
$$;

comment on function projects.record_design_asset(uuid, text, text, text, text, text, uuid) is
  'Designer section 9. Records ONE reference/mood-board image against the current design context version — the same reuse key theme_options uses. A replay with the same context answers already_recorded rather than storing a second image. Refuses before a screen baseline is finalized (no_baseline), same start condition as record_theme_option. Carries the service-role escape from the start (G-303): design.directions calls this as the agent, and a person has no form that accepts an image.';

revoke all on function projects.record_design_asset(uuid, text, text, text, text, text, uuid) from public, anon;
grant execute on function projects.record_design_asset(uuid, text, text, text, text, text, uuid) to authenticated, service_role;
