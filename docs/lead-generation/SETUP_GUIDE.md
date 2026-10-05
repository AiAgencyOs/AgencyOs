# Lead generation: the owner's detailed, step-by-step setup guide

What only a person can do, in the order that unblocks work, with each click and each thing to check afterwards.

**Ground rules**
- No secret goes in a chat, a file or a command. Every key is typed into the app's own form, where it is encrypted for your organisation and shown afterwards only as "set".
- Nothing here has been done for you. No provider has been contacted. Sandbox or test accounts first, always.
- Provider consoles change their screens. Where a step names one, treat the wording as a pointer to the right area, not a transcript, and follow the provider's current documentation if the screen differs.
- Whatever you do, nothing sends, publishes, launches, deploys, prices or approves on its own. Those stay with a person or a governed approval.

**Where things are in the app**

| Area | Path |
|---|---|
| AI providers (keys, models, routing mode) | `/agents/providers`, then a provider (`/agents/providers/openrouter`) with tabs Overview, Credentials, Models, Routing, Health |
| One agent (enable, tool permissions, ceilings) | `/agents/<key>`: `ad_manager`, `email_outreach`, `social_media`, `marketplace_opportunity` |
| Lead generation tabs | `/lead-generation` (Overview), `/lead-generation/meta`, `/email`, `/social`, `/google`, `/b2b`, `/connections`, `/identity`, `/settings`, `/performance` |

---

## Part 1. Let the agents work (about 20 minutes; model use costs credits)

### 1.1 Create the OpenRouter key
1. Sign in at openrouter.ai with an account you control. Add a small amount of credit.
2. Open the account's **Keys** area and create a key. Name it for what it is (for example `agencyos-leadgen`).
3. **Set a credit limit on the key itself.** This is your real spending brake: the app's own ceilings are a second one, not the first.
4. Copy the key once. You will paste it in the next step and nowhere else.

### 1.2 Make sure the host can store it
1. On the host (Vercel), confirm the environment variable `VAULT_ENCRYPTION_KEY` is set. A stored key is unreadable without it.
2. Do not rotate it while keys are stored, or while tracked WhatsApp links are live.

### 1.3 Store the key in the app
1. Open **AI Workforce -> Providers** (`/agents/providers`). Under **Providers**, open **OpenRouter**.
2. Open the **Credentials** tab. In **Add a key** fill in: **Label** (for example `production 1`), **Environment** (`production`, or `test` for a trial), **Order** (leave `100`), **API key** (paste).
3. Click **Store key**. The button says "Encrypting..." and then the key appears as stored; it is never shown again.
4. Click **Test connection** beside the key. Expect it to report success. If it reports a rejection, the key or its credit is the problem; fix that before going on.
5. On the **Overview** tab confirm the provider is **Enabled** (use **Enable provider** if not). The page's "Usable keys" figure should now be at least 1.

### 1.4 Enable a model
1. In the same provider, open the **Models** tab and click **Refresh models**. This asks OpenRouter for its list. Hundreds of models arrive **disabled** on purpose.
2. Find a model that supports tool calls and structured output. The one these agents were tried on is `openai/gpt-5-mini`; that is a sample, not a recommendation. Choose by quality and price for your use.
3. Click **Enable** on that one model only. "Enabled models" on the providers page should read 1.
4. A run on a disabled model fails with "model ... is disabled". If you ever see that, this step is the cause.

### 1.5 Decide how a model is chosen for each agent
On `/agents/providers`, under **Routing mode**, the owner picks one:
- **AUTO**: the orchestrator chooses among everything you have enabled, and records why. Easiest; fine with one enabled model.
- **MANUAL**: each agent runs exactly on the model you assign under **Manual assignments**. Nothing is substituted. If an enabled agent has no assignment it is blocked and you are alerted.
For a first trial use AUTO with a single enabled model. Choose MANUAL later if you want a different model per agent.

### 1.6 Switch an agent on
Do this for each agent you want, one at a time, starting with one:
1. Open `/agents/ad_manager` (or `email_outreach`, `social_media`, `marketplace_opportunity`).
2. Under **Configuration** note the values: **Enabled: no**, **Default model**, **Max steps**, **Max cost per run**.
3. Click **Enable agent**. The "Disabled reason" disappears and **Enabled** reads yes.
4. If a run later stops for the step or cost ceiling, raise **Max steps per run** or **Max cost per run** in the agent's controls. They are ceilings the runner enforces; the agent cannot change them itself. Raise them in small steps.

### 1.7 Allow its tools (the step people miss)
The default is **deny**. A tool with no recorded permission is refused when called, and the refusal is audited and reported back to you.
1. On the same agent page scroll to **Tool permissions** (owner only).
2. For each tool the agent should use, click **Allow**. The lists:
   - `ad_manager`: `acquisition.readResults`, `ads.readCampaigns`, `ads.draftCampaign`, `ads.checkCampaign`, `ads.submitCampaign`, `landing.draftPage`, `landing.checkPage`, `landing.submitPage`.
   - `email_outreach`: `acquisition.readResults`, `email.readProspects`, `email.scoreProspect`, `email.recordProspectFact`, `email.checkDraft`.
   - `social_media`: `acquisition.readResults`, `social.readContentQueue`, `social.draftContent`, `social.reviewContent`, `social.submitContent`.
   - `marketplace_opportunity`: `acquisition.readResults`, `marketplace.readOpportunities`, `marketplace.scoreOpportunity`, `marketplace.draftProposal`, `marketplace.checkProposal`, `marketplace.submitProposal`.
3. Leave `memory.recall` and `memory.remember` denied unless you have a reason. Allowing a tool does not widen what it can do: every tool still only drafts, scores, checks or asks a person to approve.

### 1.8 Ask the agent for work
1. Go to the channel tab: Meta and Google for the Ad Manager, Email, Social, B2B.
2. Make sure lead generation is set up (Overview -> **Set up lead generation**, once) and the channel is **in the plan** (Settings card on the tab).
3. In the **<Agent> agent** card write the task in plain words, for example: "Draft one LinkedIn post about planning the first ninety days of a new storefront. Check it and submit it for approval." Click **Ask the agent**.
4. Refusals you may see, and what they mean: *agent is switched off* (step 1.6), *channel is paused* (the emergency brake is on), *already asked today* (identical text within a day).
5. Wait up to a minute for the job runner. The result appears under the card: the status, the agent's own report, and one line per change it made with the id it returned.
6. **Read it before you approve anything.** A model can be wrong or vague; the doors and the approval are what stop that costing you.
7. Approve or reject the draft in the usual place (the tab's queue, or the Approval Center). Approval is for those exact words; any change is a new version needing approval again.
8. If a run fails, the run history under the card and `/agents/<key>` -> **Failures** say why ("no usable key", "model ... is disabled", "tool not allowed", a ceiling).

---

## Part 2. The Ad Manager's landing page (about 15 minutes)

The page check names two things only a person can supply, and the agent will not invent them: a **contact e-mail** and a **privacy-policy address**.

1. **Privacy policy.** Write it (or have your counsel write it) and publish it on your own site at a real https address, for example `https://youragency.com/privacy`.
2. **Contact e-mail.** Choose the public address the page will show, for example `hello@youragency.com`. It must be one you read.
3. **WhatsApp business number.** `/lead-generation/settings` -> the handoff card: enter the number with its country code, for example `+91...`. A landing page is approved with the number it links to.
4. **Page address.** Decide the public address the page will live at (for example `https://lp.youragency.com/website-dev-retail`). It must be https. You need control of that domain.
5. **Ask for the redraft.** On `/lead-generation/google` -> **Ad Manager agent**: "Redraft the landing page with address https://lp.youragency.com/website-dev-retail, contact email hello@youragency.com and privacy URL https://youragency.com/privacy. Check it and submit it for approval if it passes." It drafts the next version of the same page.
6. **Approve** the exact version when you have read it.
7. **Put it live.** Until a Hostinger deployer exists (Part 3), you upload the approved page yourself, from the page's download link, to the address above.
8. **Verify.** Use the tab's **Recheck** button: the app fetches the public address and compares what it finds to what you approved. Only then is the page VERIFIED, and only a VERIFIED page can be the destination of a Google ad.

---

## Part 3. Provider connectors

**What exists and what does not.** Every provider adapter is deliberately absent. Nothing in AgencyOS reaches a platform on its own. Everything else works: drafts, approvals, caps, audit, results. A person does the act on the platform and records it against the exact approved version.
Entering a credential **cannot** make a connection look live. Its verification status moves only when a real adapter makes a real call that succeeds.

**The same five steps for every provider**
1. Create the account or access below, using a **sandbox or test account** wherever the provider offers one.
2. Create the narrowest credential that works (read first; write only when needed). Prefer short-lived or scoped tokens over personal passwords. Never use a personal login.
3. Enter it at `/lead-generation/connections` (never in chat). The status will read configured-not-verified.
4. Ask for that connector to be built and tested against the sandbox. It will be tested against recorded real responses, and the connection shows **verified** only after a real call succeeds.
5. Keep the emergency pause within reach, and run the first real action with a tiny budget or a single post.

### 3.1 Meta (Facebook and Instagram ads, WhatsApp)
1. Use a Meta Business account that the agency owns (not a freelancer's or a personal one). Add at least two admins.
2. Create an app in Meta for Developers; add the Marketing API and the WhatsApp product.
3. Create or attach the ad account; set a **spending limit** on the ad account in Meta itself.
4. Connect the WhatsApp Business number to the app. Note its phone number ID (different from the number itself; this is what the app's WhatsApp setting stores).
5. Create a system user and generate a token with only the ad-management and WhatsApp-messaging permissions needed. Some permissions need Meta app review; start that early.
6. Test with a test ad account and Meta's own test tools before any real money.

### 3.2 Google Ads
1. Have a Google Ads manager (MCC) account and the client account under it.
2. Apply for a **developer token** in the manager account's API Center. Google reviews it; basic access can take days. Test-account access is available first.
3. Create an OAuth client in Google Cloud, and have an admin of the Ads account authorise access for it.
4. Note the customer ID(s). Set account-level budgets inside Google Ads too.
5. Test with a Google Ads test account first.

### 3.3 Hostinger (landing pages)
1. Choose the domain or subdomain the pages will live on (for example `lp.youragency.com`), point its DNS at the host, and confirm SSL is on.
2. Create a deployment credential that can write to that one site only (a scoped token, or an SSH user limited to that directory). Never the account password.
3. Keep a manual rollback copy of what is live. One-click rollback is not built.

### 3.4 LinkedIn, Instagram, Facebook publishing
1. LinkedIn: be an admin of the company Page; create a LinkedIn app; request the sharing permissions. LinkedIn app review may apply and can take time.
2. Instagram: use a **professional** account linked to a Facebook Page, via the Meta app in 3.1.
3. Facebook: be an admin of the Page; use the same Meta app and a Page token.
4. Until publishers exist, a due post is flagged and a person posts it on the platform, then records the post's address in the tab.

### 3.5 Marketplaces and directories
1. Read each marketplace's terms for automation, bidding and off-platform contact **before** anything else.
2. Upwork, Freelancer, PeoplePerHour, Guru, Contra, Fiverr: many have no public bidding API and several forbid automation. The supported path is assisted: a person finds the job, pastes it in, the agent scores it and drafts a proposal with no price, a person prices and sends it, and records the send.
3. Clutch and GoodFirms are profile and reputation work: the app keeps the profile versions and the tasks; a person updates the site.
4. Rules per marketplace are at **B2B -> Marketplace rules**. The default is "never contact off the platform, a person does everything". Loosen one only after reading its terms, because loosening is what allows a WhatsApp handoff for a lead found there.

---

## Part 4. Finding prospects and jobs (you choose the source)

Discovery is not built because it needs a data source I cannot choose or pay for.

**E-mail prospects**
1. Choose a source: a licensed B2B data provider, your own existing contacts, or inbound sign-ups.
2. For each prospect decide the **lawful basis** the system records: consent, existing relationship, or B2B legitimate interest. Do not use a source you cannot document.
3. Set the sender identity first (Settings -> Communication): sender name, a real postal address, and SPF and DKIM for the sending domain. These are legal and deliverability requirements for cold outreach.
4. Start with a small list, a low daily limit and warm-up, and keep the opt-out handling as built.
5. Tell me the source and send a small sample of what it exports; I build the importer against that real format.

**Marketplace jobs**
1. Today a person pastes a job's text into the agent's task (or the B2B tab's import form).
2. The Admin thresholds (B2B -> settings) score it; low fit stays low fit.
3. For automatic discovery you would need that marketplace's permitted API or feed; see 3.5.

---

## Part 5. E-mailed digests (a decision)

The weekly digest is an in-app alert. To e-mail it, decide:
1. **Who receives it**: owner only, or all admins.
2. **Which mailbox sends it**: the existing `info@` or `care@`.
3. **What it may contain.** An e-mail leaves the application. Counts only, or channel figures and spend too?
4. **When**: Monday morning in the agency's timezone is the default I would use.
Tell me those four and it is a small addition on the existing governed mail path.

---

## Part 6. Checks to run yourself after setup

1. `/agents/providers`: Usable keys >= 1, Enabled models >= 1.
2. `/agents/<key>`: Enabled yes; tool permissions show Allow for the tools you chose.
3. One small task per agent; read the report; confirm any submitted draft sits waiting for you (nothing approved on its own).
4. Pause the channel (**Pause channel** on its tab), ask the agent again, and confirm it is refused with "channel is paused". Then resume.
5. Look at `/lead-generation/performance` after a week: the weekly digest alert should have appeared in Notifications/Operations if there was activity.

## What stays true whatever you do

Nothing sends, publishes, launches, deploys, prices or approves on its own. A launch, a budget increase, a targeting change, a publication, a proposal, a page deploy and a profile change are never automatic and cannot be made so. The emergency pause stops new work. The status words stay honest: the automated multi-engine system is **NOT_PRODUCTION_READY**; assisted use is ready.
