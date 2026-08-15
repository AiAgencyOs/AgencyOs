-- ═══════════════════════════════════════════════════════════════════════════
-- A monitor that does not lie.
--
-- Gap G-053, two ways the alert path could go quiet — or shout twice — about
-- a live problem.
--
-- ── the claim that outlived its delivery ──────────────────────────────────
--
-- `claim_alert` stamps `last_sent_at = now()` the moment it decides to send,
-- BEFORE the webhook is actually posted. So if the post then fails — a five
-- second blip at two in the morning — the cooldown is already running, and
-- the same situation is suppressed for an hour though nobody was ever told.
-- The claim recorded an intention, not a delivery.
--
-- `release_alert` undoes the claim when delivery fails, so the next tick
-- re-claims and tries again. It is guarded by a COMPARE-AND-SWAP on the claim
-- instant, not merely the signature: a signature is a count-fingerprint that
-- recurs (a queue depth wobbling 3→4→3), so signature alone would let a stale
-- release rewind a DIFFERENT, later, successful claim that happened to carry
-- the same fingerprint — and page for it twice. `claim_alert` now returns the
-- instant it stamped, the caller carries it, and `release_alert` rewinds only
-- the row still holding exactly that instant. A newer claim moved the instant
-- on, so it is safe.
--
-- ── the alert that reset too eagerly ──────────────────────────────────────
--
-- When the backlog clears, the state is removed so a problem that failed,
-- healed, and returned with the same counts is sent again rather than
-- suppressed as a duplicate of the one that went away. But a DEGRADED signal
-- flaps: a queue depth crossing the fifteen-minute line, recovering, crossing
-- again. Clearing on every healthy tick would reset the cooldown each time and
-- page far more than once an hour. So recovery clears only a FAILING alert —
-- dead jobs, unpublished events, which are monotonic and do not flap — and
-- leaves a degraded one to expire on its cooldown. A returning failure is
-- heard immediately; a flapping degraded state is heard once an hour.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── claim now returns the instant it stamped ──────────────────────────────
--
-- Return-type change (boolean → timestamptz), so drop first. NULL means not
-- claimed (suppressed); a timestamp is the claim instant the caller carries to
-- release_alert as its compare-and-swap key.

drop function if exists core.claim_alert(text, text, int);

create function core.claim_alert(
  p_key            text,
  p_signature      text,
  p_cooldown_hours int default 1
)
returns timestamptz
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  insert into core.alert_state (key, signature, last_sent_at)
  values (p_key, p_signature, now())
  on conflict (key) do update
     set signature    = excluded.signature,
         last_sent_at = now()
   where core.alert_state.signature is distinct from excluded.signature
      or core.alert_state.last_sent_at < now() - make_interval(hours => p_cooldown_hours)
  returning last_sent_at into v_at;

  return v_at;
end;
$$;

comment on function core.claim_alert(text, text, int) is
  'The instant to record against this send when it should go out, or NULL when the cooldown suppresses it (G-053). The situation changed, or the cooldown elapsed while it persisted. Decided and recorded in one statement, so two overlapping cron invocations cannot both send. Returns the stamped instant so release_alert can undo THIS claim and not a later one that reused the same signature.';

-- ── release, guarded on the claim instant ─────────────────────────────────

create or replace function core.release_alert(p_key text, p_claimed_at timestamptz)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_released boolean;
begin
  update core.alert_state
     set last_sent_at = '-infinity'::timestamptz,
         updated_at   = now()
   where key = p_key
     and last_sent_at = p_claimed_at
  returning true into v_released;

  return coalesce(v_released, false);
end;
$$;

comment on function core.release_alert(text, timestamptz) is
  'Undoes a claim whose delivery failed, so the next tick re-sends (G-053). Rewinds last_sent_at only when it still equals the instant claim_alert returned to this caller — a compare-and-swap, so a newer claim (which moved the instant on, even for the same recurring signature) is never rewound and never double-sent.';

-- ── clear, only for a failing alert ───────────────────────────────────────

create or replace function core.clear_alert(p_key text)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_cleared boolean;
begin
  delete from core.alert_state
   where key = p_key
     -- Only a failing alert is cleared on recovery. Failing signals (dead
     -- jobs, unpublished events) are monotonic and do not flap, so clearing
     -- them lets a genuinely-returned failure be heard at once. A degraded
     -- signal flaps across its threshold, and clearing it would page every
     -- crossing; it expires on its cooldown instead.
     and signature like 'failing:%'
  returning true into v_cleared;

  return coalesce(v_cleared, false);
end;
$$;

comment on function core.clear_alert(text) is
  'Removes the alert state on recovery, but only for a FAILING alert (G-053). A returned failure is then sent again rather than suppressed as a duplicate of the one that went away. A degraded alert is left to its cooldown, because a degraded signal flaps across its threshold and clearing on every crossing would page more than once an hour.';

revoke all on function core.claim_alert(text, text, int) from public;
revoke all on function core.release_alert(text, timestamptz) from public;
revoke all on function core.clear_alert(text) from public;
grant execute on function core.claim_alert(text, text, int) to service_role;
grant execute on function core.release_alert(text, timestamptz) to service_role;
grant execute on function core.clear_alert(text) to service_role;
