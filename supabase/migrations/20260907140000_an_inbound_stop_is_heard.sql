-- ═══════════════════════════════════════════════════════════════════════════
-- An inbound STOP is heard — G-222, ADM-101.
--
-- Consent in this system is asymmetric, and the missing half is the dangerous
-- one. `crm.record_inbound_consent` (20260822310000, ADM-92) writes a `granted`
-- row the moment a person writes to the agency. Withdrawal had no inbound path
-- at all: a client could reply "STOP" and nothing recorded it, so the follow-up
-- worker passed `optedOut: false` unconditionally and the only thing standing
-- between an opted-out client and the next message was a `withdrawn` row that
-- nothing ever wrote.
--
-- The blocking machinery already works once that row exists. `hasConsent` reads
-- `status = 'granted'` and `crm.send_outbound_message` refuses on `withdrawn`
-- BEFORE its idempotency lookup, so a withdrawal a retry cannot bypass. What was
-- missing was only the PRODUCER: something that records the withdrawal when a
-- client asks to stop. This adds it, on the same row and at the same firing
-- point as the grant.
--
-- ── ADM-101, the two decisions this encodes ──────────────────────────────
--
--   1. WHICH messages opt out. This agency's clients write English, Hindi and
--      Hinglish, so an English-only keyword list would hear "STOP" and miss
--      "band karo". The set is the standard English words Meta itself honours,
--      plus the Hindi/Hinglish phrases a real client uses. The failure that
--      matters is a live client silenced by a false positive, and it has two
--      shapes. The substring shape — "stopwatch", "non-stop delivery" — is
--      stopped by whole-word `\y` (and `\y` not `\b`, the lesson
--      `states_a_price` records: in Postgres regex `\b` is a backspace). The
--      harder shape is a whole word mid-sentence: "stop the ads", "cancel the
--      meeting", "add a stop button" are ordinary agency messages, not opt-outs.
--      So the ambiguous command words (stop/cancel/quit/end) are read as an
--      opt-out ONLY when the whole message is the command; the unambiguous ones
--      (unsubscribe/opt out/remove me) match anywhere because they mean nothing
--      else.
--
--   2. WHAT happens next. Nothing is sent. A confirmation ("you're
--      unsubscribed") would be an automated send to a contact who just
--      withdrawn consent — the exact shape `send_outbound_message` refuses, and
--      the exact shape this gap exists to close. Honouring STOP by going quiet
--      is what STOP asks for.
--
-- ── why UPDATE, not delete-and-insert ────────────────────────────────────
--
-- `consent_reject_delete` and `consent_freeze_identity` (20260815130000) make a
-- consent row undeletable and unmovable while the contact exists, because
-- delete-a-withdrawn-row-then-insert-a-granted-one is the forge that re-permits
-- an opted-out client with a clean audit trail. Withdrawal therefore flips the
-- existing row IN PLACE with `on conflict ... do update`, which the audit
-- trigger (INSERT OR UPDATE) records. A contact with no consent row yet who
-- opens with "STOP" gets a `withdrawn` row inserted directly — no send has
-- happened, and the withdrawal stands so a later grant is a deliberate act.

-- ── 1. the test, as a function so it can be exercised directly ───────────
--
-- Its own function for the same reason `crm.states_a_price` is: the matcher is
-- the thing most worth testing, and a regex buried in a trigger body cannot be
-- called with a hundred strings. `immutable`, so it is safe in any read.
create or replace function crm.reads_as_opt_out(p_body text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_body is not null and (
    -- English, unambiguous — words that are only ever an opt-out, matched
    -- whole-word anywhere in the message. "unsubscribe" / "opt out" / "opt-out"
    -- / "remove me" mean nothing else; nobody writes "remove me" about a
    -- deliverable, so "remove me from this list" is heard wherever it sits.
    p_body ~* '\y(unsubscribe|remove\s+me|opt\s*[- ]?\s*out)\y'
    -- English, ambiguous — `stop` / `cancel` / `quit` / `end` are opt-out
    -- keywords AND ordinary agency words: "stop the ads", "cancel the meeting",
    -- "add a stop button", "end of month". Read as an opt-out ONLY when the
    -- message IS the command — the word (optionally "please") at the start,
    -- then optionally a messaging-related object ("stop sending me messages",
    -- "end it") and nothing else. This anchoring is what keeps a live client
    -- who wrote "stop the ads please" from being silenced, the failure a bare
    -- whole-word match makes. `\y` after the word also rejects "stopwatch".
    or p_body ~* '^\s*(please\s+)?(stop|cancel|quit|end)\y(\s+(me|it|this|these|them|all|now|everything|sending|messaging|texting|contacting|messages?|msgs?|texts?|sms|notifications?|updates?|spam|please|the))*\s*[.!]*\s*$'
    -- Hindi / Hinglish. Whole-phrase, not substring. `band karo`/`bnd kro`
    -- (stop it), `mat bhejo` / `message mat` (don't send), `nahi chahiye`
    -- (don't want it), and their Devanagari forms.
    or p_body ~* '\yb[a]?nd\s+k[a]?ro\y'
    or p_body ~* '\y(message|msg|sms)?\s*mat\s+(bhejo|karo|kro|bhejna)\y'
    or p_body ~* '\yn[a]?h?i+\s+chah?iye\y'
    or p_body ~ 'बंद\s*कर(ो|ें|ना)?'
    or p_body ~ 'मत\s*भेज(ो|ें|ना)?'
    or p_body ~ 'नहीं\s*चाहिए'
  );
$$;

comment on function crm.reads_as_opt_out(text) is
  'Whether an inbound message asks to stop being messaged (G-222, ADM-101). Unambiguous words (unsubscribe, opt out, remove me) match whole-word anywhere; ambiguous command words (stop, cancel, quit, end) match ONLY when the whole message is the command, so "stop the ads please" or "cancel the meeting" from a live client is not read as an opt-out. Plus curated Hindi/Hinglish phrases (band karo, mat bhejo, nahi chahiye and Devanagari forms). Money-guard-shaped: the matcher is a function so it can be exercised directly.';

-- ── 2. the producer, on the row where the message lands ──────────────────
--
-- Mirrors `crm.record_inbound_consent`: after insert, client authors only,
-- contact resolved from the conversation, security definer with an empty
-- search_path. A group thread carries no single contact and is skipped, exactly
-- as the grant is — a group opt-out is a different question nobody has decided.
create or replace function crm.record_inbound_opt_out()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact uuid;
begin
  if new.author_type <> 'client' then
    return new;
  end if;

  if not crm.reads_as_opt_out(new.body) then
    return new;
  end if;

  select c.contact_id into v_contact
    from crm.conversations c
   where c.id = new.conversation_id;

  if v_contact is null then
    return new;
  end if;

  -- Flip in place. `do update` rather than delete-and-insert because the forge
  -- guards forbid the latter, and because the audit trigger records the UPDATE.
  -- Withdrawal is final for the channel: a granted row becomes withdrawn, and an
  -- already-withdrawn row is written the same values (a harmless no-op the audit
  -- log shows once per distinct STOP). `note` carries the message id as
  -- evidence, matching the grant's convention.
  insert into crm.communication_consent (
    organization_id, contact_id, channel, status, source, note
  )
  values (
    new.organization_id, v_contact, 'whatsapp', 'withdrawn',
    'inbound_message', 'opted out by inbound message ' || new.id::text
  )
  on conflict (organization_id, contact_id, channel) do update
    set status = 'withdrawn',
        source = 'inbound_message',
        note = 'opted out by inbound message ' || new.id::text;

  return new;
end;
$$;

comment on function crm.record_inbound_opt_out() is
  'G-222, ADM-101. Records a WhatsApp consent WITHDRAWAL when a client''s inbound message reads as an opt-out (crm.reads_as_opt_out). Flips the row in place with ON CONFLICT DO UPDATE - never delete-and-insert, which the forge guards (20260815130000) refuse - so the withdrawal is audited and cannot be erased. Silent by design (ADM-101): nothing is sent back, because a send to a contact who just opted out is what the consent guard exists to refuse. Skips group threads, which have no single contact, exactly as the grant does.';

-- Name orders AFTER `record_inbound_consent`, so on a first-ever inbound "STOP"
-- the grant's insert lands first and this update flips it to withdrawn in the
-- same statement. The order does not actually matter — the grant is
-- do-nothing-on-conflict and this is do-update-to-withdrawn, so withdrawn wins
-- either way — but it is the intuitive reading and costs nothing to keep.
drop trigger if exists record_inbound_opt_out on crm.conversation_messages;
create trigger record_inbound_opt_out
  after insert on crm.conversation_messages
  for each row execute function crm.record_inbound_opt_out();

notify pgrst, 'reload schema';
