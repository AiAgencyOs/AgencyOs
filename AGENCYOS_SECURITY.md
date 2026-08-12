# AGENCYOS_SECURITY.md

Authentication, authorization, tenant isolation, secrets, and where each is
enforced.

**Baseline:** commit `2881caa`, 2026-08-11.

---

## 1. Authentication

Two audiences, one system.

| Audience | Roles | Sign-in |
| --- | --- | --- |
| Internal staff | `owner`, `ops_admin`, `delivery_lead`, `member`, `contractor` | Google OAuth or magic link |
| Clients | `client_admin`, `client_member` | Magic link |

Supabase Auth issues the session. `core.handle_new_auth_user()` provisions the
`core.users` row; `core.bootstrap_first_owner()` gives the first user of an empty
deployment the `owner` role — and the token is refreshed immediately afterwards,
because a JWT minted before the membership existed carries no role.

**That bootstrap is serialised, since D19.** It counted memberships and inserted
in a later statement with nothing held between, so simultaneous first sign-ins
all passed the same guard. Measured with eight concurrent callers on an unfixed
build, all eight were provisioned as `owner` — in four rounds out of five. Sign-up
is open (`shouldCreateUser: true`, no domain allowlist), so the callers need not
have been invited, and nothing in the application demotes a membership.

It now takes `pg_advisory_xact_lock` on a key derived from its own name before
it reads anything, and re-decides both counts through it. A lock rather than a
constraint because the predicate is "`core.memberships` is empty", which is a
statement about a table and not about any row. `scripts/verify-first-owner.mjs`
races it eight ways, five times, against the real function.

`proxy.ts` (Next 16's middleware convention) does one thing: refresh the session.
Route guards live in the route-group layouts, because role claims are only
meaningful once the session is resolved — `(internal)` calls `requireInternal()`,
`(client)` calls `requireClient()`, and an authenticated user with no membership
lands on `/no-access` rather than a blank internal page.

Those guards are a convenience boundary, not the security boundary. **RLS
independently refuses to return rows to a principal without the right claims**,
so a bug in a layout leaks navigation, not data.

---

## 2. JWT claims drive RLS

`core.custom_access_token_hook` stamps the token at sign-in:

```
organization_id · role · client_account_id (client users only)
```

Every policy reads these through helper functions rather than parsing claims
inline:

```
core.current_organization_id()   core.current_user_role()
core.current_client_account_id() core.is_internal()
core.is_client()                 core.can_write()
core.is_owner()                  core.is_admin()
```

All are `SECURITY DEFINER … SET search_path = ''`, so a policy cannot be
subverted by a caller's search path.

---

## 3. Two layers of authorization

RLS and capabilities answer different questions, and both are required.

**RLS** answers *"which rows may this principal see or write at all?"* — enabled
on all 27 tables, no exception.

They agreed only after D16. Until then RLS was the *wider* layer:
`invoices_select` admitted every internal role, so a `contractor` could read
the whole invoice book through the Data API, and the `projects`, `milestones`,
`crm` and `sales` write policies gated on `core.can_write()`, which admits
`member`. The application refused all of it; the database — the thing this
document calls the backstop — did not.

Each of those policies now admits exactly the roles holding the matching
capability, and `scripts/verify-milestone-invoicing.mjs` §7e proves it per role
against the real policies, with an owner control first so that "sees nothing"
cannot pass by accident.

Two tiers remain broader than any capability, deliberately and recorded rather
than guessed: `projects.tasks` stays on `can_write()`, which is *narrower* than
`task.write` and so fails closed; and `crm.conversations`,
`crm.conversation_messages`, `core.client_accounts` and `core.client_users`
have no published capability to narrow to.

**Capabilities** answer *"may this principal perform this action?"* — a question
RLS cannot express. Static, dependency-free, in `src/lib/authz/permissions.ts`,
so there is no database round trip on the hot path and the whole matrix is
unit-testable.

| Capability group | owner | ops_admin | delivery_lead | member | contractor | client_admin | client_member |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lead.*` | ✓ | ✓ | read | read | — | — | — |
| `proposal.draft/send` | ✓ | ✓ | — | — | — | — | — |
| `proposal.approve` | ✓ | — | — | — | — | — | — |
| `project.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `project.write`, `milestone.write` | ✓ | ✓ | ✓ | — | — | — | — |
| `task.write` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `invoice.read` | ✓ | ✓ | — | — | — | ✓ | — |
| `invoice.create`, `invoice.issue` | ✓ | ✓ | — | — | — | — | — |
| `refund.issue` | ✓ | — | — | — | — | — | — |
| `agent.run` | ✓ | ✓ | ✓ | — | — | — | — |
| `agent.configure`, `organization.settings` | ✓ | — | — | — | — | — | — |
| `member.invite`, `audit.read` | ✓ | ✓ | — | — | — | — | — |

`invoice.issue` deliberately covers payment recording and voiding as well: it
already resolves to exactly `owner + ops_admin`, which is also the set the
finance RLS policies admit. A separate capability mapping to an identical role
set would add vocabulary without adding control.

`refund.issue` is owner-only and **has no implementation behind it** (gap G-005).

---

## 4. Tenant isolation

The property: **a query by resource id alone is suspicious when the resource is
organization-scoped.**

Three enforcement points:

1. **RLS**, for every session-authenticated path. The organization predicate
   comes from the token, so a forged id in a request body changes nothing.
2. **Explicit predicates**, for every service-role path. The service role
   bypasses RLS entirely, so `/api/jobs/run` and the webhook handler scope every
   query by `organization_id` **taken from the job row or the resolved
   conversation — never from request input.**
3. **Cross-org tests**, in the live verification scripts.

Finding **C8** was exactly this class of defect: a requirement-version lookup by
`(conversation, transcript length)` without an organization predicate, where
another tenant's row at the same transcript length would suppress the extraction
and leak its id into the response. Fixed, and the reasoning is preserved in the
comment at that call site.

`core.shares_organization()` exists so a user-visibility policy does not have to
re-derive tenancy inline.

---

## 5. The service role

`createAdminClient()` bypasses RLS. It is marked `server-only`, so pulling it
into a client bundle fails the build.

**Sanctioned call sites, and no others:**

| Path | Why it needs the service role |
| --- | --- |
| `app/api/jobs/run` | `ai.agent_runs` has no INSERT policy for authenticated users, by design — an agent trace nobody can forge is the point |
| `app/api/webhooks/whatsapp` | The caller is Meta; there is no session |
| Migrations and `scripts/` | Setup and verification |

The rule for every one of them: **scope by hand, from a trusted source.**

Notably, `finance.record_manual_payment()` is `SECURITY INVOKER` rather than
definer, on purpose. It runs for a signed-in owner or ops_admin, and every table
it touches already has the right policy. Running it as definer would mean
re-deciding tenancy inside the function, which the policies already answer. **No
new privilege is created by it.**

---

## 6. Webhook security

```
1. read the raw body as text — once
2. HMAC-SHA256 over the raw bytes, compared with timingSafeEqual
3. only then parse
```

Properties worth keeping:

- **Signature before parse.** An unverified body is never interpreted.
- **Unconfigured is 503, not open.** A deployment with no secret is inert. The
  same is true of the job runner: no `CRON_SECRET` means 503, not an open route.
- **Constant failure bodies.** `unauthorized`, `forbidden`, `disabled` — nothing
  echoes a secret, token, signature or any part of one.
- **Secrets are arguments, not environment reads,** in
  `src/lib/whatsapp/verify.ts` and `src/lib/cron-auth.ts`. A test supplies its
  own, so nothing there can leak a configured one.
- **The message body is never logged.** The content is the thing being protected.
- **The subscription handshake checks the mode as well as the token.** A correct
  token under a mode we do not implement is refused rather than guessed at.

The cron secret is compared against the whole `Authorization` header value, so
the `Bearer ` scheme is required by construction and every malformed variant
fails closed.

---

## 7. Audit trail

`audit.audit_log` is **append-only, and not merely by policy**:
`audit.reject_mutation()` fires `BEFORE UPDATE` and `BEFORE DELETE` and raises
`insufficient_privilege`. RLS could be misconfigured; the trigger still holds.

Each row records actor, organization, action, subject, before, after, correlation
id and timestamp. There are 15 call sites, covering every gated transition in all
five modules.

Reading it requires `audit.read` — owner and ops_admin.

---

## 8. Secrets

| | |
| --- | --- |
| **In the repo** | `.env.example` and `.env.verify.local.example` — placeholders only |
| **Gitignored** | `.env.local`, `.env.verify.local` |
| **Verified** | `scripts/scan-secrets.mjs`, in CI and in `npm run check`. Scans `git ls-files` for eight credential shapes and refuses to let an `.env.local`-family file be tracked at all |
| **Validation** | `src/lib/env.ts` validates required variables at first use; a missing one is a startup failure, not an undefined at runtime |
| **Never in** | source, tests, migrations, PR descriptions, logs, client-visible messages |

Handover will involve real credentials (directive §22). The mechanism for
transferring them is **undecided** — ADM-15 — and until it is decided, no
handover feature should be built.

---

## 9. Error and log hygiene

Failures log structured JSON to stdout with a `scope` and the database's own
message, never the payload that caused them. Client-facing messages carry the
`Result` error code and a human sentence; they do not carry database detail.

One deliberate exception in the other direction: `ai.agent_steps` stores the raw
model response *before* validation. When validation rejects a payload there is no
requirement version to inspect and that row is the only place the malformed
output survives. It stores the request *shape* — model, effort, schema, message
count, system prompt — and never a copy of the transcript, because the transcript
already lives in `crm.conversation_messages` under RLS and duplicating customer
text into the `ai` schema would spread the same PII across two owners for no
diagnostic gain.

---

## 10. Known security gaps

| ID | Gap | Risk |
| --- | --- | --- |
| ~~G-050~~ | **Closed.** CI runs every check on every PR, including migrations from scratch and seven live scripts | — |
| ~~G-051~~ | **Closed.** Repo-owned scan, self-testing, proven to fail on a planted key | — |
| G-053 | No monitoring or alerting; `console.error` to stdout only | P2 |
| G-054 | Read failures return `[]`, so a database error can render as "no invoices" | P1/P2 |
| G-040 | No approval engine — high-risk actions are role-gated, not approval-gated | P1 |
| ADM-15 | No sanctioned credential-transfer mechanism for handover | P1 |
| — | No dependency-vulnerability scanning | P2 |
| — | No rate limiting on any route | P2 |

---

## 11. Security review checklist

For any new feature, before it is proposed for merge:

- [ ] Every new table has RLS enabled and a policy per operation.
- [ ] Every new table carries `organization_id`, with a foreign key.
- [ ] Every service-role query scopes organization by hand, from a trusted source.
- [ ] Every mutation checks a capability before it runs.
- [ ] Every gated transition writes an audit row.
- [ ] Anything two callers could race is enforced in Postgres, not TypeScript.
- [ ] No secret is logged, echoed, returned or committed.
- [ ] Failures are refused honestly — never converted to `0`, `[]`, `null` or success.
- [ ] A cross-organization test proves the isolation, rather than asserting it.
