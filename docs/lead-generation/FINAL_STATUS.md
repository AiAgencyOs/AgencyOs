# Lead generation & acquisition — final status and gap re-audit

Branch `feat/lead-gen-foundation` (twelve local commits on `origin/main` @ `72c23803`; nothing pushed, no pull request).
Re-audit date: 2026-10-05. Method: every claim below points at a file, a verifier, or a command that can be run again.

## Verdict

**`NOT_PRODUCTION_READY` for the five-engine, agent-driven system the specification describes. Ready for assisted use, pending two checks that have not been run.**

*Why not production-ready:* no provider adapter exists for any platform (Meta, Google Ads, Hostinger, LinkedIn, Instagram, Facebook,
any marketplace), no discovery source, and none of the acquisition agents - so nothing reaches out to a platform on its own.
That is a statement about what is **not built**, not about verification pending: it is the largest remaining body of work and most of it
needs a credential or a decision only the owner can give (`HUMAN_DEPENDENCIES.md`).

*Why "ready for assisted use":* every governed side effect has a real, verified by-hand path - a person does the act on the platform and
records it against the exact approved version, once, with the stops, policy, plan, limits and cap re-read at that moment - and every
number on the screens is read from the CRM or the ledger. Used that way it is complete, audited and refuses what it should.

*Two checks that have not been run (so do not read "verified" as covering them):*
1. **The first CI run.** Everything below ran locally against a scratch Postgres 16 and a local test/lint/type run (`npm run check`, exit 0).
   CI runs the same chain against the Supabase image; the first run there may find a first-run defect (it has, on earlier work).
2. **The pages were never rendered in a browser**, and `next build` is not runnable in this worktree (the symlinked `node_modules` breaks
   Turbopack). Type-checking, linting and the component tests pass; layout, focus order and the real round trip through a server action
   have not been looked at by anyone.

## What was verified, and how

| Evidence | Where | Result |
|---|---|---|
| 14 SQL verifiers driven as the real request roles (about 1,200 checks) | `scripts/verify-acquisition-*.sql`, `npm run db:verify:acquisition` | all pass from a from-zero apply of every migration |
| Red-proofs as an artifact (104 cases against the LIVE definitions; a shadowed case reports GREEN and is re-pointed) | `scripts/redproof/` | every case red, baseline restored and green |
| Type, lint, 8,755 unit/contract tests, secret scan, record check | `npm run check` | exit 0 |
| End to end across slices (one visitor, one prospect, funnel = campaign, stop reaches every action) | `scripts/verify-acquisition-e2e.sql` | pass |
| Three independent reviews (tenancy, governed execution, honesty/secrets) | `docs/.../GAP_MATRIX_AND_BACKLOG.md` §4 slice 12 | 19 findings reproduced and closed |

## Requirement-by-requirement

Status words: **BUILT** (works with no provider), **ASSISTED** (a person does the act on the platform and records it, governed and audited),
**NOT BUILT**.

| Area | Status | Evidence / what is missing |
|---|---|---|
| Admin-configured services, ICP (versioned), channel goals/limits/pause, four kill switches | BUILT | slice 1; `verify-acquisition-foundation/email-pause` |
| One identity across channels, strong-key matching, duplicate review, touch history, conversation owner | BUILT | slice 2; `verify-acquisition-identity`. Merging two judged-same contacts is **not built** (eleven tables point at `crm.contacts`) |
| Tracked WhatsApp handoff (no duplicate lead), from a screen | BUILT | slice 3; `verify-acquisition-handoff`, `-e2e`. Engines do not yet create handoffs on their own |
| One policy question, exact-version approval, governed once-only execution, tenant credential vault | BUILT | slice 4; `verify-acquisition-governance`, `-hardening` |
| Scheduler / Quotation subtasks, control returns to the conversation owner | BUILT (agent-facing) | slice 5; no agent calls it yet, a person requests a meeting/quote the usual way |
| Email: governed sending, replies adopted, qualification (Admin weights + rules that outrank a score), grounded-draft check, follow-up re-check | BUILT; scoring and the draft check are **ASSISTED** (a person runs them) | slice 6. Prospect discovery and an AI writer are **NOT BUILT** |
| Social: drafts, review that can fail but never approve, exact approval, scheduling, publish-once, strategies, audits | BUILT; posting is **ASSISTED** | slice 7 + `record_manual_publish`. LinkedIn/Instagram/Facebook connectors, analytics and the AI planner/writer **NOT BUILT** |
| Meta + Google ad campaigns: versions, never-automatic launch/budget/targeting changes, committed-budget cap, spend once, pending pause, health, results | BUILT; applying is **ASSISTED** | slice 8 + `record_manual_ad_*`. Meta/Google connectors, pulling platform figures, optimisation that *acts* **NOT BUILT** (advice only, by design) |
| Landing pages: approved as exactly their content/address/number, fetched verification, Google launch gate, visit attribution | BUILT; upload is **ASSISTED** | slice 9 + `record_manual_landing_deploy`. Hostinger deployer, DNS/SSL, visual builder, A/B, one-click rollback **NOT BUILT** |
| B2B: marketplace rules (default never off-platform), scored opportunities, proposals (a person prices), profiles, handoff gate | BUILT; sending is **ASSISTED** | slice 10. Marketplace connectors, automated discovery, AI proposal writer **NOT BUILT** |
| Results from the CRM by first touch with last-touch/touched-by alongside, goals, failures, advice | BUILT | slice 11 + `/lead-generation/performance`. Multi-touch weighting, trends, digests **NOT BUILT** |
| Roles/RLS/audit/tenancy | BUILT | forced RLS on every new table; 19 review findings closed; `verify-acquisition-hardening` |
| The five acquisition agents (Email Outreach, Social Media, B2B Opportunity, Ad Manager, Landing Page) | **NOT BUILT - needs an owner decision** | `src/modules/agents/registry.ts` defines only the agents ADM-82 approved, "defined when their tools exist"; adding new agent keys is a governance decision, and every one needs a funded model key |

## Decisions only the owner can make

1. **Agents.** Approve (or not) new agent keys for the acquisition work, and what each may do. Everything they would call already exists as a governed
   door; what is missing is the decision and a funded model key. Recommendation: start with *advice* agents (draft, score, research) that can only
   create versions a person approves - the doors already refuse anything else.
2. **Email approval path.** Campaign approval still uses the email module's own four-eyes path rather than the Approval Center (the engines added here
   use the Approval Center). Moving it is a deliberate change to a live feature.
3. **Whether `enabled` should gate email.** It deliberately does not today (a running campaign must not be stopped by a switch that defaults to off).
4. **Marketplace terms.** Read each marketplace's terms before loosening a rule (default: never contact off the platform, a person does everything).

## Known limits, stated plainly

- A by-hand record is a person's **statement** that they did the act; the system verifies it can only be recorded for the exact approved version,
  once, within the limits. For landing pages it goes further and fetches the public address; for ads, posts and proposals it cannot.
- A handoff link already sent depends on the vault key it was derived with: do not rotate `VAULT_ENCRYPTION_KEY` while links are live.
- Provider adapter error messages are stored as given. When an adapter exists its messages must be scrubbed.
- The verifiers prove the doors against a plain Postgres, not against PostgREST; the CI step runs them on the Supabase image.
- Counts in the change log for slices 1-7 ("red-proved ...") were run during the work and are not kept; from slice 8 they are reproducible.
