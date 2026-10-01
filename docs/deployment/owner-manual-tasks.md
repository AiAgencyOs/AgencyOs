# Owner's manual tasks

What is built and verified is in PR #536. These are the things only the owner can do, because each needs an account or credential that the build never had. Do them in this order.

## 1. Revoke the exposed GitHub token (first, 2 minutes)

- [ ] GitHub → Settings → Developer settings → Personal access tokens.
- [ ] Find the token that was pasted into the chat (check both "Tokens (classic)" and "Fine-grained tokens").
- [ ] Delete or revoke it.
- [ ] Make a new fine-grained token limited to this repository. Keep it for step 5; do not paste it anywhere else.

## 2. Apply the database migrations

Staging first, then production. About 75 new migrations. This is the only supported way to build the schema (`supabase/_bundle.sql` is not an install path).

- [ ] `npx supabase login`
- [ ] `npx supabase link --project-ref <project-ref>`
- [ ] `npm run db:push`
- [ ] Supabase dashboard → Storage: confirm the private `project-files` bucket exists (the migrations create it).
- [ ] If any migration errors, keep the full message.

## 3. Hosting environment variables (Vercel → Settings → Environment Variables → Production)

- [ ] `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API Keys).
- [ ] `NEXT_PUBLIC_APP_URL` — the real `https://` domain.
- [ ] `CRON_SECRET` — `openssl rand -hex 32`.
- [ ] `VAULT_ENCRYPTION_KEY` — a different `openssl rand -hex 32`. Also keep a copy in a password manager: if it is lost, every key stored in the vault becomes unreadable.
- [ ] Redeploy.

`SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` live only in the hosting environment; the panel cannot store them.

## 4. Start the background-job heartbeat

Nothing runs in the background (invoices, announcements, agents) until something calls `POST /api/jobs/run` every minute. `vercel.json` deliberately has no `crons` (`tests/cron-scheduler.test.ts` pins that), so an external scheduler does it. Pick one:

- [ ] AWS: `infra/aws/cron/deploy.sh`, then fill the Secrets Manager secret (`PROD_URL`, `CRON_SECRET`, and `VERCEL_AUTOMATION_BYPASS_SECRET` if Deployment Protection is on). The schedule ships `DISABLED`.
- [ ] Or Supabase `pg_cron` + `pg_net`.
- [ ] Call the endpoint once by hand with `Authorization: Bearer <CRON_SECRET>` and confirm a job was claimed on the Operations page.
- [ ] Enable the schedule.

Details: `docs/deployment/runbook.md` §5 and `docs/deployment/cron-external-trigger.md`.

## 5. Store the integration keys (Security & Audit → Keys & secrets, as owner)

- [ ] The "Vault ready" badge shows. If it says "Vault cannot encrypt", recheck `VAULT_ENCRYPTION_KEY`.
- [ ] `ANTHROPIC_API_KEY` (agents).
- [ ] `GITHUB_TOKEN` — the new token from step 1.
- [ ] WhatsApp: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`.
- [ ] Email: `RESEND_API_KEY` or `SMTP_PASS`.
- [ ] `FIGMA_ACCESS_TOKEN`, `ALERT_WEBHOOK_URL`.
- [ ] Optional: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`.
- [ ] Press Verify where it exists (GitHub, WhatsApp).

A key also set in the hosting environment wins over the vault copy.

## 6. Google Calendar (unblocks the three "Propose a time / Book" rows)

- [ ] Google Cloud Console: create or pick a project, enable the Google Calendar API.
- [ ] IAM & Admin → Service Accounts → create one; Keys → Add key → JSON.
- [ ] Share the meetings calendar with the service account's email (`client_email` in the JSON), permission "Make changes to events".
- [ ] Copy the Calendar ID (calendar settings → Integrate calendar).
- [ ] Keys & secrets → `GOOGLE_SERVICE_ACCOUNT_KEY` → paste the whole JSON.
- [ ] Integrations → Google Calendar → enter the Calendar ID.
- [ ] Tell the build assistant, so it can run the live check and open the Blocked controls.

## 7. Check the parts that could not be tested locally

The local stack has no Supabase Storage, so only the database half of file uploads was verified.

- [ ] Upload a small `.zip` on a project's Builds page; open its download link (signed, should expire).
- [ ] Attach a screenshot to a QA run or bug; reopen it.
- [ ] Upload a PDF or image to a meeting note.
- [ ] From an account in another organization, try to open one of those links. It must fail.
- [ ] Open the new screens at 390px width (task page, Board, Settings → Budget bands, Finance period report).
- [ ] On a project overview, complete a phase from the "Phases 5 And 6" panel (it is a button; nothing completes it automatically).

## Behaviours to know about

- Phase 5 only completes once the M2 invoice is verified paid.
- A task reaches Completed only from In review; cancelling needs a reason and tells the assignee.
- An archived task is read-only until a roster manager restores it.
- The Hot Leads filter follows a manual heat override.
