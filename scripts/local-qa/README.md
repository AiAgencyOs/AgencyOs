# Local QA stack — the admin panel in a real browser, without Docker

`scripts/apply-migrations-locally.sh` already proves every migration applies
on a plain Postgres. This folder goes one step further: it puts the real
application in front of that database, signed in as any role, so the 71
screens can be rendered, screenshotted and probed — on a machine that has
no Docker daemon and no Supabase project.

```
Chromium ──► next dev (:3000) ──► gateway.mjs (:54321)
                                    ├── /rest/v1/*  → PostgREST (:54322) → scratch Postgres (RLS on)
                                    ├── /auth/v1/*  → a fake GoTrue whose tokens are stamped by the
                                    │                  repo's REAL core.custom_access_token_hook
                                    └── /realtime/* → 404 (no realtime server: the live pill must
                                                       degrade honestly, and that is itself a test)
```

Nothing here is a mock of the application: PostgREST, RLS, the token hook,
`bootstrap_first_owner`, the server actions and the pages are the real ones.
Only GoTrue is stood in for, by ~80 lines that mint HS256 tokens.

## Run it

```bash
# 1. a scratch Postgres with every migration (needs Postgres 16 binaries; not as root)
KEEP=1 TMPDIR=/tmp/pg scripts/apply-migrations-locally.sh
#    → prints the socket dir, e.g. /tmp/pg/agencyos-pg.XXXX

# 2. PostgREST (static binary from github.com/PostgREST/postgrest/releases)
psql -h <socket dir> -p 55432 -U postgres -d agencyos_local -c \
  "create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;"
cp scripts/local-qa/postgrest.conf.example /tmp/pg/postgrest.conf   # set host=<socket dir>
postgrest /tmp/pg/postgrest.conf &

# 3. the gateway — prints the anon and service JWTs on its first line
PGHOST_SOCK=<socket dir> node scripts/local-qa/gateway.mjs &

# 4. the app
cat > .env.local <<ENV
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon from step 3>
SUPABASE_SERVICE_ROLE_KEY=<service from step 3>
NEXT_PUBLIC_APP_URL=http://localhost:3000
SUPABASE_JWT_SECRET=local-stack-jwt-secret-agencyos-0123456789abcdef
CRON_SECRET=local-qa-cron-secret-0123456789
VAULT_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
ENV
npx next dev

# 5. sign in as any role — the FIRST sign-in becomes owner through bootstrap_first_owner,
#    exactly as on a fresh install; later ones name their role:
open 'http://localhost:3000/auth/callback?token_hash=login:owner@local.test&type=magiclink&next=/dashboard'
open 'http://localhost:3000/auth/callback?token_hash=login:finance@local.test:finance&type=magiclink&next=/dashboard'

# 6. every screen, three viewports, five roles, console errors, screenshots
npm i -D playwright-core   # not a project dependency; only this harness needs it
PRJ=<a project id> AGENT=customer_success CHROME=<path to chromium> SHOTS=/tmp/agencyos-qa \
  node scripts/local-qa/screens.mjs
```

Browse via `localhost`, not `127.0.0.1`: Next's dev server blocks
cross-origin requests for its own chunks and every page reports fourteen
403s otherwise — which is a dev-server artifact, not an application error.

## What it cannot do

- Realtime. There is no Realtime server, so `LiveRefresh` shows
  *Reconnecting*, then *Degraded*, and the polling safety net carries the
  screen. The push path is covered by `tests/realtime-*.test.ts` and by the
  publication check in `docs/AGENCYOS_ADMIN_TEST_MATRIX.md`.
- Eight of the 80 `scripts/verify-*.mjs` need a FRESH database (they assert
  "no memberships exist", create their own organizations, or start the model
  and Graph stubs the app must be pointed at before it boots). Run them
  before any browser QA, or on a second scratch database. The other 72 run
  as-is: `.env.verify.local` → this gateway, same `SUPABASE_JWT_SECRET`,
  the gateway's service JWT as `SUPABASE_SERVICE_ROLE_KEY`; the gateway
  implements the GoTrue admin-users endpoints they create fixtures with.

## The two-session realtime run (`npm run e2e:realtime`)

`tests/e2e/realtime-two-sessions.spec.mjs` is the §5 procedure of
`docs/AGENCYOS_ADMIN_TEST_MATRIX.md` as a script: two browser contexts (owner
and ops_admin) signed in through `/auth/callback`, five scenarios, and a
PostgREST read-back with the service-role key behind every screen assertion.
CI runs it in `.github/workflows/realtime.yml`. Locally it needs Docker,
because the push path needs a Realtime server, which this folder's gateway
does not have (it answers `/realtime/*` with 404 on purpose).

```bash
# 1. a fresh Supabase stack (migrations + seed) and its env
npm run verify:db:up                                  # supabase start && supabase db reset
cp .env.verify.local.example .env.verify.local        # then paste `supabase status -o json` values in
# 2. the app, built and started against it
set -a && . ./.env.verify.local && set +a
npm run build && npm run start &
# 3. playwright-core (not a project dependency) and a Chromium
npm i --no-save playwright-core                       # or PLAYWRIGHT_DIR=<dir whose node_modules has it>
export CHROME=/usr/bin/google-chrome                  # unset → the installed Chrome channel
# 4. the run
REALTIME_CONTAINER=$(docker ps --format '{{.Names}}' | grep ^supabase_realtime_) \
APP_URL=http://localhost:3000 npm run e2e:realtime
```

It prints one JSON line per scenario, writes `tests/e2e/out/summary.json`
and screenshots beside it (gitignored), and exits non-zero on any failure.
Without `REALTIME_CONTAINER` the fifth scenario (stop the Realtime container
→ *Reconnecting*, *Degraded*; start it → *Live* and the list catches up) is
reported as skipped and says why. Against this folder's gateway the sign-in
falls back to its `login:<email>:<role>` token, so scenarios 1–4 can be run
here too — but only the polling fallback is exercised, and the pill will not
say *Live*, so they fail honestly on the first pill assertion.
