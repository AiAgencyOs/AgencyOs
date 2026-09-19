-- ═══════════════════════════════════════════════════════════════════════════
-- Only what Admin approved, and a record of exactly what was sent.
--
-- Master §7.9 and PM §4.4 are the same instruction:
--
--   *"Only Admin-approved options are shared by PM with client."*
--   *"Do not send drafts or rejected options to the client."*
--
-- G-280 built the first half of §16's order — internal review before Admin.
-- Its own migration named this unit as the second half and said so rather than
-- leaving the absence to be discovered: *"the gate that refuses to share an
-- unlinked option with a client belongs to the unit that builds the client
-- share."* This is that unit.
--
-- ── the question Master §8 says this must answer ───────────────────────
--
-- §8 marks one row of the Admin Panel table *very important*, and phrases the
-- requirement as a question the panel has to be able to answer:
--
--   *"Which UI samples were sent to this client?"* — **without reading
--   WhatsApp manually.**
--
-- That sentence is why this is a table and not a join. A live join onto
-- `theme_options` answers *what those options are now*, which is a different
-- question and a worse one: an option revised after it was sent would make the
-- record claim the client saw something they never did. So a share **freezes
-- what was shown** — the same snapshot doctrine G-278 used for the screen
-- baseline, and for the same reason §8 gives: *"editing the current state must
-- not destroy the previous decision/version trail."*
--
-- ── what is refused, and why each refusal exists ───────────────────────
--
-- **`not_approved`** — the rule itself, and it names the offending options
-- rather than refusing blankly, because a PM told *"one of these is not
-- approved"* has to go and find out which.
--
-- **`nothing_to_show`** — an option with neither a Figma reference nor a
-- preview is an option the client cannot look at. Sharing it would be sending
-- a name. Designer §8 wants Phase 4 to open the exact node without relying on
-- screenshots, and Master §5 permits a preview as a *secondary* artifact, so
-- **either** satisfies this: what is refused is having neither.
--
-- **`no_evidence`** — the same rule `record_kickoff` carries, for the same
-- reason. This deployment has no channel of its own (BLK-003 for a production
-- WhatsApp number, BLK-007 for email), so a person sends the message and
-- records its reference. A share with no evidence would be this system
-- claiming a client was shown something nobody can show them being shown.
--
-- **IT DOES NOT SEND.** There is nothing here that contacts a client. When a
-- channel exists, the sender fills the evidence argument and nothing else
-- about this door changes.
--
-- ── a colour is shared with its theme, never alone ─────────────────────
--
-- §12 makes a colour option belong to a theme direction. Sharing a palette
-- without the direction it was drawn for is showing a client swatches, and
-- §7.6 is explicit that colour options must *"remain coherent with the design
-- direction"*. So the door takes theme options and carries their approved
-- palettes with them, rather than taking two independent lists a caller could
-- mismatch.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.client_design_shares (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  phase_three_id   uuid not null references projects.phase_three(id) on delete cascade,

  -- Which round of sharing this was. §16 requires the revision count and its
  -- origin to be visible, and a client who has seen three sets should not have
  -- to be told which one somebody means.
  share_number     int not null check (share_number > 0),

  -- THE SNAPSHOT. What the client was actually shown: option ids, names,
  -- versions, the Figma reference and the preview as they stood at that
  -- moment, and the palettes that went with them. Written once and never
  -- updated — §8's "historical data must be preserved".
  shared_options   jsonb not null,
  option_count     int not null check (option_count > 0),

  -- PM §14's evidence contract. The channel a person used and the reference
  -- they can produce, because nothing here sends anything.
  channel          text not null check (channel in ('whatsapp', 'email', 'other')),
  evidence_ref     text not null check (length(btrim(evidence_ref)) between 1 and 300),
  -- The thread it went to, when it went to one this system knows about. Null
  -- for a channel AgencyOS does not hold, which is most of them today.
  conversation_id  uuid references crm.conversations(id) on delete set null,

  shared_by        uuid not null references core.users(id) on delete restrict,
  shared_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  unique (project_id, share_number)
);

create index if not exists client_design_shares_project_idx
  on projects.client_design_shares (organization_id, project_id, share_number desc);

comment on table projects.client_design_shares is
  'Master section 8 - the row that answers "which UI samples were sent to this client?" without reading WhatsApp manually. A SNAPSHOT rather than a join: a live join answers what those options are NOW, and an option revised after it was sent would make the record claim the client saw something they never did. Written once and never updated, which is section 8s historical-data rule.';

comment on column projects.client_design_shares.evidence_ref is
  'PM section 14. Required, because this deployment has no channel of its own (BLK-003, BLK-007): a person sends the message and records its reference. A share with no evidence would be this system claiming a client was shown something nobody can show them being shown - the same rule record_kickoff carries.';

-- Nothing rewrites a share. The client saw what they saw.
create or replace function projects.freeze_client_design_share()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'a client design share is a record of what was sent; it cannot be edited'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists freeze_client_design_share on projects.client_design_shares;
create trigger freeze_client_design_share
  before update on projects.client_design_shares
  for each row execute function projects.freeze_client_design_share();

drop trigger if exists org_match_shares_project on projects.client_design_shares;
create trigger org_match_shares_project
  before insert or update of project_id, organization_id on projects.client_design_shares
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_shares_phase on projects.client_design_shares;
create trigger org_match_shares_phase
  before insert or update of phase_three_id, organization_id on projects.client_design_shares
  for each row execute function core.enforce_parent_org('phase_three_id', 'projects.phase_three');

drop trigger if exists org_match_shares_conversation on projects.client_design_shares;
create trigger org_match_shares_conversation
  before insert or update of conversation_id, organization_id on projects.client_design_shares
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

-- The freeze trigger above already refuses EVERY update, so organization_id
-- cannot change today. This is here anyway, and CI is why: db:verify:tenancyguards
-- checks the named guard rather than the property, and it is right to — a future
-- change that relaxes the blanket freeze would otherwise remove the tenancy
-- protection silently, with no test failing. The invariant should not depend on
-- a different rule happening to be stricter.
drop trigger if exists freeze_org_client_design_shares on projects.client_design_shares;
create trigger freeze_org_client_design_shares
  before update of organization_id on projects.client_design_shares
  for each row execute function core.freeze_organization_id();

alter table projects.client_design_shares enable row level security;
alter table projects.client_design_shares force row level security;

drop policy if exists client_design_shares_select on projects.client_design_shares;
create policy client_design_shares_select on projects.client_design_shares
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.client_design_shares to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.design_options_shared',
   'Master section 15 DesignOptionsSharedToClient - a PM sent an Admin-approved set of theme options to the client and recorded exactly which ones, through which channel, with what evidence.',
   true)
on conflict (type) do nothing;

-- ── the door ────────────────────────────────────────────────────────────

create or replace function projects.record_design_share(
  p_project_id      uuid,
  p_theme_option_ids uuid[],
  p_channel         text,
  p_evidence_ref    text,
  p_conversation_id uuid default null
)
returns table (
  -- 'shared' | 'no_options' | 'not_approved' | 'nothing_to_show'
  -- | 'no_evidence' | 'bad_channel' | 'no_phase_three' | 'no_actor' | 'forbidden'
  outcome   text,
  share_id  uuid,
  -- Which options failed, so a refusal is actionable rather than a puzzle.
  findings  text[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_evidence text := nullif(btrim(coalesce(p_evidence_ref, '')), '');
  v_bad      text[];
  v_snapshot jsonb;
  v_count    int;
  v_next     int;
  v_new      uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, '{}'::text[]; return;
  end if;

  -- Argument-only refusals first, before any row is read: a caller who sent no
  -- options or no evidence has made a mistake about the request, not about
  -- this project.
  if p_theme_option_ids is null or array_length(p_theme_option_ids, 1) is null then
    return query select 'no_options'::text, null::uuid, '{}'::text[]; return;
  end if;

  if p_channel is null or p_channel not in ('whatsapp', 'email', 'other') then
    return query select 'bad_channel'::text, null::uuid, '{}'::text[]; return;
  end if;

  if v_evidence is null then
    return query select 'no_evidence'::text, null::uuid, '{}'::text[]; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.project_id = p_project_id
   for update;

  if v_phase3.id is null then
    return query select 'no_phase_three'::text, null::uuid, '{}'::text[]; return;
  end if;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid, '{}'::text[]; return;
  end if;

  -- ── THE RULE ───────────────────────────────────────────────────────────
  --
  -- §7.9 and PM §4.4. Every option must be Admin-approved, and the refusal
  -- names the ones that are not: a PM told "one of these is not approved" has
  -- to go and find out which.
  select array_agg(format('not_approved:%s', t.name) order by t.name) into v_bad
    from projects.theme_options t
   where t.id = any(p_theme_option_ids)
     and t.project_id = p_project_id
     and t.admin_status <> 'approved';

  if v_bad is not null then
    return query select 'not_approved'::text, null::uuid, v_bad; return;
  end if;

  -- An id that belongs to another project, or to nothing, is also not
  -- approved — counted rather than trusted, because `= any()` silently
  -- ignores what it cannot find.
  select count(*) into v_count
    from projects.theme_options t
   where t.id = any(p_theme_option_ids)
     and t.project_id = p_project_id
     and t.admin_status = 'approved';

  if v_count <> array_length(p_theme_option_ids, 1) then
    return query select 'not_approved'::text, null::uuid,
      array['not_approved:one or more options do not belong to this project']::text[];
    return;
  end if;

  -- An option with neither a Figma reference nor a preview is an option the
  -- client cannot look at. Master §5 permits a preview as a SECONDARY
  -- artifact, so either satisfies this; what is refused is having neither.
  select array_agg(format('nothing_to_show:%s', t.name) order by t.name) into v_bad
    from projects.theme_options t
   where t.id = any(p_theme_option_ids)
     and t.figma_node_id is null
     and t.preview_asset_url is null;

  if v_bad is not null then
    return query select 'nothing_to_show'::text, null::uuid, v_bad; return;
  end if;

  -- THE SNAPSHOT. What the client is being shown, as it stands right now,
  -- with each option's approved palettes carried alongside it — §12 makes a
  -- colour belong to a direction, and a palette shared without its direction
  -- is a swatch.
  select jsonb_agg(
           jsonb_build_object(
             'themeOptionId', t.id,
             'name', t.name,
             'optionIndex', t.option_index,
             'version', t.version,
             'directionSummary', t.direction_summary,
             'figmaFileKey', t.figma_file_key,
             'figmaNodeId', t.figma_node_id,
             'figmaVersion', t.figma_version,
             'previewAssetUrl', t.preview_asset_url,
             'colors', coalesce((
               select jsonb_agg(
                        jsonb_build_object(
                          'colorOptionId', c.id,
                          'paletteName', c.palette_name,
                          'primaryHex', c.primary_hex,
                          'optionIndex', c.option_index
                        ) order by c.option_index
                      )
                 from projects.color_options c
                where c.theme_option_id = t.id
             ), '[]'::jsonb)
           ) order by t.option_index
         )
    into v_snapshot
    from projects.theme_options t
   where t.id = any(p_theme_option_ids);

  select coalesce(max(s.share_number), 0) + 1 into v_next
    from projects.client_design_shares s
   where s.project_id = p_project_id;

  insert into projects.client_design_shares (
    organization_id, project_id, phase_three_id, share_number,
    shared_options, option_count, channel, evidence_ref, conversation_id, shared_by
  ) values (
    v_phase3.organization_id, p_project_id, v_phase3.id, v_next,
    v_snapshot, v_count, p_channel, v_evidence, p_conversation_id, v_actor
  )
  returning id into v_new;

  -- The options now say they have been shown. Nothing else about them moves:
  -- the client has seen them and has not answered, which is a different fact
  -- from having chosen.
  update projects.theme_options
     set client_status = 'shared'
   where id = any(p_theme_option_ids)
     and client_status = 'not_shared';

  update projects.color_options
     set client_status = 'shared'
   where theme_option_id = any(p_theme_option_ids)
     and client_status = 'not_shared';

  update projects.phase_three
     set state = 'waiting_client'
   where id = v_phase3.id
     and state in ('client_review', 'admin_review', 'revision');

  perform core.record_audit(
    v_phase3.organization_id, 'project.design_options_shared', 'client_design_share', v_new, null,
    jsonb_build_object('projectId', p_project_id, 'shareNumber', v_next,
                       'optionCount', v_count, 'channel', p_channel, 'evidenceRef', v_evidence)
  );

  perform core.emit_event(
    v_phase3.organization_id, 'project.design_options_shared', 'client_design_share', v_new,
    jsonb_build_object('projectId', p_project_id, 'shareNumber', v_next, 'optionCount', v_count)
  );

  return query select 'shared'::text, v_new, '{}'::text[];
end;
$$;

comment on function projects.record_design_share(uuid, uuid[], text, text, uuid) is
  'Master sections 7.9 and 8, PM section 4.4. Records EXACTLY which Admin-approved theme options were sent to a client, as a frozen snapshot rather than a join - a live join answers what those options are now, and an option revised afterwards would make the record claim the client saw something they never did. Refuses any option Admin has not approved AND NAMES IT, refuses an option with neither a Figma reference nor a preview because the client could not look at it, and refuses a share with no evidence reference. IT DOES NOT SEND: this deployment has no channel of its own (BLK-003, BLK-007), so a person sends the message and records what they sent.';

revoke all on function projects.record_design_share(uuid, uuid[], text, text, uuid) from public, anon;
grant execute on function projects.record_design_share(uuid, uuid[], text, text, uuid) to authenticated;

notify pgrst, 'reload schema';
