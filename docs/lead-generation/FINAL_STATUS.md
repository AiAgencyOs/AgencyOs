# Lead generation & acquisition — final status and gap re-audit

Branch `feat/lead-gen-foundation` (PR #571, merged with `origin/main` as of 2026-10-05).
Re-audit date: 2026-10-05. Method: every claim below points at a file, a verifier, or a command that can be run again.

## Verdict

**`NOT_PRODUCTION_READY` for the five-engine, agent-driven system the specification describes. Ready for assisted use.**

*Why not production-ready:* exactly one provider adapter exists, Meta Ads, and it is read-only (it verifies a connection and cannot launch or change anything); none exists for Google Ads, Hostinger, LinkedIn, Instagram, Facebook
or any marketplace; there is no discovery source, and none of the acquisition agents - so nothing reaches out to a platform on its own.
That is a statement about what is **not built**, not about verification pending: it is the largest remaining body of work and most of it
needs a credential or a decision only the owner can give (`HUMAN_DEPENDENCIES.md`).

*Why "ready for assisted use":* every governed side effect has a real, verified by-hand path - a person does the act on the platform and
records it against the exact approved version, once, with the stops, policy, plan, limits and cap re-read at that moment - and every
number on the screens is read from the CRM or the ledger. Used that way it is complete, audited and refuses what it should.

*CI has now run (PR #571) and is green: typecheck, lint, 8,800+ tests, secret scan, `next build`, all 16 acquisition verifiers on the Supabase image,
and the two-sessions realtime spec.* It found five real defects that a plain scratch Postgres could not: history triggers that refused the owning
organisation's own cascade and a lead's own delete (so fixtures leaked leads and the realtime spec failed), and four verifiers that assumed an empty
shared database (audit counts, daily send cap and warm-up, a campaign with several recipients, a large "other" funnel row). One pre-existing
verifier (`verify-quotation-dispatch`, "a duplicate dispatch job sends NOTHING") failed once and passed on re-run; main's own migrations job
passes, so it is recorded here as a flake rather than fixed.

*Looked at in a browser (2026-10-05, local Supabase stack, signed in as a local owner):* every lead-generation page loads without a server error or console error; the Identity page's duplicate decision and the new contact merge were driven through the real server actions (an empty reason is refused by the form; the merge moved the lead, the phone and the identity keys and left the other record as history). Not checked: keyboard/focus order, narrow screens, and the pages that need data a fresh install lacks (an engine with live campaigns, ads, proposals).

## What was verified, and how

| Evidence | Where | Result |
|---|---|---|
| 15 SQL verifiers driven as the real request roles (about 1,200 checks) | `scripts/verify-acquisition-*.sql`, `npm run db:verify:acquisition` | all pass from a from-zero apply of every migration |
| Red-proofs as an artifact (111 cases against the LIVE definitions; a shadowed case reports GREEN and is re-pointed) | `scripts/redproof/` | every case red, baseline restored and green |
| Type, lint, 8,800+ unit/contract tests, secret scan, record check | `npm run check` | exit 0 |
| CI on the Supabase image, `next build`, realtime two-sessions spec | PR #571 | green |
| End to end across slices (one visitor, one prospect, funnel = campaign, stop reaches every action) | `scripts/verify-acquisition-e2e.sql` | pass |
| Three independent reviews (tenancy, governed execution, honesty/secrets) | `docs/.../GAP_MATRIX_AND_BACKLOG.md` §4 slice 12 | 19 findings reproduced and closed |

## Requirement-by-requirement

Status words: **BUILT** (works with no provider), **ASSISTED** (a person does the act on the platform and records it, governed and audited),
**NOT BUILT**.

| Area | Status | Evidence / what is missing |
|---|---|---|
| Admin-configured services, ICP (versioned), channel goals/limits/pause, four kill switches | BUILT | slice 1; `verify-acquisition-foundation/email-pause` |
| One identity across channels, strong-key matching, duplicate review, touch history, conversation owner | BUILT | slice 2; `verify-acquisition-identity`. Merging two judged-same contacts is built (`crm.merge_contacts`, `verify-acquisition-merge`); a merge is not undoable from the screen |
| Tracked WhatsApp handoff (no duplicate lead), from a screen | BUILT | slice 3; `verify-acquisition-handoff`, `-e2e`. Engines do not yet create handoffs on their own |
| One policy question, exact-version approval, governed once-only execution, tenant credential vault | BUILT | slice 4; `verify-acquisition-governance`, `-hardening` |
| Scheduler / Quotation subtasks, control returns to the conversation owner | BUILT (agent-facing) | slice 5; no agent calls it yet, a person requests a meeting/quote the usual way |
| Email: governed sending, replies adopted, qualification (Admin weights + rules that outrank a score), grounded-draft check, follow-up re-check | BUILT; scoring and the draft check are **ASSISTED** (a person runs them) | slice 6. Prospect discovery and an AI writer are **NOT BUILT** |
| Social: drafts, review that can fail but never approve, exact approval, scheduling, publish-once, strategies, audits | BUILT; posting is **ASSISTED** | slice 7 + `record_manual_publish`. LinkedIn/Instagram/Facebook connectors, analytics and the AI planner/writer **NOT BUILT** |
| Meta + Google ad campaigns: versions, never-automatic launch/budget/targeting changes, committed-budget cap, spend once, pending pause, health, results | BUILT; applying is **ASSISTED** | slice 8 + `record_manual_ad_*`. Meta/Google connectors, pulling platform figures, optimisation that *acts* **NOT BUILT** (advice only, by design) |
| Landing pages: approved as exactly their content/address/number, fetched verification, Google launch gate, visit attribution | BUILT; upload is **ASSISTED** | slice 9 + `record_manual_landing_deploy`. Hostinger deployer, DNS/SSL, visual builder, A/B, one-click rollback **NOT BUILT** |
| B2B: marketplace rules (default never off-platform), scored opportunities, proposals (a person prices), profiles, handoff gate | BUILT; sending is **ASSISTED** | slice 10. Marketplace connectors, automated discovery, AI proposal writer **NOT BUILT** |
| Results from the CRM by first touch with last-touch/touched-by alongside, goals, failures, advice | BUILT | slice 11 + `/lead-generation/performance`. A weekly in-app digest alert is BUILT (`crm.run_acquisition_digest`); e-mailed digests are not (multi-touch models and weekly trends are built) |
| Roles/RLS/audit/tenancy | BUILT | forced RLS on every new table; 19 review findings closed; `verify-acquisition-hardening` |
| The four acquisition agents (Ad Manager, Email Outreach, Social Media, B2B Opportunity) | **BUILT AS DRAFTERS, DISABLED; ALL FOUR RUN ON A REAL MODEL (OpenRouter, local stack)** | ADM-112 / ADM-113 (owner, 2026-10-05). An admin asks an agent for work from the channel page (`crm.request_agent_task`); it reads results and drafts, scores, checks and submits for approval through 21 tools that call existing doors, stamped `agent`. None can send, publish, launch, deploy, price, approve or pause, so it cannot do the platform act itself: that stays the engine's governed execution or a person by hand. Needs the owner to enable each agent and a funded model key; `verify-acquisition-agents`, 7 red-proofs, and tests against a stand-in model prove the order and the refusals, **not the quality of anything a real model writes**. The one real run (Social Media, `openai/gpt-5-mini` via OpenRouter, local stack) did the right work and reported honestly, and found two defects now fixed: the tool loop's four-round cap ended a legitimate read-draft-review-submit run (the workflow now asks for ten; the hard cap is twelve), and the retried job drafted a duplicate (the prompt now says to report an existing draft). All four were then run on the same model: Email scored, recorded a sourced fact and passed the draft check; B2B recorded a job, respected the below-threshold score and declined to draft; the Ad Manager drafted a Meta campaign, corrected it after its check failed and submitted the corrected version, and stopped honestly on a landing page that still needs a contact email and privacy URL that only a person can supply. The later runs found four more defects, now fixed: parallel tool calls in one turn all wrote the same trace step (a run that did a dozen things left one row), a long report failed the job after the work was done (it is truncated instead), the landing-page draft had no way to name an existing page (an existing address now yields the next version of that page), and the marketplace tool accepted an id as a URL with an opaque refusal (the schema and the message now say what is wanted). Each run is one sample of one model: it shows the loop, permissions, doors and honesty hold, not that every task will go well |
| Weekly autopilot (the agents start their own week) | **BUILT, OFF UNTIL AN ADMIN TURNS IT ON** | ADM-114: Monday 09:00 agency time, each enabled agent whose channel is in the plan and not stopped gets one standing task that only drafts for approval; once per ISO week. `verify-acquisition-autopilot` + 8 red-proofs. Not run on a real model on a schedule yet |

## Decisions

**Made by the owner on 2026-10-05**

1. **Agents (ADM-112, ADM-113).** Grant the agents the specification names (four; Scheduler and Quotation Master stay shared), installed disabled; and let their reads and their draft / check / submit-for-approval tools dispatch (ADM-99 widened for exactly those 21).
2. **Email approval path.** Stays on the email module's own four-eyes path; not moved to the Approval Center.
3. **Whether `enabled` gates email.** It does not (a running campaign is never stopped by a switch that defaults to off; the four kill switches stop it).
4. **Marketplace terms.** Every marketplace stays at the default: never contact off the platform, a person does everything.

**Still open, and the owner's**

- A funded model key (Settings > AI providers).
- Enabling each agent (AI Workforce > Agents). They are installed disabled and `crm.request_agent_task` refuses work for a disabled agent.
- The specification's "agents perform actual operational work" is met only as far as drafting: the act on the platform (launch, publish, deploy, send, submit to a marketplace) needs a connector or a person, by design.
- Provider credentials, entered in the app (`HUMAN_DEPENDENCIES.md`).

## Known limits, stated plainly

- A by-hand record is a person's **statement** that they did the act; the system verifies it can only be recorded for the exact approved version,
  once, within the limits. For landing pages it goes further and fetches the public address; for ads, posts and proposals it cannot.
- A handoff link already sent depends on the vault key it was derived with: do not rotate `VAULT_ENCRYPTION_KEY` while links are live.
- Provider adapter error messages are stored as given. When an adapter exists its messages must be scrubbed.
- The verifiers prove the doors against a plain Postgres, not against PostgREST; the CI step runs them on the Supabase image.
- Counts in the change log for slices 1-7 ("red-proved ...") were run during the work and are not kept; from slice 8 they are reproducible.
