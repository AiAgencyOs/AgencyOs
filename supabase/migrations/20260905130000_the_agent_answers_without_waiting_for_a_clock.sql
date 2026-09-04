-- ═══════════════════════════════════════════════════════════════════════════
-- The agent answers without waiting for a clock — G-209
-- ═══════════════════════════════════════════════════════════════════════════
--
-- There is no artificial delay anywhere in this system. The reply latency
-- comes from something less obvious and larger: **nothing runs when a message
-- arrives.** The webhook ingests, writes a `reply.due` event and returns; the
-- agent wakes only when the external cron POSTs `/api/jobs/run`, at
-- `rate(1 minute)`.
--
-- One tick does dispatch the event AND drain the job it creates — worth
-- checking, because it makes the wait one tick rather than two — but a client
-- sits in silence for anywhere from zero to sixty seconds before the agent
-- begins to think, and the model's own time comes after that. On WhatsApp
-- that is the difference between a person and a batch process.
--
-- ── why this is a SETTING and not simply the behaviour ────────────────────
--
-- The first version of this change made the webhook ring the runner
-- unconditionally. It worked — proved live, at `327 → 328` ticks with nobody
-- turning the crank — and it broke three verification scripts, which is where
-- the real objection surfaced.
--
-- Those scripts were not wrong. They own the clock deliberately: they assert
-- what ONE tick does to ONE job, and they were written against a webhook
-- whose effects were synchronous. Making every deployment's inbound path
-- asynchronous, implicitly, as a side effect of receiving a webhook, is a
-- large change to smuggle in under a latency fix.
--
-- As a setting it is three better things at once:
--
--   * an operator control. The honest open question about this feature is
--     invocation volume — one nudge per webhook REQUEST, and the total model
--     work is unchanged because it is bounded by what is queued rather than
--     by how often the runner is asked to look, but the concurrency is not.
--     If that ever binds, this is the switch that restores cron-only
--     behaviour, without a deploy.
--
--   * inert on arrival, which is the posture `infra/aws/cron` already takes
--     about the heartbeat itself: *"Deploying changes nothing about
--     production."* A capability that changes how every inbound message is
--     handled should be something somebody turns on.
--
--   * and the scripts that own tick timing keep owning it. `verify-flow-01`
--     §T turns it on for its own checks and off again, so the capability is
--     still proved end to end against the real webhook — by the one script
--     whose subject it is.
--
-- Default false. An agency that never turns it on has exactly today's
-- behaviour, which is the state every deployment is in right now.

alter table core.organizations
  add column if not exists wake_runner_on_inbound boolean not null default false;

comment on column core.organizations.wake_runner_on_inbound is
  'Whether an inbound WhatsApp message wakes the job runner immediately instead of waiting for the next scheduled tick (G-209). False by default: a client then waits up to a minute before the agent starts, which is what every deployment does today. Turning it on trades invocations for latency - the total model work is unchanged, being bounded by what is queued rather than by how often the runner is asked to look.';

-- ── the switch, owner-controlled and audited ──────────────────────────────
--
-- The same shape `core.set_reactivation_pilot` uses, and for the same reason:
-- the RPC is reachable by any authenticated caller, so a service-owned gate
-- would be one door on a room with two. An identity-less caller (service_role,
-- the verification scripts) passes, because it already holds the database.

create or replace function core.set_wake_runner_on_inbound(
  p_organization_id uuid,
  p_enabled boolean
)
returns table (outcome text)
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_before boolean;
begin
  if v_actor is not null and not (select core.is_owner()) then
    return query select 'forbidden'::text; return;
  end if;

  select o.wake_runner_on_inbound into v_before
    from core.organizations o where o.id = p_organization_id;

  if v_before is null then
    return query select 'not_found'::text; return;
  end if;

  update core.organizations
     set wake_runner_on_inbound = p_enabled
   where id = p_organization_id;

  perform core.record_audit(
    p_organization_id,
    case when p_enabled then 'runner.wake_on_inbound_enabled' else 'runner.wake_on_inbound_disabled' end,
    'organization', p_organization_id,
    jsonb_build_object('wake_runner_on_inbound', v_before),
    jsonb_build_object('wake_runner_on_inbound', p_enabled),
    null
  );

  return query select case when p_enabled then 'enabled' else 'disabled' end::text;
end;
$$;

comment on function core.set_wake_runner_on_inbound(uuid, boolean) is
  'Turn immediate wake-on-inbound on or off (G-209). Owner only in the DATABASE as well as the service. Audited both ways, because this changes how every inbound message is handled and "who turned it on" is the first question anybody asks about a latency or invocation-volume change.';

revoke all on function core.set_wake_runner_on_inbound(uuid, boolean) from public;
grant execute on function core.set_wake_runner_on_inbound(uuid, boolean) to authenticated, service_role;

notify pgrst, 'reload schema';
