# Lead generation — what only a person can do

Written for the owner. Nothing here has been requested from a provider and no credential has been entered, stored or
asked for in chat: **no provider has been contacted**. Credentials go into the app itself (**Lead generation ›
Connections**), where they are encrypted per organisation and never shown again; they are never pasted into a chat, a
file, or a command.

## How to read the status words

Every connection carries two separate facts. *Status* is the lifecycle (unconfigured → configured → active). *Verification*
is what has actually been **proven** against the real provider, and only a real adapter's result can move it.

| Verification | Meaning |
|---|---|
| `NOT_IMPLEMENTED` | No adapter for this provider exists in the code. **This is the state of every provider today.** |
| `IMPLEMENTED_NOT_CONFIGURED` | An adapter exists; no credential is stored. |
| `CONFIGURED_NOT_VERIFIED` | A credential is stored; nothing has called the provider yet. |
| `SANDBOX_VERIFIED` / `LIVE_VERIFIED` | A real call succeeded (test account / production account). |
| `DEGRADED`, `BLOCKED_BY_CREDENTIAL`, `BLOCKED_BY_PROVIDER` | A real call failed, and why. |

Entering a credential therefore **cannot** make a connection look live. Until an adapter is written and a check passes,
an approved launch, deploy, post or proposal waits and a person is told to do it by hand.

## What exists, per channel

| Channel | Works today without any provider | Still needs a provider adapter (not built) |
|---|---|---|
| **Email** | Governed sending from `info@` (already live), replies/bounces/unsubscribes read, qualification, grounded-draft checks, follow-up re-check | Finding prospects on the open web; an AI writing the message |
| **Social** | Drafts, automated review, exact-version approval, scheduling, publish-once record, strategies, audits | LinkedIn / Instagram / Facebook publishing and analytics; the AI that plans and writes (a due post currently alerts a person to post it by hand) |
| **Meta ads** | Campaign plans and versions, checks, exact-version approval, caps, spend counted once, pending pause/resume/end, health findings, results from the CRM | The Meta connector (nothing is sent to or read from Meta); pulling Meta's figures |
| **Google ads + landing pages** | The same pipeline with Google's rules; landing page versions, approval, verification record; a Google ad can only launch to a VERIFIED page | The Google Ads connector; the Hostinger deployer (a person uploads the approved page and re-checks it) |
| **B2B marketplaces** | Recording jobs, scoring, proposals approved as exactly their words and price, assisted send-and-record, profile versions, marketplace rules, handoff gate | Any marketplace connector; automated discovery |
| **All five** | One identity across channels, tracked WhatsApp handoff, subtasks, policy/approval/audit, emergency pause, results/goals/failures views | — |

## What you need to do, in the order it unblocks work

1. **A funded model key** (Settings › AI providers, already built). Needed before any agent does real work: drafting,
   research, scoring, planning. Until then every "agent" step is a person.
2. **Set the WhatsApp business number** (Lead generation › Settings). Tracked handoffs, landing pages and the Click-to-WhatsApp
   ad destination all use it; a page is approved *with* the number it links to.
3. **Decide each marketplace's rule** (Lead generation › B2B › Marketplace rules). Read each marketplace's terms. The default is
   "never contact off the platform, a person does everything"; only the owner can loosen it, and loosening is what allows a
   WhatsApp handoff for a lead found there.
4. **Meta**: a Meta Business account owner creates/authorises an app and picks the ad account; a WhatsApp-linked ad needs the
   business number from step 2. *Blocks:* the Meta connector. *Today:* plans, approval and results work; applying is by hand.
5. **Google Ads**: a developer token (Google approval can take days), OAuth client, a manager who authorises access, the customer
   ID. *Blocks:* the Google connector.
6. **Hostinger**: a scoped deployment token (or SSH scope) and the domain/DNS for the landing page address (SSL included).
   *Blocks:* the deployer. *Today:* approved pages are uploaded by hand and verified by fetching the public address.
7. **Social accounts**: LinkedIn page admin (LinkedIn app review may apply), Instagram professional account, Facebook Page admin.
   *Blocks:* the social publishers.
8. **Marketplace accounts** (Upwork, Freelancer, PeoplePerHour, Guru, Contra, Fiverr; Clutch / GoodFirms profiles): the account
   owner authorises API access where the platform offers it at all. Many do not, and several forbid automation: that is why
   the supported path is assisted.
9. **Email**: the existing owner steps from the earlier email work (sender name, postal address, SPF/DKIM) still apply.
10. **Review the governance defaults** (Lead generation › Settings › Rules). Launches, budget increases, targeting changes,
    publishing, proposals, page deploys and profile updates are **never automatic** and cannot be made so.

## What is safe to do now

Everything in the left-hand column of the table above can be used today with no provider: it records, checks, approves,
counts and reports; it simply does not reach out to a platform. Use it to run the process by hand with a complete audit
trail, and each adapter, when it is written, plugs into the same governed door without changing any screen.
