-- ═══════════════════════════════════════════════════════════════════════════
-- An inbound message belongs to one tenant, and the database says which.
--
-- Audit finding D22. crm.ingest_whatsapp_message resolves tenancy from data:
--
--     select o.id into v_org
--       from core.organizations o
--      where o.settings->>'whatsapp_phone_number_id' = p_phone_number_id
--      limit 1;
--
-- No ORDER BY. Two organizations carrying the same `whatsapp_phone_number_id`
-- was an accepted state — nothing anywhere prevented it — and when it happened
-- the message landed in whichever row the planner returned first. That is not
-- merely unspecified, it is unstable: the same number could route to a
-- different tenant on a different call, as the table changed shape.
--
-- And it needed nobody's mistake. `core` is on PostgREST's exposed list, the
-- `authenticated` role holds UPDATE on core tables, and `organizations_update`
-- admits an owner editing their own row with `with check (id =
-- core.current_organization_id())` and no restriction at all on the `settings`
-- jsonb. So any owner of any tenant could PATCH their own organization to
-- claim a competitor's phone number id and start receiving that competitor's
-- inbound leads — no operator, no admin, no UI. The finding was filed P3 as
-- "latent rather than live"; it is P1.
--
-- What follows is not a wrong id in one column. `v_org` is the organization
-- stamped on the contact, the lead, the conversation, the message and the
-- extraction job — so a customer's phone number, name and the text of what they
-- wrote are written into another agency's tenant, where that agency's RLS
-- policies then correctly show it to them. It is the one direction the
-- isolation model has no answer for, because nothing was breached: the row was
-- filed under the wrong owner at the moment it was created.
--
-- ── Why an index and not a change to the function ─────────────────────────
--
-- The obvious fix is to make the function refuse when the match is ambiguous.
-- This does something stricter: it makes the ambiguity unrepresentable. With at
-- most one organization per phone number id, `limit 1` selects from a set that
-- can hold at most one row, and the missing ORDER BY stops mattering — not
-- because the code got more careful, but because there is nothing left to
-- order.
--
-- That also avoids replacing a 150-line plpgsql function to change five lines
-- of it, which CREATE OR REPLACE would require and which carries a
-- transcription risk of its own. The function is left exactly as it is.
--
-- Uniqueness here is not a product decision. A Meta `phone_number_id`
-- identifies one WhatsApp Business number, and an inbound message to it has
-- exactly one rightful owner. Two organizations claiming the same one is not a
-- configuration this system could serve correctly under any rule — there would
-- be no fact of the matter about where the message belongs.
--
-- Partial, so the many organizations that have configured no WhatsApp number
-- do not collide with each other on a null.
--
-- No table, column or constraint is added, altered or dropped.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Refuse legibly if two tenants already claim one number ────────────────
--
-- CREATE UNIQUE INDEX on existing duplicates fails naming only the key value:
-- it identifies the number but neither of the organizations claiming it, and
-- the operator cannot act on that without going and querying for them.
--
-- Which organization keeps the number is a question about who owns the
-- WhatsApp account, so this does not choose. It stops, names them, and says
-- what to look at.
--
-- What it cannot do is repair what already happened. Contacts, leads,
-- conversations, messages and jobs already stamped with the wrong
-- organization stay where they are, visible to the wrong agency under that
-- agency's own RLS. Moving them is a decision about customer data belonging to
-- two businesses, not a migration — recorded as G-090.
do $$
declare
  v_dupes text;
begin
  select string_agg(
           format('%s (claimed by %s)', d.phone_number_id, d.orgs), '; '
         )
    into v_dupes
    from (
      select o.settings->>'whatsapp_phone_number_id' as phone_number_id,
             string_agg(o.id::text, ', ' order by o.id) as orgs
        from core.organizations o
       where o.settings->>'whatsapp_phone_number_id' is not null
       group by o.settings->>'whatsapp_phone_number_id'
      having count(*) > 1
    ) d;

  if v_dupes is not null then
    raise exception
      'D22: more than one organization claims the same WhatsApp phone number id: %. '
      'Inbound messages to it have no single rightful owner. Decide which '
      'organization holds the WhatsApp account and clear '
      'settings->>''whatsapp_phone_number_id'' on the others, then re-run.', v_dupes;
  end if;
end;
$$;

create unique index if not exists organizations_whatsapp_number_key
  on core.organizations ((settings->>'whatsapp_phone_number_id'))
  where settings->>'whatsapp_phone_number_id' is not null;

comment on index core.organizations_whatsapp_number_key is
  'One organization per WhatsApp phone number id. This is what makes the tenancy lookup in crm.ingest_whatsapp_message single-valued: its `limit 1` has no ORDER BY, and with this index there is nothing left to order. Partial, so organizations with no WhatsApp number configured do not collide on a null.';
