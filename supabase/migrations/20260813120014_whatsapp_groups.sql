-- G-015 and G-109 — the two WhatsApp groups.
--
-- The Admin described both on 2026-08-13, and they are different things:
--
--   **The project group** — client + agency, one per project. The client-facing
--   thread for the work. G-015 recorded it as missing; ADM-13 then made it a
--   condition of a project officially starting, so it stopped being optional.
--
--   **The internal group** — owner + staff + the AgencyOS agent, one per
--   organization. Where the agent raises what it needs confirmed and gets
--   approve, reject or feedback. Given unprompted while answering a question
--   about payment verification, and recorded as G-109 because nothing in the
--   record had ever asked for it.
--
-- ── why this is a conversation and not a new table ────────────────────────
--
-- A group is a thread of messages with a provider-side id, exactly like the 1:1
-- threads `crm.conversations` already holds. Modelling it separately would mean
-- a second messages table, a second sequence, a second outbound path and a
-- second ingest — four copies of machinery that works.
--
-- Reusing the conversation means `crm.send_outbound_message` can already post
-- into either group, `conversation_messages.seq` already serialises two staff
-- replying at once, and the inbound webhook already knows how to append. The
-- only thing that was missing was the ability to say what a thread *is*.
--
-- ── what a client can see ─────────────────────────────────────────────────
--
-- Nothing. `conversations_select` has required `core.is_internal()` since the
-- first migration, so no client role can read any conversation, group or
-- otherwise. The internal group is safe here by construction rather than by a
-- new rule — worth stating, because "the group where staff discuss the client"
-- is exactly the row somebody would later expose by widening that policy.

-- ── 1. what kind of thread this is ────────────────────────────────────────

alter table crm.conversations
  add column if not exists kind text not null default 'direct'
    check (kind in ('direct', 'project_group', 'internal_group'));

alter table crm.conversations
  add column if not exists project_id uuid references projects.projects(id) on delete cascade;

comment on column crm.conversations.kind is
  'direct: the 1:1 thread with one person, which is every conversation that existed before G-015. project_group: the client-facing group for one project. internal_group: owner, staff and the agent, where approvals are raised (G-109).';

comment on column crm.conversations.project_id is
  'The project a project_group belongs to. Null for every other kind, enforced by conversations_kind_shape.';

-- A 1:1 thread is named by the person on the other end, so it never needed a
-- title. A group has a name of its own — the one shown in WhatsApp — and
-- without it a staff member reading the list sees a column of identical rows.
alter table crm.conversations add column if not exists title text;

comment on column crm.conversations.title is
  'What the group is called in WhatsApp. Null for a direct thread, which is named by its contact.';

-- ── 2. a lead is required of a thread, not of a group ─────────────────────
--
-- `lead_id` was NOT NULL because every conversation was a 1:1 thread with a
-- person who had become a lead. A group has no single person behind it: the
-- project group belongs to a project, the internal group to the agency itself.
--
-- Dropping the NOT NULL alone would let a direct thread lose its lead, which is
-- the whole reason the column existed. The shape check replaces it with the
-- rule that was actually meant: every kind carries exactly the link it needs
-- and none of the ones it does not.

alter table crm.conversations alter column lead_id drop not null;

alter table crm.conversations drop constraint if exists conversations_kind_shape;
alter table crm.conversations add constraint conversations_kind_shape check (
  (kind = 'direct'         and lead_id is not null and project_id is null)
  or (kind = 'project_group'  and lead_id is null and project_id is not null)
  or (kind = 'internal_group' and lead_id is null and project_id is null)
);

-- ── 3. one group of each kind ─────────────────────────────────────────────
--
-- Held in the database rather than checked before writing, for the reason D21
-- and D22 both were: a check taken before an insert is a check another request
-- can land inside. Two project groups for one project would split a client's
-- thread in half with no way to tell which is authoritative.
--
-- `abandoned` is excluded so a group that was replaced — the agency left it,
-- the client made a new one — does not block its successor. That mirrors
-- `invoices_milestone_live_key`, which excludes `void` for the same reason.

create unique index if not exists conversations_project_group_key
  on crm.conversations (project_id)
  where kind = 'project_group' and status <> 'abandoned';

create unique index if not exists conversations_internal_group_key
  on crm.conversations (organization_id)
  where kind = 'internal_group' and status <> 'abandoned';

comment on index crm.conversations_project_group_key is
  'One live client group per project (G-015). Excludes abandoned, so a replaced group does not block its successor.';

comment on index crm.conversations_internal_group_key is
  'One live internal approval group per organization (G-109). The agent raises approvals into exactly one place, and which place is not a question anybody has to ask.';

-- ── 4. the provider id is a group id, and belongs to one tenant ───────────
--
-- `external_ref` already held the provider-side thread id for a 1:1 thread.
-- For a group it is the WhatsApp group id, and it must not be claimable twice:
-- two organizations naming the same group is the shape D22 was, one table
-- along, and it would put one agency's approvals in another's group.

create unique index if not exists conversations_group_external_ref_key
  on crm.conversations (external_ref)
  where kind in ('project_group', 'internal_group') and external_ref is not null;

comment on index crm.conversations_group_external_ref_key is
  'A WhatsApp group id belongs to one conversation across the whole deployment (D22 shape). Two tenants claiming one group would route one agency''s messages into another''s thread.';

-- ── 5. linking one ────────────────────────────────────────────────────────
--
-- A function rather than an insert from the service, for the same reason
-- `create_milestone_invoice` is one: the refusals are index violations rather
-- than pre-checks, so a request arriving between a check and its write cannot
-- slip through. It answers rather than raising, so the caller can tell "already
-- linked" from "somebody else has that group" without parsing a driver error.

create or replace function crm.link_whatsapp_group(
  p_organization_id uuid,
  p_kind            text,
  p_external_ref    text,
  p_project_id      uuid default null,
  p_title           text default null
)
returns table (
  -- 'linked' | 'already_linked' | 'group_taken' | 'bad_kind'
  outcome         text,
  conversation_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id         uuid;
  -- Declared here rather than in a nested block inside the handler. The first
  -- version declared it beside the `get stacked diagnostics` call, one BEGIN
  -- deeper, and the value came back empty — so every violation fell through to
  -- `already_linked`, and a group belonging to another agency was reported to
  -- the caller as their own. CI caught it; the structural tests could not,
  -- because the code read correctly.
  v_constraint text;
begin
  if p_kind not in ('project_group', 'internal_group') then
    return query select 'bad_kind'::text, null::uuid;
    return;
  end if;

  begin
    insert into crm.conversations (
      organization_id, kind, project_id, channel, external_ref, status, title
    )
    values (
      p_organization_id, p_kind, p_project_id, 'whatsapp', p_external_ref, 'active', p_title
    )
    returning id into v_id;
  exception
    when unique_violation then
      -- Three indexes can raise this and they mean different things. The
      -- constraint name decides, read from the diagnostics rather than matched
      -- out of SQLERRM, which is prose and therefore translated.
      get stacked diagnostics v_constraint = constraint_name;

      if v_constraint = 'conversations_group_external_ref_key' then
        return query select 'group_taken'::text, null::uuid;
        return;
      end if;

      -- This project, or this organization, already has a live group.
      select c.id into v_id
        from crm.conversations c
       where c.kind = p_kind
         and c.status <> 'abandoned'
         and (
           (p_kind = 'project_group' and c.project_id = p_project_id)
           or (p_kind = 'internal_group' and c.organization_id = p_organization_id)
         )
       limit 1;

      return query select 'already_linked'::text, v_id;
      return;
  end;

  return query select 'linked'::text, v_id;
end;
$$;

comment on function crm.link_whatsapp_group(uuid, text, text, uuid, text) is
  'Links a WhatsApp group to a project (G-015) or to the organization as its approval channel (G-109). Refuses through indexes rather than pre-checks, so a concurrent caller cannot split a project thread in two; answers already_linked and group_taken separately, because one is the answer and the other is somebody else holding that group. SECURITY INVOKER: conversations_write still decides who may link one.';

revoke all on function crm.link_whatsapp_group(uuid, text, text, uuid, text) from public, anon;
grant execute on function crm.link_whatsapp_group(uuid, text, text, uuid, text) to authenticated, service_role;
