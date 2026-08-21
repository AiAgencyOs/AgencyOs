-- ═══════════════════════════════════════════════════════════════════════════
-- A second agent can be reached.
--
-- ADM-82 granted thirteen agents. Twelve were installed disabled, and enabling
-- any of them would have changed nothing: the job runner named one agent in a
-- module-level constant — `const AGENT_KEY = 'requirement_collector'` — so
-- there was no queue to feed the others from. `enabled` would have gone true,
-- the Admin screen would have shown twelve agents running, and not one of them
-- could have received a single piece of work. That is the failure this system
-- has spent a week removing everywhere else: telling an operator something
-- untrue about itself.
--
-- The runner now dispatches from a registry of workflows. This is the other
-- half — the event that gives the second agent something to do, and the flag
-- that lets it.
--
-- ── which agent, and why this one ────────────────────────────────────────
--
-- ADM-82 defines `support` as the agent that *"answers client questions from
-- approved knowledge and classifies what is reported."* This is the second
-- clause and only the second clause.
--
-- Doc 18 §6 separates two questions that arrive together. **What kind of thing
-- is this?** — §8's twelve types — is descriptive: a dependency update is a
-- dependency update whoever ends up paying for it. **Is it covered?** —
-- warranty, maintenance, change request, new project, upsell — is the
-- commercial decision, and §35 forbids one direction of getting it wrong by
-- name: *"Never classify new scope as maintenance to avoid approval."*
--
-- So the agent answers the first and is never asked the second. Not instructed
-- not to — **given no field to put an answer in**: `maintenanceTriageSchema`
-- declares `ticketType` and `rationale` and nothing else, and is `.strict()`.
-- A model cannot return a key that is not in the schema. Third time this
-- system has expressed a prohibition as an absence rather than a guard, after
-- ADM-22's missing pricing tool and Doc 15's missing `verified_by_agent`.
--
-- `coverage` stays exactly where PR #276 left it: written by a person, and
-- refused by `refuse_miscoded_maintenance` when it disagrees with the exit the
-- ticket takes.
--
-- ── the event, which Doc 23 §7 already named ─────────────────────────────
--
-- `SupportTicketCreated` is the twenty-fourth of §7's canonical business
-- events and was one of the twenty this system did not emit. It does now, from
-- the row whose creation it describes, and the subscription lives in
-- `src/lib/events/catalog.ts` beside every other one — so the agent inherits
-- the retry budget, the backoff, the parking, the autonomy gate and the cost
-- ceiling rather than growing its own. An agent wired in beside those rather
-- than behind them would be an agent that can skip them.
--
-- ── and one flag, not twelve ─────────────────────────────────────────────
--
-- `support` is enabled because there is now something it can do. The other
-- eleven stay disabled and keep the `disabled_reason` that says why — ADM-82's
-- activation gates are per layer, and a flag flipped ahead of a workflow is
-- the lie this migration exists to avoid. Two of thirteen, and the number is
-- honest.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('support_ticket.created', 'A maintenance request was raised (Doc 18 §7).', 'SupportTicketCreated')
on conflict (type) do nothing;

update core.canonical_events
   set emitted_as = 'support_ticket.created'
 where name = 'SupportTicketCreated';

create or replace function projects.emit_support_ticket_created()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform core.emit_event(
    new.organization_id, 'support_ticket.created', 'maintenance_item', new.id,
    jsonb_build_object(
      'project_id', new.project_id,
      'client_account_id', new.client_account_id,
      'title', new.title
    )
  );
  return new;
end;
$$;

drop trigger if exists emit_support_ticket_created on projects.maintenance_items;
create trigger emit_support_ticket_created
  after insert on projects.maintenance_items
  for each row execute function projects.emit_support_ticket_created();

-- ── the flag, and the reason it is now true ──────────────────────────────
--
-- `agents_disabled_reason_together` makes this one statement rather than two:
-- an enabled agent may not carry a reason it cannot run, because that reason
-- would be false.

update ai.agents
   set enabled = true,
       disabled_reason = null
 where key = 'support';

comment on function projects.emit_support_ticket_created() is
  'Doc 23 section 7''s SupportTicketCreated, emitted from the row whose creation it describes. The subscription in src/lib/events/catalog.ts turns it into a maintenance.triage job, which the agent runner claims like any other - so the support agent inherits the retry budget, backoff, parking, autonomy gate and cost ceiling instead of growing its own.';

notify pgrst, 'reload schema';
