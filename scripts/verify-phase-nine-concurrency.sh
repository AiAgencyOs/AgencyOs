#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Phase 9B: a MEASURED two-session concurrency proof of the project financial close.
#
# Two real psql sessions race to close the SAME project's finances:
#   session A closes it and then HOLDS its transaction open (pg_sleep) so it still owns the close lock (the project row, then the invoice rows);
#   session B starts a second later and calls the same door.
# Asserted: B WAITED for A (it took about as long as A's remaining hold), B then answered already_closed (it did not close a second time), there is
# exactly ONE snapshot row for the project and exactly ONE audit row for the close.
#
# NEEDS: psql and VERIFY_DB_URL (a database with every migration applied) and nothing else.
# COMMITS ROWS: two sessions cannot see each other's uncommitted work, so the fixture (its own organization, user, client, project, one milestone, one
# verified invoice) is committed, and a financial close is history that can never be deleted. Run it only against a scratch database, and set
# CONFIRM_COMMIT=1 to say so. It is therefore NOT part of the CI chain (the shared CI database must stay free of committed fixtures); run it by hand:
#
#   CONFIRM_COMMIT=1 VERIFY_DB_URL=postgresql://... scripts/verify-phase-nine-concurrency.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

: "${VERIFY_DB_URL:?set VERIFY_DB_URL to a scratch database with every migration applied}"
[ "${CONFIRM_COMMIT:-0}" = "1" ] || { echo "refusing: this commits fixture rows; set CONFIRM_COMMIT=1 and use a scratch database" >&2; exit 2; }

PSQL=(psql "$VERIFY_DB_URL" -v ON_ERROR_STOP=1 -X -q -tA)
WORK="$(mktemp -d "${TMPDIR:-/tmp}/p9-concurrency.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAILED: $1" >&2; exit 1; }

# ── fixture (committed) ──
ORG="$(uuidgen | tr 'A-Z' 'a-z')"; FIN="$(uuidgen | tr 'A-Z' 'a-z')"; ADM="$(uuidgen | tr 'A-Z' 'a-z')"
TAG="$(echo "$ORG" | cut -c1-8)"
read -r PROJECT INVOICE < <("${PSQL[@]}" -F ' ' <<SQL
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
insert into core.organizations (id, name, slug) values ('$ORG', 'P9 concurrency $TAG', 'p9-conc-$TAG');
insert into auth.users (id, email) values ('$FIN', 'p9c-f-$TAG@example.test'), ('$ADM', 'p9c-a-$TAG@example.test');
insert into core.users (id, email, full_name) values ('$FIN', 'p9c-f-$TAG@example.test', 'P9C Finance'), ('$ADM', 'p9c-a-$TAG@example.test', 'P9C Admin') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values ('$ORG', '$FIN', 'finance'), ('$ORG', '$ADM', 'owner');
with c as (insert into core.client_accounts (organization_id, name) values ('$ORG', 'p9c client $TAG') returning id),
     p as (insert into projects.projects (organization_id, client_account_id, name, project_code) select '$ORG', c.id, 'p9c project $TAG', 'P9C-$TAG' from c returning id, client_account_id),
     m as (insert into projects.milestones (organization_id, project_id, name, position, amount_minor, currency) select '$ORG', p.id, 'M1', 1, 10000, 'INR' from p returning id, project_id),
     i as (insert into finance.invoices (organization_id, client_account_id, project_id, milestone_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at, due_at)
           select '$ORG', p.client_account_id, p.id, m.id, 'P9C-$TAG-1', 'issued', 10000, 0, 10000, now(), now() + interval '30 days' from p join m on m.project_id = p.id returning id, project_id)
select i.project_id, i.id from i;
commit;
SQL
)
[ -n "${PROJECT:-}" ] && [ -n "${INVOICE:-}" ] || fail "the fixture was not created"
PAY="$("${PSQL[@]}" <<SQL
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select payment_id from finance.record_manual_payment('$INVOICE', 'UTR-P9C-$TAG', 10000, now(), 'upi');
commit;
SQL
)"
[ -n "$PAY" ] || fail "the fixture payment was not recorded"
OUT="$("${PSQL[@]}" <<SQL
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true) \g /dev/null
select outcome from finance.verify_payment('$PAY', '$ADM');
commit;
SQL
)"
[ "$OUT" = "verified" ] || fail "the fixture payment was not verified by the runner path (got: $OUT)"

CLAIMS="{\"sub\":\"$FIN\",\"role\":\"authenticated\",\"app_metadata\":{\"organization_id\":\"$ORG\",\"role\":\"finance\"}}"

# ── the race ──
# A: closes, then keeps the transaction (and so the project / invoice row locks) open for 4 seconds.
( "${PSQL[@]}" -F '|' > "$WORK/a.out" <<SQL
begin;
select set_config('request.jwt.claims', '$CLAIMS', true);
select 'A', outcome, clock_timestamp() from finance.close_project_finances('$PROJECT', 'concurrency proof, session A');
select pg_sleep(4);
commit;
SQL
) &
PID_A=$!
sleep 1
# B: starts while A holds the lock, and times how long the door takes to answer.
( "${PSQL[@]}" -F '|' > "$WORK/b.out" <<SQL
begin;
select set_config('request.jwt.claims', '$CLAIMS', true);
select 'T0', extract(epoch from clock_timestamp());
select 'B', outcome from finance.close_project_finances('$PROJECT', 'concurrency proof, session B');
select 'T1', extract(epoch from clock_timestamp());
commit;
SQL
) &
PID_B=$!
wait "$PID_A" || fail "session A did not finish cleanly"
wait "$PID_B" || fail "session B did not finish cleanly"

A_OUT="$(grep '^A|' "$WORK/a.out" | cut -d'|' -f2)"
B_OUT="$(grep '^B|' "$WORK/b.out" | cut -d'|' -f2)"
T0="$(grep '^T0|' "$WORK/b.out" | cut -d'|' -f2)"
T1="$(grep '^T1|' "$WORK/b.out" | cut -d'|' -f2)"
WAITED="$(awk -v a="$T0" -v b="$T1" 'BEGIN { printf "%.2f", b - a }')"
echo "session A: $A_OUT   session B: $B_OUT   B waited ${WAITED}s"

[ "$A_OUT" = "closed" ] || fail "session A should have closed the project (got: $A_OUT)"
[ "$B_OUT" = "already_closed" ] || fail "session B should have been refused as already_closed (got: $B_OUT)"
awk -v w="$WAITED" 'BEGIN { exit !(w >= 2.0) }' || fail "session B did not wait for A's lock (waited only ${WAITED}s): the close is not serialised"

SNAPSHOTS="$("${PSQL[@]}" -c "select count(*) from finance.project_financial_closes where project_id = '$PROJECT'")"
AUDITS="$("${PSQL[@]}" -c "select count(*) from audit.audit_log where subject_id = '$PROJECT' and action = 'finance.project_financially_closed'")"
EVALS="$("${PSQL[@]}" -c "select count(*) from finance.financial_close_evaluations where project_id = '$PROJECT'")"
echo "snapshot rows: $SNAPSHOTS   close audit rows: $AUDITS   evaluations: $EVALS"
[ "$SNAPSHOTS" = "1" ] || fail "exactly one snapshot row expected (got $SNAPSHOTS)"
[ "$AUDITS" = "1" ] || fail "exactly one close audit row expected (got $AUDITS)"
[ "$EVALS" = "1" ] || fail "only the closing session records an evaluation; the refused one returned before evaluating (got $EVALS)"

echo "PHASE 9 CONCURRENCY OK (fixture organization $ORG stays: a financial close is history)"
