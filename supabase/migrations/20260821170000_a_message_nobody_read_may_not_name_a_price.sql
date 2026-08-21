-- ═══════════════════════════════════════════════════════════════════════════
-- A message nobody read may not name a price.
--
-- Two granted decisions, made the same day, that the record has never linked:
--
--   ADM-11: follow-ups are "drafted and SENT AUTOMATICALLY, with nobody
--           reading them first, INCLUDING MESSAGES THAT MAY CARRY A PRICE,
--           DISCOUNT OR DELIVERY PROMISE." It records the risk in its own
--           words: "This is the only path in AgencyOS where something reaches
--           a client unread."
--
--   ADM-22: "There is no price catalog. Every price is quoted per client by a
--           human. It must never state a price, and there is no list for it to
--           state one from."
--
-- Read together they are not in conflict. ADM-11 grants automatic *sending*
-- and names the risk the owner accepted; it does not grant *pricing*, which
-- ADM-22 forbids absolutely and at every autonomy level. The faithful
-- implementation of both is: the automatic path stays automatic, and what
-- travels down it may not state a price.
--
-- Nothing enforced that. `crm.send_outbound_message` takes `p_body text` and
-- screens it for nothing at all. It is latent today only because the one
-- automated sender uses a hardcoded placeholder — 'Following up on our last
-- message.' — which cannot contain a price because a constant cannot contain
-- anything new. The moment an agent writes that body, which is precisely what
-- ADM-82's sales agent is for, ADM-11 sends it unread and no check exists.
--
-- ── why a trigger and not the function ────────────────────────────────────
--
-- `send_outbound_message` has been redefined five times. Re-emitting it to add
-- one rule is how a branch gets silently dropped — this repository has done
-- exactly that once, and a live check caught it. A row constraint also binds
-- every path that writes the row, not only the one function that exists today.
--
-- Consent is enforced inside the function because it is a fact about the
-- recipient, resolved by a query. This is a fact about the text, and it
-- belongs where the text lands.
--
-- ── who is exempt, and why that is the right line ─────────────────────────
--
-- A human quoting a price is exactly what ADM-22 says should happen. So the
-- rule applies only to an agency message with **no human behind it**:
--
--     author_type = 'user'  AND  author_id IS NULL
--
-- `crm.send_outbound_message` takes `p_author_id`, and `sendClientMessage`
-- passes the acting user's id while the follow-up worker passes none.
-- Verified against production rather than assumed: every one of the six agency
-- messages there carries an author id, and every client message carries none.
--
-- ── a stated limit of the exemption ───────────────────────────────────────
--
-- `author_id` carries no foreign key, so this rule keys on the PRESENCE of an
-- author rather than on that id naming a real person. Sound for the paths that
-- exist — `send_outbound_message` is the only writer, `sendClientMessage`
-- passes the authenticated user's id and the follow-up worker passes none, and
-- no agent holds a tool that could call either. It is written down because the
-- day something else writes this table, presence is a weaker claim than
-- identity, and a foreign key would be the hardening.
--
-- ── what this deliberately does NOT catch ─────────────────────────────────
--
-- Money only. ADM-11 also names a "delivery promise", and Document 03 §5
-- forbids promising "unsupported delivery dates" — but a matcher for a promise
-- is a matcher for intent, and writing one would mean inventing a rule nobody
-- decided. A guard that quietly fails at the edges is worse than one whose
-- edge is written down. Recorded here as a known limit, not as coverage.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the test, as a function so it can be exercised directly ───────────
--
-- Word boundaries are `\y`, not `\b`. In Postgres's regex flavour `\b` is a
-- BACKSPACE character, so the first draft of three of these patterns matched
-- nothing at all — "2 lakh", "20% off" and "discount of 5000" all read as
-- honest text. It looked right and behaved otherwise, which is why the
-- matcher is a function with its own tests rather than an inline condition.
create or replace function crm.states_a_price(p_body text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_body is not null and (
    -- A currency marker adjacent to digits, either order.
    p_body ~* '(₹|rs\.?|inr|usd|eur|gbp|\$|£|€)\s*[0-9]'
    or p_body ~* '[0-9][0-9,. ]*\s*(₹|rs\.?|inr|usd|eur|gbp|\$|£|€)\y'
    -- An amount named in words rather than symbols. "2 lakh" is a price.
    or p_body ~* '[0-9][0-9,. ]*\s*(rupees?|lakhs?|crores?|thousand|million)\y'
    -- A discount. Not every percentage: "50% complete" is an honest sentence,
    -- and blocking it would teach whoever hits it to route around the guard.
    or p_body ~* '[0-9]+\s*%\s*(off|discount|less)\y'
    or p_body ~* '\ydiscount\s+of\s+[0-9]'
  );
$$;

comment on function crm.states_a_price(text) is
  'Whether a message body states a monetary amount or a discount (ADM-22). Deliberately money-only: ADM-11 also names delivery promises, and a matcher for a promise is a matcher for intent, which nobody has decided. Percentages alone are not a discount - "50% complete" is an honest sentence.';

-- ── 2. the rule, on the row rather than in one writer ────────────────────
create or replace function crm.refuse_unread_price()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- An agency message with a human behind it is exactly what ADM-22 wants:
  -- every price quoted per client, by a person. Only the unread path is bound.
  if new.author_type = 'user' and new.author_id is null
     and crm.states_a_price(new.body) then
    raise exception
      'an automated message may not state a price (ADM-22); a human must author anything that quotes one'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists refuse_unread_price on crm.conversation_messages;

create trigger refuse_unread_price
  before insert or update of body, author_id, author_type
  on crm.conversation_messages
  for each row
  execute function crm.refuse_unread_price();

comment on function crm.refuse_unread_price() is
  'Refuses an agency message that states a price when no human authored it (ADM-11 x ADM-22). ADM-11 grants automatic sending and names the risk; ADM-22 forbids an agent stating a price at any level. A message with author_id set is a person quoting per client, which is the thing ADM-22 says should happen, and is exempt. Fires on UPDATE of body as well as INSERT, so a price cannot be edited in after the fact.';
