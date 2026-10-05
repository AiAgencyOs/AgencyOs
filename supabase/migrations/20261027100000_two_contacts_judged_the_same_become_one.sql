-- Two contacts an administrator has judged to be the same person become one.
--
-- Eleven tables point at crm.contacts. A merge moves the working history (identity keys, leads, conversations,
-- meetings, follow-ups, handoffs, import and prospect links) to the surviving contact and keeps the other row as
-- history, marked merged_into_contact_id, so nothing that refers to it by id breaks. What it deliberately does NOT do:
--   * delete anything (a consent row does not change hands - the delete guard and ADM-70/81 forbid it - so the winner
--     gets a copy, and where the two disagree the SAFER answer, withdrawn, wins);
--   * touch approval/proposal history that names the loser (those are records of who answered, not live links);
--   * merge without a confirmed_same review of exactly this pair: the judgement is a person's, the door only executes it.
-- A phone number held only as an identity key does not resolve through the WhatsApp ingest (which matches contacts.phone);
-- such a message opens a duplicate review rather than silently merging.

alter table crm.contacts add column if not exists merged_into_contact_id uuid references crm.contacts(id);
alter table crm.contacts add column if not exists merged_at timestamptz;
alter table crm.contacts drop constraint if exists contacts_reachable_via_check;
alter table crm.contacts add constraint contacts_reachable_via_check
  check (reachable_via is null or reachable_via in ('linkedin', 'instagram', 'facebook', 'b2b', 'merged'));
alter table crm.contacts drop constraint if exists contacts_merged_is_consistent;
alter table crm.contacts add constraint contacts_merged_is_consistent
  check ((merged_into_contact_id is null) = (merged_at is null) and merged_into_contact_id is distinct from id);
create index if not exists contacts_merged_into_idx on crm.contacts (merged_into_contact_id) where merged_into_contact_id is not null;

create or replace function crm.merge_contacts(p_organization_id uuid, p_winner uuid, p_loser uuid, p_reason text)
returns table(outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  w crm.contacts%rowtype;
  l crm.contacts%rowtype;
  v_a uuid; v_b uuid;
  v_moved jsonb := '{}'::jsonb;
  n int;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text; return; end if;
  if (select auth.uid()) is not null and not coalesce((select core.is_internal()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if p_winner is null or p_loser is null or p_winner = p_loser then return query select 'same_contact'::text; return; end if;
  if v_reason is null then return query select 'needs_reason'::text; return; end if;

  -- lock both rows in a fixed order so two merges cannot deadlock each other
  perform 1 from crm.contacts c where c.id in (p_winner, p_loser) order by c.id for update;
  select * into w from crm.contacts where id = p_winner and organization_id = p_organization_id;
  select * into l from crm.contacts where id = p_loser  and organization_id = p_organization_id;
  if w.id is null or l.id is null then return query select 'not_found'::text; return; end if;
  if w.merged_into_contact_id is not null or l.merged_into_contact_id is not null then
    return query select 'already_merged'::text; return;
  end if;

  v_a := least(p_winner, p_loser); v_b := greatest(p_winner, p_loser);
  if not exists (select 1 from crm.duplicate_reviews r
                  where r.organization_id = p_organization_id and r.contact_a = v_a and r.contact_b = v_b
                    and r.status = 'confirmed_same') then
    return query select 'no_confirmed_review'::text; return;
  end if;

  -- identity keys first, so setting the winner's email/phone below does not look like a collision with the loser
  update crm.identity_keys set contact_id = p_winner where organization_id = p_organization_id and contact_id = p_loser;
  get diagnostics n = row_count; v_moved := v_moved || jsonb_build_object('identity_keys', n);
  update crm.leads set contact_id = p_winner where organization_id = p_organization_id and contact_id = p_loser;
  get diagnostics n = row_count; v_moved := v_moved || jsonb_build_object('leads', n);
  update crm.conversations set contact_id = p_winner where organization_id = p_organization_id and contact_id = p_loser;
  get diagnostics n = row_count; v_moved := v_moved || jsonb_build_object('conversations', n);
  update crm.meetings set contact_id = p_winner where organization_id = p_organization_id and contact_id = p_loser;
  get diagnostics n = row_count; v_moved := v_moved || jsonb_build_object('meetings', n);
  update crm.follow_up_sequences set contact_id = p_winner where organization_id = p_organization_id and contact_id = p_loser;
  get diagnostics n = row_count; v_moved := v_moved || jsonb_build_object('follow_up_sequences', n);
  update crm.outreach_prospects set contact_id = p_winner where organization_id = p_organization_id and contact_id = p_loser;
  get diagnostics n = row_count; v_moved := v_moved || jsonb_build_object('outreach_prospects', n);
  update crm.import_records set matched_contact_id = p_winner where organization_id = p_organization_id and matched_contact_id = p_loser;
  update crm.import_records set committed_contact_id = p_winner where organization_id = p_organization_id and committed_contact_id = p_loser;
  -- handoff identity is frozen at creation, so only the consumer link moves; the original contact stays as history
  update crm.channel_handoffs set consumed_contact_id = p_winner where organization_id = p_organization_id and consumed_contact_id = p_loser;

  -- consent: the winner gets a copy; where both have an answer the safer one (withdrawn) wins
  insert into crm.communication_consent (organization_id, contact_id, channel, status, source, note, recorded_by)
  select c.organization_id, p_winner, c.channel, c.status, 'merge', 'carried from merged contact', c.recorded_by
    from crm.communication_consent c
   where c.organization_id = p_organization_id and c.contact_id = p_loser
  on conflict (organization_id, contact_id, channel) do update
     set status = 'withdrawn', source = 'merge', note = 'a merged contact had withdrawn'
   where excluded.status = 'withdrawn' and crm.communication_consent.status <> 'withdrawn';

  -- the loser stays as history: it gives up its email/phone (both are unique per organisation) and is marked merged
  update crm.contacts
     set email = null, phone = null, reachable_via = 'merged', merged_into_contact_id = p_winner, merged_at = now(),
         notes = left(coalesce(notes || E'\n', '') || 'Merged into ' || p_winner::text || ': ' || v_reason, 4000)
   where id = p_loser;
  update crm.contacts
     set email   = coalesce(w.email, l.email),
         phone   = coalesce(w.phone, l.phone),
         company = coalesce(w.company, l.company),
         job_title = coalesce(w.job_title, l.job_title),
         preferred_language = coalesce(w.preferred_language, l.preferred_language)
   where id = p_winner;

  -- any other open question about the loser is answered by the merge
  update crm.duplicate_reviews
     set status = 'dismissed', decided_at = now(), decision_note = 'a contact in this pair was merged'
   where organization_id = p_organization_id and status = 'open' and (contact_a = p_loser or contact_b = p_loser);

  perform core.record_audit(p_organization_id, 'identity.contacts_merged', 'contact', p_winner,
    jsonb_build_object('loser', p_loser, 'loser_email', l.email, 'loser_phone', l.phone, 'loser_name', l.full_name),
    jsonb_build_object('winner', p_winner, 'reason', v_reason, 'moved', v_moved));
  return query select 'merged'::text;
end;
$$;
revoke all on function crm.merge_contacts(uuid, uuid, uuid, text) from public, anon;
grant execute on function crm.merge_contacts(uuid, uuid, uuid, text) to authenticated, service_role;
