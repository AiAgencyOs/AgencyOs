#!/usr/bin/env bash
# Red-proof one control: mutate the LIVE function definition (pg_get_functiondef + replace), prove the verifier goes red, then restore it by
# re-applying the migration that defines it. A mutation that changes nothing RAISES (a no-op mutation would "prove" nothing).
#
#   PSQL_CMD="psql -h <socket dir> -p 55454 -U postgres -d agencyos_local -v ON_ERROR_STOP=1 -q" \
#     scripts/p13-red-proof.sh <migration.sql> <verifier.sql> '<schema.fn(argtypes)>' '<exact text to replace>' '<replacement>'
#
# Prints RED-PROVED or NOT-RED. Scratch Postgres only.
set -uo pipefail
MIG="$1"; VER="$2"; FN="$3"; FROM="$4"; TO="$5"
: "${PSQL_CMD:?set PSQL_CMD}"
OUT="${TMPDIR:-/tmp}"
if ! $PSQL_CMD -v fn="$FN" -v from="$FROM" -v to="$TO" >/dev/null 2>"$OUT/p13-mutate.err" <<'SQL'
select set_config('p13.fn', :'fn', false), set_config('p13.from', :'from', false), set_config('p13.to', :'to', false) \gset
do $$
declare d text; m text;
begin
  d := pg_get_functiondef(current_setting('p13.fn')::regprocedure);
  m := replace(d, current_setting('p13.from'), current_setting('p13.to'));
  if m = d then raise exception 'NO-OP MUTATION: % not found in %', current_setting('p13.from'), current_setting('p13.fn'); end if;
  execute m;
end $$;
SQL
then
  echo "MUTATION FAILED: $(tail -1 "$OUT/p13-mutate.err")"
  exit 2
fi
if $PSQL_CMD -f "$VER" >/dev/null 2>"$OUT/p13-verify.err"; then
  RESULT="NOT-RED (verifier stayed green)"
else
  RESULT="RED-PROVED: $(grep -m1 'FAILED\|ERROR' "$OUT/p13-verify.err" | cut -c1-160)"
fi
$PSQL_CMD -f "$MIG" >/dev/null 2>&1 || { echo "RESTORE FAILED"; exit 3; }
echo "$RESULT"
