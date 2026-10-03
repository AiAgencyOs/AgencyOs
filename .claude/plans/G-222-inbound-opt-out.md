# G-222 — An inbound STOP is never heard

## The gap (audit finding, verified against code)

A client who has been messaged can reply "STOP" and **nothing withdraws their
consent.** The system is asymmetric:

- **Grant is automatic** — `crm.record_inbound_consent()` (migration
  `20260822310000`) writes a `granted` row on the first inbound client message.
- **Withdrawal is manual-only** — there is no inbound path that writes a
  `withdrawn` row. The follow-up worker hardcodes `optedOut: false`
  (`src/modules/crm/follow-up-worker.ts:478`).

The blocking machinery already works *once a withdrawn row exists*:
`hasConsent()` (`follow-up-worker.ts:229`) returns false for `withdrawn`, and
`crm.send_outbound_message` refuses on `withdrawn` before its idempotency
lookup. **So the only missing piece is the producer: something that records the
withdrawal when a client asks to stop.** This is the P0 compliance blocker from
the audit — at 1,200-lead reactivation scale, ignoring STOP is a real hazard.

Decisions taken with the owner this session, recorded as **ADM-101**:
- Keyword set: English (STOP, UNSUBSCRIBE, CANCEL, END, QUIT, OPT OUT, REMOVE)
  **plus** curated Hindi/Hinglish (band karo, mat bhejo / message mat karo,
  nahi chahiye, बंद करो, मत भेजो, नहीं चाहिए), matched as **whole words/phrases**
  (Postgres `\y`, not substring) to limit false positives.
- **Silent withdraw**: record the withdrawal and go quiet. No confirmation send
  (any auto-send right after an opt-out is the exact shape the consent guard
  exists to prevent).

## Constraints this must respect (already in the schema)

1. `crm.communication_consent` PK is `(organization_id, contact_id, channel)`;
   status ∈ `granted|withdrawn`; withdrawn is a **row, not a deletion**.
2. `consent_reject_delete` + `consent_freeze_identity`
   (`20260815130000_authority_cannot_be_forged.sql`) forbid delete/reparent.
   Withdrawal must be an **UPDATE** (or insert-then-update), never delete+insert.
3. Withdrawal must **win over a concurrent/last grant** — a STOP is final for
   that channel; a later inbound message must not silently re-grant
   (`record_inbound_consent` is already `on conflict do nothing`, so it can't).
4. Same firing point as the grant: `after insert on crm.conversation_messages`,
   `author_type = 'client'` only, resolve `contact_id` from the conversation,
   `security definer`, `set search_path = ''`.
5. Tenancy: writes stay inside the org resolved from the row; no new table, so
   no new tenancy-guard trigger needed (reuses existing table's guards).

## Approach — one migration + one worker fix + tests, single PR (G-222)

### 1. Migration `supabase/migrations/2026090714XXXX_an_inbound_stop_is_heard.sql`
- `crm.reads_as_opt_out(p_body text) returns boolean` — mirrors
  `crm.states_a_price`: a documented regex over the agreed keyword set, `\y`
  word boundaries, case-insensitive, Hindi Unicode included. Written as its own
  function so it can be **exercised directly** (the repo's pattern).
- `crm.record_inbound_opt_out()` trigger function:
  - returns early unless `author_type = 'client'` and `reads_as_opt_out(body)`;
  - resolves `contact_id` from `crm.conversations` (early-return if null — a
    group thread has no single contact, matching the grant trigger);
  - `insert ... (status 'withdrawn', source 'inbound_message', note '<msg id>')
    on conflict (organization_id, contact_id, channel) do update set
    status='withdrawn', ...` — **UPDATE on conflict**, so it survives the
    delete/reparent guards and flips an existing `granted` row to `withdrawn`.
    The audit trigger fires on INSERT OR UPDATE, so the withdrawal is recorded.
  - Idempotent: withdrawing an already-withdrawn row is a no-op write.
- `create trigger record_inbound_opt_out after insert on
  crm.conversation_messages for each row execute ...`. Trigger name orders
  **after** `record_inbound_consent` alphabetically? No — Postgres fires
  per-row triggers in **name order**: `record_inbound_consent` <
  `record_inbound_opt_out`, so grant fires first, then opt-out flips it to
  withdrawn in the same statement. Correct outcome regardless, because opt-out
  is an UPDATE-to-withdrawn and record_inbound_consent is do-nothing-on-conflict.
- `notify pgrst, 'reload schema';`

### 2. Worker fix — `src/modules/crm/follow-up-worker.ts`
- Replace the hardcoded `optedOut: false` (line 478) with a real read. Cheapest
  correct form: extend `hasConsent` to return the status (or add `isOptedOut`)
  and pass `optedOut: status === 'withdrawn'`. Since `hasConsent` already treats
  withdrawn as "no send", this is belt-and-suspenders that also makes the
  contract's `opted_out` reason fire truthfully instead of `no_consent`.

### 3. Tests + live verifier
- `tests/an-inbound-stop-is-heard.test.ts` — unit-test `reads_as_opt_out`
  patterns via the pure-logic layer where possible; assert the keyword matrix
  (positives: "STOP", "please stop", "band karo", "mat bhejo", "नहीं चाहिए";
  negatives: "non-stop delivery", "stopwatch", "I stopped by yesterday",
  "can you add a stop button"). Guard against substring false-positives.
- Extend an existing live verifier (or add
  `scripts/verify-inbound-opt-out.mjs`): against a real DB, insert an inbound
  "STOP" from a consented contact, assert the row is now `withdrawn`, assert a
  subsequent `send_outbound_message` is refused, assert a later inbound message
  does **not** re-grant. Wire into `package.json` + CI `verify`.

### 4. Red-proof (repo discipline)
- Mangle the trigger in the **live** migration (e.g. neuter `reads_as_opt_out`
  to `return false`) and show the verifier failing — proving the control, not
  the reading. Print evidence from `pg_trigger`/the withdrawn row, per the
  repo's "a red-proof can silently not run" rule.

### 5. Record-keeping (CI `check:record` enforces this)
- `docs/roadmap/roadmap.json`: new `G-222` gap record (area crm, class C→A,
  risk P0, this PR's evidence) + `ADM-101` decision record (keyword set +
  silent-withdraw).
- `AGENCYOS_MASTER_DEVELOPMENT_PLAN.md` §10: a change-log row `(this change)`
  for G-222, and convert G-221's `(this change)` to its merged hash/PR per the
  change-log discipline.

## Verification before I hand back
`npm run typecheck && npm run lint && npm run test && npm run check:record`, the
new live verifier against the local Supabase, and the red-proof with printed
evidence. I will report exactly what passed and what (if anything) I could not
run (e.g. live DB unavailable).

## Explicitly NOT in this PR
- Cross-number identity / contact merge (separate G-item).
- Contact-level timezone (G-137).
- Agent global on/off settings UI (separate P1 item).
- Any confirmation/notification send on opt-out (decided against).

## Risk
Low and self-contained: no new table, reuses the proven consent chokepoint and
its guards, adds only a producer + a truthful read. The one thing to get right
is the regex (false positives silence live clients) — hence whole-word matching,
an explicit negative-case test suite, and the red-proof.
