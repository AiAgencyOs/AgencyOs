-- ═══════════════════════════════════════════════════════════════════════════
-- The words a client reads.
--
-- PM §10 and §11. §11 gives four message templates and then one sentence that
-- shapes the whole unit:
--
--   *"Templates must remain configurable; these are examples, not hard-coded
--   mandatory wording."*
--
-- So the shipped wording is a **default**, not a rule, and an organisation may
-- replace it. What an organisation may **not** do is write a message that
-- breaks §10 — and that is the half worth building, because §10 is ten
-- prohibitions and every one of them is currently prose nobody can enforce.
--
-- ── this is not the WhatsApp template registry, and must not become it ─
--
-- `crm.whatsapp_templates` already exists and is a different thing: it records
-- what **Meta** approved — name, language, parameters, Meta's own status. It
-- holds no body, because Meta holds the body.
--
-- These are the words a PM reads and sends. They are channel-agnostic (§10
-- says English/Hinglish-ready, and §13's channel list is WhatsApp, email or
-- other), and nothing in this repository stored message wording before now.
-- When a channel exists, a step may map to an approved Meta template; that
-- mapping is a later unit and this table stays the source of the wording.
--
-- ── the two prohibitions that become structure ────────────────────────
--
-- §10: *"Never mention internal AI provider/model/API routing."*
-- §10: *"Do not expose raw internal prompts/reasoning."*
--
-- Both are refused at the row. Not because a PM would type "gpt-4o" on
-- purpose, but because a template is written once and sent a hundred times:
-- the cost of the mistake is not one message, and the person who writes the
-- template is not the person who notices. A CHECK cannot be forgotten by
-- whoever edits the wording next.
--
-- §10: *"Do not claim a revision is ready before approved backend state."*
--
-- This one cannot be a CHECK, because it is not about the words — it is about
-- **when** they may be said. So it lives in the render door: a step whose
-- claim the state does not support is refused rather than rendered. Saying
-- *"we have updated the design based on your feedback"* when no revised option
-- has passed Admin is the same lie whichever words carry it.
--
-- §10: *"Do not present rejected/internal-only designs."*
--
-- The option names a message interpolates come **only** from Admin-approved
-- options. A template cannot name a draft even if somebody wanted it to,
-- because the door never puts one in the variable.
--
-- ── an unknown placeholder is refused, not discovered by a client ─────
--
-- A body may only use the five variables this door fills. Without that check,
-- `{{deadline}}` in a template renders as the literal text `{{deadline}}` in
-- front of a client — and the first person to find out is the client.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.design_message_templates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- §11's four, and no fifth. A step nobody has wording for is a step nobody
  -- can announce, which is a visible gap rather than an improvised message.
  step_key         text not null
                     check (step_key in ('phase_three_start', 'theme_review',
                                         'revision_ready', 'final_confirmation')),

  -- §10: "simple English/Hinglish-ready configurable templates."
  language         text not null default 'en' check (language in ('en', 'hinglish')),

  body             text not null check (length(btrim(body)) between 1 and 2000),

  updated_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- One wording per step per language per organisation. An override replaces
  -- the shipped default; it does not stack with it.
  unique (organization_id, step_key, language)
);

comment on table projects.design_message_templates is
  'PM section 11. An ORGANISATION OVERRIDE of the shipped wording - section 11 says the templates are examples, not hard-coded mandatory wording, so the default lives in projects.default_design_message() and a row here replaces it. Distinct from crm.whatsapp_templates, which records what META approved and holds no body because Meta holds the body. Section 10 prohibitions that are about the WORDS are refused here; the one about WHEN the words may be said lives in the render door, because it is not a property of the text.';

create index if not exists design_message_templates_org_idx
  on projects.design_message_templates (organization_id, step_key);

create trigger freeze_org_design_message_templates
  before update of organization_id on projects.design_message_templates
  for each row execute function core.freeze_organization_id();

create trigger design_message_templates_updated_at
  before update on projects.design_message_templates
  for each row execute function core.set_updated_at();

-- ── §10's two wording prohibitions, and the placeholder rule ────────────

create or replace function projects.enforce_design_message_body()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body text := lower(new.body);
  v_bad  text;
begin
  -- §10: "Never mention internal AI provider/model/API routing."
  -- The names are matched on word boundaries: a client-facing message about a
  -- "claude" colour palette is not a routing disclosure, and refusing it would
  -- teach people to work around the check rather than trust it.
  if v_body ~ '\y(openai|anthropic|gpt|claude|gemini|llm|model routing|api key|token limit|prompt)\y' then
    select (regexp_match(v_body,
      '\y(openai|anthropic|gpt|claude|gemini|llm|model routing|api key|token limit|prompt)\y'))[1]
      into v_bad;
    raise exception
      'a client message may not mention internal AI routing (found "%"); PM section 10 forbids naming the provider, the model or the prompt',
      v_bad
      using errcode = 'check_violation';
  end if;

  -- §10: "Do not expose raw internal prompts/reasoning."
  if v_body ~ '\y(system message|chain of thought|reasoning trace|internal note)\y' then
    raise exception
      'a client message may not carry internal reasoning; PM section 10 forbids exposing it'
      using errcode = 'check_violation';
  end if;

  -- An unknown placeholder renders as its own literal text in front of a
  -- client. The door fills exactly five.
  if exists (
    select 1
      from regexp_matches(new.body, '\{\{([a-z_]+)\}\}', 'g') m
     where m[1] not in ('client_name', 'project_name', 'option_names', 'option_count', 'round_number')
  ) then
    raise exception
      'a client message may only use {{client_name}}, {{project_name}}, {{option_names}}, {{option_count}} or {{round_number}}; anything else reaches the client as literal text'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger enforce_design_message_body
  before insert or update of body on projects.design_message_templates
  for each row execute function projects.enforce_design_message_body();

alter table projects.design_message_templates enable row level security;
alter table projects.design_message_templates force row level security;

drop policy if exists design_message_templates_select on projects.design_message_templates;
create policy design_message_templates_select on projects.design_message_templates
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.design_message_templates to authenticated, service_role;

-- ── the shipped wording (PM §11), which is a default and not a rule ─────
--
-- §11's four messages, **verbatim**. An earlier draft of this migration
-- enriched the theme_review one with `{{option_count}} UI options:
-- {{option_names}}` — which read *"We have prepared 1 UI options"* the first
-- time it was driven. Two lessons, and the grammar is the smaller one: §11
-- gives exact wording and rewriting it is not this unit's job. The variables
-- exist so an organisation **can** enrich the message; the default does not
-- presume they want to.

create or replace function projects.default_design_message(p_step_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_step_key
    when 'phase_three_start' then
      'Your project setup is complete. We are now starting the UI finalization stage. '
      || 'We will prepare UI theme and color options for your review.'
    when 'theme_review' then
      'We have prepared the UI options for your project. Please review them carefully and let us '
      || 'know which theme and color direction you prefer. You can also share a reference if you '
      || 'have one.'
    when 'revision_ready' then
      'We have updated the design based on your feedback. Please check the revised option '
      || 'carefully and let us know if anything else needs to be changed.'
    when 'final_confirmation' then
      'Please confirm the selected UI theme and color combination so we can proceed with '
      || 'the complete UI design in the next stage.'
  end;
$$;

comment on function projects.default_design_message(text) is
  'PM section 11 verbatim, as the DEFAULT. Section 11 states these are examples and not mandatory wording, so an organisation row in projects.design_message_templates replaces this. It is recorded here rather than in application code because the words are part of the specification this phase implements.';

-- ── the door ────────────────────────────────────────────────────────────

create or replace function projects.render_design_message(
  p_phase_three_id uuid,
  p_step_key       text,
  p_language       text default 'en'
)
returns table (
  -- 'rendered'   the body, with backend state in it
  -- refusals: 'no_actor' | 'forbidden' | 'unknown_phase' | 'bad_step'
  --           | 'nothing_approved'   theme_review with nothing a client may see
  --           | 'no_revision_ready'  §10: do not claim a revision is ready
  --           | 'not_selected_yet'   nothing to confirm
  outcome text,
  body    text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_project  projects.projects;
  v_client   text;
  v_body     text;
  v_names    text;
  v_count    int;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::text; return;
  end if;

  if p_step_key not in ('phase_three_start', 'theme_review', 'revision_ready', 'final_confirmation') then
    return query select 'bad_step'::text, null::text; return;
  end if;

  select p3.* into v_phase3 from projects.phase_three p3 where p3.id = p_phase_three_id;
  if v_phase3.id is null then
    return query select 'unknown_phase'::text, null::text; return;
  end if;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.is_internal()), false) then
    return query select 'forbidden'::text, null::text; return;
  end if;

  -- §10: "Do not present rejected/internal-only designs." The names that can
  -- reach a client come only from options Admin approved — a draft cannot be
  -- named even by a template that asks for it, because it is never in the
  -- variable.
  select count(*), string_agg(t.name, ', ' order by t.option_index)
    into v_count, v_names
    from projects.theme_options t
   where t.phase_three_id = v_phase3.id
     and t.admin_status = 'approved';

  -- §10: "Do not claim a revision is ready before approved backend state."
  -- Checked per step, because the claim differs per step.
  if p_step_key = 'theme_review' and coalesce(v_count, 0) = 0 then
    return query select 'nothing_approved'::text, null::text; return;
  end if;

  if p_step_key = 'revision_ready' and not exists (
    select 1
      from projects.design_revisions r
      join projects.theme_options t on t.id = r.to_theme_option_id
     where r.phase_three_id = v_phase3.id
       and r.status = 'delivered'
       and t.admin_status = 'approved'
  ) then
    return query select 'no_revision_ready'::text, null::text; return;
  end if;

  if p_step_key = 'final_confirmation' and not exists (
    select 1 from projects.client_design_decisions d
     where d.phase_three_id = v_phase3.id
       and d.decision = 'client_selected'
  ) then
    return query select 'not_selected_yet'::text, null::text; return;
  end if;

  -- The organisation's wording if it has one, the shipped default otherwise.
  select tpl.body into v_body
    from projects.design_message_templates tpl
   where tpl.organization_id = v_phase3.organization_id
     and tpl.step_key = p_step_key
     and tpl.language = coalesce(p_language, 'en');

  v_body := coalesce(v_body, projects.default_design_message(p_step_key));

  select p.* into v_project from projects.projects p where p.id = v_phase3.project_id;
  select ca.name into v_client
    from core.client_accounts ca where ca.id = v_project.client_account_id;

  -- §10: "Use actual backend state for progress updates." Every variable is
  -- read here and now; none is passed in.
  v_body := replace(v_body, '{{client_name}}', coalesce(v_client, 'there'));
  v_body := replace(v_body, '{{project_name}}', coalesce(v_project.name, 'your project'));
  v_body := replace(v_body, '{{option_names}}', coalesce(v_names, ''));
  v_body := replace(v_body, '{{option_count}}', coalesce(v_count, 0)::text);
  v_body := replace(v_body, '{{round_number}}', v_phase3.client_revision_count::text);

  return query select 'rendered'::text, v_body;
end;
$$;

comment on function projects.render_design_message(uuid, text, text) is
  'PM sections 10 and 11. Renders the wording for a step from ACTUAL BACKEND STATE - every variable is read here, none is passed in (section 10). A STEP WHOSE CLAIM THE STATE DOES NOT SUPPORT IS REFUSED RATHER THAN RENDERED: theme_review needs an Admin-approved option, revision_ready needs a delivered revision whose new version passed Admin, final_confirmation needs a selection. Section 10 says do not claim a revision is ready before approved backend state, and that is not a property of the words, so it cannot be a CHECK. The option names it interpolates come only from Admin-approved options, so a rejected or internal-only design cannot be named even by a template that asks for one. It renders; IT DOES NOT SEND (BLK-003, BLK-007).';

revoke all on function projects.render_design_message(uuid, text, text) from public, anon;
grant execute on function projects.render_design_message(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
