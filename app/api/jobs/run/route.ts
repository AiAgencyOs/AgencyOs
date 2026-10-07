import { NextResponse, type NextRequest } from 'next/server';

import { authorizeCronRequest } from '@/lib/cron-auth';
import { createAdminClient } from '@/lib/db/admin';
import { failJob, logJobParked, parkBudgetRefusedJob, parkRefusedJob, requeuePausedJob, settleCancelledJob, type Admin, type JobRow } from './agent-run';
import { AgentPolicyRefusal } from '@/lib/ai/agent-policy';
import { AgentBudgetRefusal, AgentsPaused, JobCancelled } from '@/lib/ai/run-gates';
import { AGENT_JOB_KINDS, workflowFor } from './workflows';
import { serverEnv } from '@/lib/env';
import { newCorrelationId } from '@/lib/errors';
import { HANDLER_JOB_KIND } from '@/lib/events/catalog';
import { dispatchOutbox } from '@/lib/events/dispatch';
import { reapStalledJobs } from '@/lib/jobs/reaper';
import { expireOverdueApprovals } from '@/lib/approvals/expire';
import { lapseOverdueProposals } from '@/lib/sales/lapse';
import { runFollowUps } from '@/modules/crm/follow-up-worker';
import { runInvoiceReminders } from '@/modules/finance/reminder-worker';
import { runCampaigns } from '@/modules/crm/campaign-worker';
import { runOutreach } from '@/modules/crm/outreach/worker';
import { runInboundEmail } from '@/modules/crm/inbound-email';
import { expireHandoffs } from '@/modules/acquisition/handoff';
import { AD_PROVIDERS, B2B_CONNECTORS, LANDING_DEPLOYER, SOCIAL_PUBLISHERS } from '@/modules/acquisition/adapters';
import { runB2bOperations } from '@/modules/acquisition/b2b';
import { runLandingOperations } from '@/modules/acquisition/landing';
import { runAdOperations } from '@/modules/acquisition/ads';
import { syncMetaAdMetrics } from '@/modules/acquisition/meta-metrics-sync';
import { runSocialPublishing } from '@/modules/acquisition/social';
import { runProviderMaintenance } from '@/lib/ai/provider-maintenance';
import { publishDueAnnouncements } from '@/modules/crm/announcement-worker';
import { runSuiteSchedules } from '@/modules/qa/schedule-worker';
import { detectUpsellSignals } from '@/lib/sales/upsell';
import { markOverdueInvoices } from '@/lib/finance/overdue';
import { mayAgentRun } from '@/lib/ai/autonomy';
import { alertOnBacklog } from '@/lib/observability/alert';
import { stampAgentDefinitions } from '@/modules/agents/stamp';
import { runSemanticIndexing } from '@/lib/search/semantic-indexer';
import { AGENT_DEFINITIONS } from '@/modules/agents/registry';
import { settlementFor } from '@/lib/jobs/retry';
import {
  handleApprovalRequested,
  handleClientWaiting,
  handleConversationEscalated,
  handlePhaseThreeCompleted,
  handleRevisionLimitEscalated,
  announceOfferApplied,
  deliverFollowUp,
  dispatchApprovedQuotation,
  announcePhaseFourStarted,
  announceUiVersionAdminReviewed,
  announceUiVersionChangeRequested,
  announceUiVersionLocked,
  announcePrototypeSubmitted,
  announcePrototypeChangeRequested,
  announceTask2Complete,
  announceTask3Complete,
  announcePhaseFiveStarted,
  announceBuildShared,
  announceBuildFeedbackReceived,
  announceBuildApproved,
  announceM3PaymentVerified,
  announcePhaseSixReady,
  announceTestingStarted,
  announceQaClarification,
  announceBuildReadyForAdmin,
  announceDevelopmentEscalated,
  announceModuleCompleted,
  announceDevClarification,
  announceQaDefectProgress,
  announceReleaseCandidateApproved,
  announceReleaseCandidateReady,
  announceReleaseExceptionRequested,
  announcePhaseEightStarted,
  announceSupportTicketEscalated,
  announceSupportSlaBreached,
  announceRetentionRecoveryRequired,
  announceMaintenanceRenewalDue,
  announceMaintenanceWorkOpened,
  announceMaintenanceQaFailed,
  announceMaintenanceReleaseRequested,
  announceMaintenanceReleaseApproved,
  announceMaintenanceReleased,
  announceMaintenanceBillingProposed,
  announceMaintenanceSlaBreached,
  announceMaintenanceWorkStalled,
  announceQaReverification,
  announceM4PaymentVerified,
  announceFinanciallyClosed,
  announceBuildFeedbackRouted,
  announceTask4Complete,
  announceM2PaymentVerified,
  announcePhaseSevenReady,
  announceDeploymentApproved,
  announceProductionValidated,
  announceProductionValidationFailed,
  announceHandoverReady,
  announceProjectCompleted,
  handleRouteLead,
  handleClassifyLeadIdentity,
} from '@/modules/crm/handlers';
import {
  handleHandoffBound,
  handleInvoicePaid,
  handlePhaseThreeReady,
  handlePhaseFourReady,
  handlePossibleScopeChangeDetected,
  handleDeliverableDecided,
  handleStartPhaseFive,
  handleRecordM3Verified,
  handleStartPhaseSix,
  handleScheduleQaJobs,
  handleReopenOnSourceChange,
  handleRecordM4Verified,
  handleValidateQaIntake,
  type HandlerResult,
  type UnlockJob,
} from '@/modules/projects/handlers';
import { handleCreateDraftHandoverPackage, handleFillPhaseEightIntake, handleOpenPhaseSeven, handleOpenSupportTicketFromMessage, handleRoutePhaseSevenTask, handleRunDeployment } from '@/modules/projects/phase-seven-handlers';
import { runOnboardingFollowUps } from '@/modules/projects/pm-followups';
import { handleAskClarification, handleReadClarificationAnswer } from '@/modules/projects/pm-clarifications';
import { handleAnnouncePhaseThree, handleAskFinalConfirmation } from '@/modules/projects/pm-design-comms';
import { handleWelcomeClient, handleAskGstDetails, handlePaymentUpdate, handleReadBillingReply } from '@/modules/projects/pm-client-comms';
import { handleHandoverAcceptedForFinance, handleBillingModeConfirmed, handleInvoiceIssuedForDelivery, handlePhaseFourCompletedForFinance, handlePhaseFiveCompletedForFinance, handlePhaseSixCompletedForFinance } from '@/modules/finance/handlers';
import { learnFromDecision, learnFromRevision, syncDiscountDecision } from '@/modules/sales/handlers';
import { handleRouteTask2Design, handleRequestUIVersionAdminReview, handleRouteDevelopmentPlan, handleRouteQaOutcome } from '@/modules/orchestrator/handlers';
import { sweepFinanceExceptions, sweepFinancePhaseNineB, sweepMaintenanceLifecycle, sweepRetentionReviews, sweepStaleOrchestratorRecords, sweepSupportAndHealth } from '@/modules/orchestrator/sweeps';
import { handleReviewUIVersion, handleReviewPrototypeBuild } from '@/modules/qa/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/jobs/run — the job runner.
 *
 * One of the four sanctioned service-role call sites (ARCHITECTURE.md §7.3).
 * It exists because `ai.agent_runs` has no INSERT policy for authenticated
 * users by design — "an agent trace nobody can forge is the point" — so the
 * only principal that may record a run is the one running behind this route.
 *
 * Because the service role bypasses RLS entirely, every query below scopes by
 * organization_id **by hand**, taken from the job row rather than from request
 * input. Nothing here trusts the caller for tenancy.
 *
 * Authentication is a shared secret. When CRON_SECRET is unset the route is
 * inert (503) rather than open.
 *
 * In production the caller is Vercel Cron, configured in `vercel.json` to hit
 * this path every minute. Vercel issues cron invocations as **GET**, so the
 * GET export at the bottom of this file is the scheduler's entry point; it
 * delegates to POST, which remains the handler and the only implementation.
 */

/**
 * Where a claimed extraction job is parked so a throw can still settle it.
 *
 * Gap G-081. Everything between claiming that job and the final settle — a
 * transcript read, a model call, a validated insert — can throw rather than
 * return an error, and a database blip is precisely when a client throws. The
 * settle then never ran, and the row sat `running` with its attempt spent
 * until the reaper released it fifteen minutes later.
 *
 * A holder rather than a `try` around the body, because the body is three
 * hundred lines with fifteen exits: wrapping it in place would have been a
 * reindent of all of them, which is a large diff to hide a mistake in for a
 * ten-line fix.
 */
type ClaimHolder = { job: JobRow | null };

/**
 * What a job row looks like once it has actually succeeded.
 *
 * `last_error` is cleared, and that is the part worth naming.
 * `core.requeue_job` deliberately KEEPS the error when it revives a dead job —
 * *"it is the only record of why the work stopped, the operator read it before
 * deciding to requeue, and clearing it would erase the reason at the exact
 * moment somebody acted on it."* True right up until the work succeeds. After
 * that the row reads `succeeded` beside the reason it died in a previous life,
 * which is what production showed after the first extraction ever to work.
 *
 * `settleUnlockJob` already settled this way; the four extraction paths did
 * not, and one of them left the lock fields set as well. Same concept, four
 * spellings — so it is one shape now.
 */

export async function POST(request: NextRequest) {
  const claimed: ClaimHolder = { job: null };

  try {
    return await runTick(request, claimed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'jobs/run',
        jobId: claimed.job?.id ?? null,
        detail: `tick threw: ${detail}`,
      }),
    );

    // Settled with the same budget any other failure gets, so the retry is
    // spaced (D18) rather than waiting on the reaper. If nothing was claimed
    // there is nothing to settle and the throw was in the dispatch or reap
    // stage, which own no row.
    if (claimed.job) {
      try {
        await failJob(createAdminClient(), claimed.job, `runner threw: ${detail}`);
      } catch (settleError) {
        console.error(
          JSON.stringify({
            level: 'error',
            scope: 'jobs/run',
            jobId: claimed.job.id,
            detail: `could not settle after a throw: ${
              settleError instanceof Error ? settleError.message : String(settleError)
            }`,
          }),
        );
      }
    }

    return NextResponse.json({ error: 'runner failed' }, { status: 500 });
  }
}

async function runTick(request: NextRequest, claimed: ClaimHolder) {
  // Stamped once, before any work: the agent batch below measures its budget
  // from the START of the tick, not from its own first iteration, because the
  // reap, dispatch, unlock and announcement stages have already spent part of
  // the same minute (G-174).
  const tickStartedAt = Date.now();
  const { CRON_SECRET } = serverEnv();

  const auth = authorizeCronRequest(request.headers.get('authorization'), CRON_SECRET);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const admin = createAdminClient();
  const correlationId = newCorrelationId();

  // The pulse, first thing after authentication: a tick that ran is recorded
  // as having run even if the work below throws, because the heartbeat is
  // about whether the SCHEDULER is alive, not whether this tick succeeded. A
  // dead scheduler is the one failure the in-tick alert path cannot report;
  // /api/health reads this age so something outside can. Best-effort — a
  // heartbeat write that fails must not stop the work the tick exists to do.
  await admin.schema('core').rpc('record_cron_tick');

  /**
   * ── recovery ───────────────────────────────────────────────────────────
   *
   * First, because a job stranded in `running` by a killed invocation is
   * invisible to every claim below — they all filter on `queued` — so until
   * something releases it the work is simply lost. Reaping ahead of the claims
   * means a recovered job is picked up on this tick rather than the next.
   *
   * A no-op unless something genuinely died: the threshold is longer than any
   * invocation can live (src/lib/jobs/reaper.ts).
   */
  const reaped = await reapStalledJobs(admin);

  /**
   * ── outbox → jobs (ARCHITECTURE.md §9.1, steps 4–7) ───────────────────
   *
   * Runs first on every invocation, and unconditionally. Events are written
   * by request-path code that has already committed its state change; until
   * something turns them into jobs they are a record of an intention nobody
   * acted on. Doing it here rather than in a separate cron entry keeps the
   * gap between "invoice paid" and "milestone open" to one tick.
   */
  const dispatched = await dispatchOutbox(admin);

  /**
   * ── monitoring (G-053) ────────────────────────────────────────────────
   *
   * After recovery and dispatch, so the counts describe what this tick could
   * not fix rather than what it was about to. A job still `dead` after the
   * reaper ran is genuinely dead; an event still unpublished after the
   * dispatcher ran is genuinely stuck.
   *
   * Never allowed to fail the tick. Moving work is this route's job; if the
   * alert endpoint is unreachable the work still runs and the failure is
   * logged, because a dead webhook stopping the job runner would turn
   * monitoring into an outage.
   */
  /**
   * ── unanswered approvals (G-096, ADM-08c) ─────────────────────────────
   *
   * Before the backlog is measured, so a request that expires on this tick is
   * counted as overdue by the alert rather than reported next minute. It
   * cannot approve anything — there is no path from expiry to approved, and
   * the function that writes approvals refuses a caller with no identity,
   * which this is.
   */
  const expired = await expireOverdueApprovals(admin);

  /**
   * ── quotations whose validity date has passed (G-111, ADM-71) ─────────
   *
   * The same shape one schema over, for the same reason: a quote nobody
   * answered kept reading `sent`, so a queue of outstanding quotations
   * counted it forever and nothing said it had gone cold.
   *
   * It marks state and stops. ADM-79 adds no notification — telling a client
   * their offer expired is a sales action a human takes, and an automated
   * message would be client-facing communication whose consent policy
   * (ADM-81) is still open.
   */
  const lapsed = await lapseOverdueProposals(admin);

  /**
   * ── opportunities worth telling the team about (G-036) ────────────────
   *
   * §2.7: AgencyOS may *identify* an opportunity and tell the team, and must
   * never state a price. This writes a row; it contacts nobody, and the table
   * has no column a price could go in.
   */
  const upsell = await detectUpsellSignals(admin);

  /**
   * ── follow-ups (G-012, ADM-69) ────────────────────────────────────────
   *
   * Observe, revalidate, claim, send, record — beside the other sweeps and
   * on the same runner, because ADM-69's work is the same shape as theirs and
   * a second queue would be a second set of retry, tenancy and idempotency
   * rules to keep in step.
   *
   * On a deployment with no agency timezone set, every sequence is blocked
   * with `timezone_unavailable` and nothing is sent (G-137). That is the
   * honest state: the alternative is guessing an hour.
   */
  const followUps = await runFollowUps(admin);

  /**
   * ── past-due invoices chased on WhatsApp (owner decision 2026-09-29) ──
   *
   * The same shape as the follow-ups, one schema over: observe, pick the
   * thread, claim (the invoice_sends row), queue through
   * `crm.send_outbound_message` and the `followup.queued` handler, so
   * consent, the 24-hour window and the approved `invoice_reminder`
   * template keep deciding. Off until an owner turns it on under Settings ›
   * Finance; then one reminder per invoice per interval, never more.
   */
  const invoiceReminders = await runInvoiceReminders(admin);

  /**
   * ── Phase 2's state follows the facts (Master §9, PM §11) ──────────────
   *
   * One bounded set-based pass: each running Phase 2 is read against the same
   * facts the kickoff gate reads and moved to what it is actually waiting for
   * (client, admin, finance, planning, or ready). A failure here is logged and
   * ignored - a stale label must never stop the queue behind it.
   */
  const phaseTwoStates = await admin.schema('projects').rpc('refresh_phase_two_states', { p_limit: 200 });

  /**
   * ── a client who has not answered an onboarding ask is reminded (ADM-109) ──
   *
   * Off until the owner chooses a number of days under Settings; then at most two
   * short reminders, inside the sending window, never to a client who has written
   * since the ask. Sent through the same chokepoint as every client message.
   */
  const onboardingFollowUps = await runOnboardingFollowUps(admin);

  /**
   * The week in lead generation, told once per organisation per ISO week as an info alert. Idempotent (the alert fingerprint carries the
   * week, in any state), so running it each tick costs one cheap pass and cannot repeat itself. A failure is logged and ignored.
   */
  const autopilot = await admin.schema('crm').rpc('run_acquisition_autopilot');
  if (autopilot.error) {
    console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `acquisition autopilot: ${autopilot.error.message}` }));
  }
  const digest = await admin.schema('crm').rpc('run_acquisition_digest');
  if (digest.error) {
    console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `acquisition digest: ${digest.error.message}` }));
  }
  if (phaseTwoStates.error) {
    console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `phase two states: ${phaseTwoStates.error.message}` }));
  }

  /**
   * ── campaigns, one governed send at a time (owner decision 2026-09-30) ──
   *
   * Broadcast reopened as a governed campaign: an approved plan expands to
   * one recipient row per lead, and this claims up to 25 of them per tick
   * (FOR UPDATE SKIP LOCKED) and sends each through the composer's own
   * template door, so consent, the phone, the outreach limits and the
   * template's facts decide every recipient separately. A refused
   * recipient is recorded with its reason; a spent organization allowance
   * holds the rest for a later tick rather than refusing them.
   */
  const campaigns = await runCampaigns(admin);
  // Email outreach (info@): every send passes crm.claim_outreach_sends, inside the sending window only.
  const emailOutreach = await runOutreach(admin);
  // The replies, bounces and unsubscribes that arrived on the two mailboxes (paced inside, and only when IMAP is configured).
  await runInboundEmail(admin);
  // Tracked WhatsApp handoff links that were never used past their expiry (lead generation, 20261015300000).
  await expireHandoffs(admin);
  // Orchestrator housekeeping, behind the same CRON_SECRET check as everything above: a build request nobody reported on for two hours is settled as a
  // failed dispatch, and a lease past its time is expired so a crashed worker does not hold files forever.
  await sweepStaleOrchestratorRecords(admin);
  await sweepFinanceExceptions(admin);
  await sweepFinancePhaseNineB(admin);
  await sweepMaintenanceLifecycle(admin);
  // Phase 8A: SLA breaches, scheduled health snapshots, due check-in notices, support messages whose label arrived late, and the draft handover catch-up. Contacts nobody.
  await sweepSupportAndHealth(admin);
  // Phase 7 retention: a record class past its Admin-set period is marked eligible for a person's review. Deletes nothing.
  await sweepRetentionReviews(admin);
  // Scheduled social posts that are due: published through the governed door, or surfaced for a person when no publisher exists.
  await runSocialPublishing(admin, SOCIAL_PUBLISHERS);
  // Approved ad changes, pending pauses, emergency stops and campaign health (lead generation, 20261020100000).
  await runAdOperations(admin, AD_PROVIDERS);
  // Meta's daily figures for the campaigns a person recorded as launched, read-only and recorded through the door a hand-copied figure uses.
  // Every fifteenth minute is enough (the figures are daily and restated late), and a connection with nothing launched never calls Meta.
  if (Math.floor(Date.now() / 60_000) % 15 === 0) {
    try { await syncMetaAdMetrics(admin); } catch (e) { console.error(JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `meta metrics: ${e instanceof Error ? e.message : 'unknown'}` })); }
  }
  // Approved landing pages: deployed through the governed door, then checked at the public address (20261021100000).
  await runLandingOperations(admin, LANDING_DEPLOYER);
  // Approved marketplace proposals: sent only by a connector the owner allowed, else a person is told (20261022100000).
  await runB2bOperations(admin, B2B_CONNECTORS);
  // AI providers: probe the ones that are due and refresh their model lists (best effort, bounded per tick).
  await runProviderMaintenance(admin);

  /**
   * ── scheduled announcements (SCR-059, bucket F) ────────────────────────
   *
   * A draft with a moment set becomes published at that moment. A record,
   * not a send; audited as by the schedule.
   */
  const dueAnnouncements = await publishDueAnnouncements(admin);

  /**
   * ── suite schedules (SCR-048, bucket F) ────────────────────────────────
   *
   * A suite on a cron expression: when it is due, the tick OPENS a run
   * against the scheduled build and advances the schedule. The panel has no
   * test runner, so a fired schedule is a run somebody fills and closes —
   * nothing here claims a suite passed.
   */
  const suiteSchedules = await runSuiteSchedules(admin);

  /**
   * ── invoices whose date has passed (G-004) ────────────────────────────
   *
   * The transition INVOICE_TRANSITIONS has admitted since the first day and
   * nothing ever performed. It marks state and stops — chasing the client is
   * a message, and that waits on the outbound policy rather than arriving
   * behind a status change.
   */
  const overdue = await markOverdueInvoices(admin);

  /**
   * ── the agent registry, stamped against its definitions ────────────────
   *
   * ADM-83's `definition_version` and `last_validated_at` had no producer in
   * production: the only writer was a verification script that targets the
   * isolated database by design. Both columns were NULL on every production
   * row and `/agents` showed every agent as `never` validated — a field that
   * is always empty teaches a reader to stop looking at it.
   *
   * Cheap in the steady state: it reads the defined keys and writes only rows
   * whose stamp is not already the current revision, so an unchanged registry
   * costs one select per tick and no write at all.
   */
  const stamps = await stampAgentDefinitions(admin);

  /**
   * ── search by meaning (decision 14) ────────────────────────────────────
   *
   * For an organisation whose owner turned it on: embed new and changed
   * records, a bounded page at a time, under the monthly budget gates. A
   * failure is logged inside and never stops the tick.
   */
  const semantic = await runSemanticIndexing(admin, AGENT_DEFINITIONS).catch((error) => {
    console.error(JSON.stringify({ level: 'error', scope: 'jobs/run.semantic', detail: error instanceof Error ? error.message : String(error) }));
    return null;
  });

  const alerted = await alertOnBacklog(admin);

  /**
   * ── milestone unlocks ─────────────────────────────────────────────────
   *
   * Drained before the extraction path below because these are pure database
   * work — no model call, no network — so a batch of them costs milliseconds
   * and holding up the revenue path behind an AI job would be the wrong
   * priority. The batch is bounded, and cron runs every minute, so extraction
   * waits at most one tick behind a burst of unlocks.
   */
  const unlocks = await runEventJobs(
    admin,
    UNLOCK_JOB_KIND,
    handleInvoicePaid,
    'runUnlockJobs',
  );
  if (unlocks.claimed > 0) {
    return NextResponse.json({
      claimed: unlocks.claimed,
      kind: UNLOCK_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      unlocks: unlocks.results,
      correlationId,
    });
  }

  /**
   * ── Phase 2 starts (Master Flow §5.1) ─────────────────────────────────
   *
   * AFTER the unlocks, and the ordering is the whole comment. Both are pure
   * database work and both return early when they claim, so whichever runs
   * first takes the tick — and the first draft put this one ahead of the
   * unlocks. CI found it in one run: `verify-won-handoff` binds a project,
   * which now emits `project.handoff_bound`, which queued a start job, which
   * claimed the tick the unlock verifier was waiting for. A milestone stayed
   * `pending` and a paid invoice unlocked nothing.
   *
   * The revenue path keeps its priority. A Phase 2 that starts on the next
   * tick is a minute late; a milestone that never unlocks is a client whose
   * paid work did not begin.
   */
  const phaseTwo = await runEventJobs(
    admin,
    PHASE_TWO_JOB_KIND,
    handleHandoffBound,
    'runPhaseTwoJobs',
  );
  if (phaseTwo.claimed > 0) {
    return NextResponse.json({
      claimed: phaseTwo.claimed,
      kind: PHASE_TWO_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      phaseTwo: phaseTwo.results,
      correlationId,
    });
  }

  /**
   * ── Phase 3 starts (Master §7.12, §15) ────────────────────────────────
   *
   * Immediately after Phase 2's, and for the same reason it sits here rather
   * than earlier: pure database work that returns the tick when it claims, so
   * it must not get ahead of the revenue path. A Phase 3 that starts on the
   * next tick is a minute late.
   *
   * Drained separately from Phase 2 rather than folded into one call: the two
   * jobs call different doors with different refusals, and a shared drain
   * would report one kind for both in the response a person reads.
   */
  const phaseThree = await runEventJobs(
    admin,
    PHASE_THREE_JOB_KIND,
    handlePhaseThreeReady,
    'runPhaseThreeJobs',
  );
  if (phaseThree.claimed > 0) {
    return NextResponse.json({
      claimed: phaseThree.claimed,
      kind: PHASE_THREE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      phaseThree: phaseThree.results,
      correlationId,
    });
  }

  /**
   * ── Phase 4 starts (Impl §8, §22; ORCH §19) ─────────────────────────────
   *
   * Same tier as Phase 2's and Phase 3's starts, for the same reason: pure
   * database work that returns the tick when it claims, drained separately
   * because it calls a different door with different refusals.
   */
  const phaseFour = await runEventJobs(
    admin,
    PHASE_FOUR_JOB_KIND,
    handlePhaseFourReady,
    'runPhaseFourJobs',
  );
  if (phaseFour.claimed > 0) {
    return NextResponse.json({
      claimed: phaseFour.claimed,
      kind: PHASE_FOUR_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      phaseFour: phaseFour.results,
      correlationId,
    });
  }

  /**
   * ── Task 2's first routing hop (ORCH §4, §19) ───────────────────────────
   *
   * Immediately after Phase 4 starts, same tier as the three starts above:
   * pure database work (a registry lookup and one insert, no model call), so
   * it drains before anything that spends a budget.
   */
  const task2Route = await runEventJobs(
    admin,
    TASK2_ROUTE_JOB_KIND,
    handleRouteTask2Design,
    'runTask2RouteJobs',
  );
  if (task2Route.claimed > 0) {
    return NextResponse.json({
      claimed: task2Route.claimed,
      kind: TASK2_ROUTE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      task2Route: task2Route.results,
      correlationId,
    });
  }

  /**
   * ── Phase 5: an approved development plan is routed to its specialists ───
   *
   * Pure database work (registry lookup, a handful of reads and inserts, no model call).
   */
  const devPlanRoute = await runEventJobs(admin, DEV_PLAN_ROUTE_JOB_KIND, handleRouteDevelopmentPlan, 'runDevelopmentPlanRouteJobs');
  if (devPlanRoute.claimed > 0) {
    return NextResponse.json({
      claimed: devPlanRoute.claimed,
      kind: DEV_PLAN_ROUTE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      devPlanRoute: devPlanRoute.results,
      correlationId,
    });
  }

  /**
   * ── Phase 5: a QA result on a development task is routed ────────────────
   *
   * Pure database work like the plan routing above: the task, its runs and defects are re-read, a decision is recorded, and a refusal is escalated
   * to a person. No model call.
   */
  const qaOutcomeRoute = await runEventJobs(admin, QA_OUTCOME_ROUTE_JOB_KIND, handleRouteQaOutcome, 'runQaOutcomeRouteJobs');
  if (qaOutcomeRoute.claimed > 0) {
    return NextResponse.json({
      claimed: qaOutcomeRoute.claimed,
      kind: QA_OUTCOME_ROUTE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      qaOutcomeRoute: qaOutcomeRoute.results,
      correlationId,
    });
  }

  /**
   * ── lead routing + identity classification (Audit 1.2/1.3) ─────────────
   *
   * Same tier as the routing hop above: pure database work — `crm.route_lead`
   * and `crm.classify_lead_identity` are one row read, one rule evaluation or
   * one set of existence checks, and at most one write, no model call. Two
   * independent kinds off the same `lead.created` event, drained separately
   * for the same reason Design QA and the test plan below are: one failing
   * must not lose the other's work.
   */
  // NOT an early return, unlike the lanes above. Every new lead raises these two jobs, so a lane that ends the tick when it has work would
  // hold the agent batch back by a tick for each of them - two minutes before a new lead's reply or extraction is even claimed. They are a
  // few milliseconds each (no model call), so they drain here and the tick carries on to the agents; their results ride the final answer.
  const leadRouting = await runEventJobs(
    admin,
    LEAD_ROUTE_JOB_KIND,
    handleRouteLead,
    'runLeadRoutingJobs',
  );

  const leadIdentity = await runEventJobs(
    admin,
    LEAD_IDENTITY_JOB_KIND,
    handleClassifyLeadIdentity,
    'runLeadIdentityJobs',
  );

  /**
   * ── Design QA's coverage verdict (QAP §7, ADM-82) ───────────────────────
   *
   * Same tier as the routing hop above: pure database work (a coverage
   * comparison and one RPC, no model call), so it drains before anything that
   * spends a budget.
   */
  const uiVersionQa = await runEventJobs(
    admin,
    UI_VERSION_QA_JOB_KIND,
    handleReviewUIVersion,
    'runUiVersionQaJobs',
  );
  if (uiVersionQa.claimed > 0) {
    return NextResponse.json({
      claimed: uiVersionQa.claimed,
      kind: UI_VERSION_QA_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      uiVersionQa: uiVersionQa.results,
      correlationId,
    });
  }

  /**
   * ── Admin review raised on QA pass (Impl §7.2) ──────────────────────────
   *
   * Same tier as the QA verdict above: pure database work (reads the row,
   * raises one approval request), no model call.
   */
  const uiVersionAdminReview = await runEventJobs(
    admin,
    UI_VERSION_ADMIN_REVIEW_JOB_KIND,
    handleRequestUIVersionAdminReview,
    'runUiVersionAdminReviewJobs',
  );
  if (uiVersionAdminReview.claimed > 0) {
    return NextResponse.json({
      claimed: uiVersionAdminReview.claimed,
      kind: UI_VERSION_ADMIN_REVIEW_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      uiVersionAdminReview: uiVersionAdminReview.results,
      correlationId,
    });
  }

  /**
   * ── Prototype QA's coverage verdict (QAP §7, ADM-82) ────────────────────
   *
   * Same tier as Design QA's: pure database work, no model call. Drained
   * before the AI agent batch below, which is where `ui_prototype:build`
   * itself runs (an `AGENT_WORKFLOWS` kind, claimed generically).
   */
  const prototypeQa = await runEventJobs(
    admin,
    PROTOTYPE_QA_JOB_KIND,
    handleReviewPrototypeBuild,
    'runPrototypeQaJobs',
  );
  if (prototypeQa.claimed > 0) {
    return NextResponse.json({
      claimed: prototypeQa.claimed,
      kind: PROTOTYPE_QA_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      prototypeQa: prototypeQa.results,
      correlationId,
    });
  }

  /**
   * ── M1 invoice auto-generation (Phase 2 Master Flow §5–§6) ──────────────
   *
   * Same tier as the two starts above it: pure database work (no model call,
   * no network beyond Postgres), so it drains before anything that spends a
   * budget, and after the phase starts because a project's Phase 2 workspace
   * (and its billing profile) must already exist before there is anything to
   * invoice.
   */
  const m1Invoices = await runEventJobs(
    admin,
    M1_INVOICE_JOB_KIND,
    handleBillingModeConfirmed,
    'runM1InvoiceJobs',
  );
  if (m1Invoices.claimed > 0) {
    return NextResponse.json({
      claimed: m1Invoices.claimed,
      kind: M1_INVOICE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      m1Invoices: m1Invoices.results,
      correlationId,
    });
  }

  /**
   * ── Task 2 completion (Impl §7.4; Master steps 39-40) ───────────────────
   *
   * Same tier: pure database work, drained before the M2 invoice it feeds.
   */
  const phaseFourCompletions = await runEventJobs(
    admin,
    PHASE_FOUR_COMPLETE_JOB_KIND,
    handleDeliverableDecided,
    'runPhaseFourCompletionJobs',
  );
  if (phaseFourCompletions.claimed > 0) {
    return NextResponse.json({
      claimed: phaseFourCompletions.claimed,
      kind: PHASE_FOUR_COMPLETE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      phaseFourCompletions: phaseFourCompletions.results,
      correlationId,
    });
  }

  /**
   * ── M4PaymentVerified (P601 §41) ────────────────────────────────────────
   *
   * Pure database work, drained right after the payment that can make it true.
   */
  const m4Verified = await runEventJobs(admin, M4_VERIFIED_JOB_KIND, handleRecordM4Verified, 'runM4VerifiedJobs');
  if (m4Verified.claimed > 0) {
    return NextResponse.json({
      claimed: m4Verified.claimed,
      kind: M4_VERIFIED_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      m4Verified: m4Verified.results,
      correlationId,
    });
  }

  /**
   * ── Phase 6: create/ready the workspace, then validate the QA intake (P601 §3, §10) ──
   *
   * Pure database work, drained right after the facts that open it.
   */
  const phaseSixStart = await runEventJobs(admin, PHASE_SIX_START_JOB_KIND, handleStartPhaseSix, 'runPhaseSixStartJobs');
  if (phaseSixStart.claimed > 0) {
    return NextResponse.json({
      claimed: phaseSixStart.claimed,
      kind: PHASE_SIX_START_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      phaseSixStart: phaseSixStart.results,
      correlationId,
    });
  }
  /**
   * ── Phase 7: open the workspace (Phase6Completed / M4PaymentVerified), then record the approved deployment (P701 §2, P704 §13) ──
   *
   * Pure database work. The deployment executor is NOT configured: the deploy job records an honest blocker and never a success.
   */
  const phaseSevenOpen = await runEventJobs(admin, PHASE_SEVEN_OPEN_JOB_KIND, handleOpenPhaseSeven, 'runPhaseSevenOpenJobs');
  if (phaseSevenOpen.claimed > 0) {
    return NextResponse.json({
      claimed: phaseSevenOpen.claimed,
      kind: PHASE_SEVEN_OPEN_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      phaseSevenOpen: phaseSevenOpen.results,
      correlationId,
    });
  }
  const phaseSevenDeploy = await runEventJobs(admin, PHASE_SEVEN_DEPLOY_JOB_KIND, handleRunDeployment, 'runPhaseSevenDeploymentJobs');
  if (phaseSevenDeploy.claimed > 0) {
    return NextResponse.json({
      claimed: phaseSevenDeploy.claimed,
      kind: PHASE_SEVEN_DEPLOY_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      phaseSevenDeploy: phaseSevenDeploy.results,
      correlationId,
    });
  }
  /**
   * ── Phase 7b: the Orchestrator's recorded routing decision for a Phase 7 task (P703), and the Phase 7 -> Phase 8 seam (M-6) ──
   *
   * Both are database work behind service-role doors. The routing job records where a Phase 7 task WOULD go (held while the agents are disabled); the intake
   * job fills Phase 8's intake from the frozen completion handoff. Neither starts, approves or deploys anything.
   */
  const phaseSevenRoute = await runEventJobs(admin, PHASE_SEVEN_ROUTE_JOB_KIND, handleRoutePhaseSevenTask, 'runPhaseSevenRouteJobs');
  if (phaseSevenRoute.claimed > 0) {
    return NextResponse.json({
      claimed: phaseSevenRoute.claimed,
      kind: PHASE_SEVEN_ROUTE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      phaseSevenRoute: phaseSevenRoute.results,
      correlationId,
    });
  }
  const phaseEightIntake = await runEventJobs(admin, PHASE_EIGHT_INTAKE_JOB_KIND, handleFillPhaseEightIntake, 'runPhaseEightIntakeJobs');
  if (phaseEightIntake.claimed > 0) {
    return NextResponse.json({
      claimed: phaseEightIntake.claimed,
      kind: PHASE_EIGHT_INTAKE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      phaseEightIntake: phaseEightIntake.results,
      correlationId,
    });
  }
  const supportFromMessage = await runEventJobs(admin, SUPPORT_FROM_MESSAGE_JOB_KIND, handleOpenSupportTicketFromMessage, 'runSupportTicketFromMessageJobs');
  if (supportFromMessage.claimed > 0) {
    return NextResponse.json({
      claimed: supportFromMessage.claimed,
      kind: SUPPORT_FROM_MESSAGE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      supportFromMessage: supportFromMessage.results,
      correlationId,
    });
  }
  const draftHandover = await runEventJobs(admin, DRAFT_HANDOVER_JOB_KIND, handleCreateDraftHandoverPackage, 'runDraftHandoverPackageJobs');
  if (draftHandover.claimed > 0) {
    return NextResponse.json({
      claimed: draftHandover.claimed,
      kind: DRAFT_HANDOVER_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      draftHandover: draftHandover.results,
      correlationId,
    });
  }
  const qaSchedule = await runEventJobs(admin, QA_SCHEDULE_JOB_KIND, handleScheduleQaJobs, 'runQaScheduleJobs');
  if (qaSchedule.claimed > 0) {
    return NextResponse.json({
      claimed: qaSchedule.claimed,
      kind: QA_SCHEDULE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      qaSchedule: qaSchedule.results,
      correlationId,
    });
  }
  const qaReopen = await runEventJobs(admin, QA_REOPEN_JOB_KIND, handleReopenOnSourceChange, 'runQaReopenJobs');
  if (qaReopen.claimed > 0) {
    return NextResponse.json({
      claimed: qaReopen.claimed,
      kind: QA_REOPEN_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      qaReopen: qaReopen.results,
      correlationId,
    });
  }
  const qaIntake = await runEventJobs(admin, QA_INTAKE_JOB_KIND, handleValidateQaIntake, 'runQaIntakeJobs');
  if (qaIntake.claimed > 0) {
    return NextResponse.json({
      claimed: qaIntake.claimed,
      kind: QA_INTAKE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      qaIntake: qaIntake.results,
      correlationId,
    });
  }

  /**
   * ── M3PaymentVerified (Finance spec, Phase 6 gate) ──────────────────────
   *
   * Pure database work, drained right after the payment that can make it true.
   */
  const m3Verified = await runEventJobs(admin, M3_VERIFIED_JOB_KIND, handleRecordM3Verified, 'runM3VerifiedJobs');
  if (m3Verified.claimed > 0) {
    return NextResponse.json({
      claimed: m3Verified.claimed,
      kind: M3_VERIFIED_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      m3Verified: m3Verified.results,
      correlationId,
    });
  }

  /**
   * ── Phase 5 start (Phase 5 Master Flow) ─────────────────────────────────
   *
   * Pure database work, drained right after the payment that can open it.
   */
  const phaseFiveStarts = await runEventJobs(
    admin,
    PHASE_FIVE_START_JOB_KIND,
    handleStartPhaseFive,
    'runPhaseFiveStartJobs',
  );
  if (phaseFiveStarts.claimed > 0) {
    return NextResponse.json({
      claimed: phaseFiveStarts.claimed,
      kind: PHASE_FIVE_START_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      phaseFiveStarts: phaseFiveStarts.results,
      correlationId,
    });
  }

  /**
   * ── M2 invoice auto-generation (Finance §2, §5) ─────────────────────────
   *
   * Same tier as M1's above: pure database work, drained right after Task 2
   * completion since that is the fact that triggers it.
   */
  const m2Invoices = await runEventJobs(
    admin,
    M2_INVOICE_JOB_KIND,
    handlePhaseFourCompletedForFinance,
    'runM2InvoiceJobs',
  );
  if (m2Invoices.claimed > 0) {
    return NextResponse.json({
      claimed: m2Invoices.claimed,
      kind: M2_INVOICE_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      m2Invoices: m2Invoices.results,
      correlationId,
    });
  }

  /**
   * ── M3 / M4 invoice auto-generation (Q-PH56) ────────────────────────────
   *
   * Exactly as M2 above: pure database work, drained right after the phase
   * completion that triggers it.
   */
  for (const [kind, handler, label] of [
    [M3_INVOICE_JOB_KIND, handlePhaseFiveCompletedForFinance, 'runM3InvoiceJobs'],
    [M4_INVOICE_JOB_KIND, handlePhaseSixCompletedForFinance, 'runM4InvoiceJobs'],
  ] as const) {
    const later = await runEventJobs(admin, kind, handler, label);
    if (later.claimed > 0) {
      return NextResponse.json({
        claimed: later.claimed,
        kind,
        dispatched,
        reaped,
        alerted,
        expired,
        lapsed,
        upsell,
        followUps,
        invoiceReminders,
        campaigns,
        overdue,
        stamps,
        laterInvoices: later.results,
        correlationId,
      });
    }
  }

  /**
   * ── scope-escalation change requests (Doc 11 §16–§17; Master §17) ───────
   *
   * Same tier as the invoice above it: pure database work, no model call, no
   * outbound provider. `possible_scope_change` stops Phase 3 the moment it is
   * recorded; this is the receiver that opens the change request a PM was
   * previously expected to notice the stopped phase and create by hand.
   */
  const scopeChangeRequests = await runEventJobs(
    admin,
    SCOPE_CHANGE_REQUEST_JOB_KIND,
    handlePossibleScopeChangeDetected,
    'runScopeChangeRequestJobs',
  );
  if (scopeChangeRequests.claimed > 0) {
    return NextResponse.json({
      claimed: scopeChangeRequests.claimed,
      kind: SCOPE_CHANGE_REQUEST_JOB_KIND,
      dispatched,
      reaped,
      alerted,
      expired,
      lapsed,
      upsell,
      followUps,
      invoiceReminders,
      campaigns,
      emailOutreach,
      overdue,
      stamps,
      scopeChangeRequests: scopeChangeRequests.results,
      correlationId,
    });
  }

  /**
   * ── approval announcements (G-110) ────────────────────────────────────
   *
   * After unlocks, before extraction. This one reaches an outside provider, so
   * it is not the pure database work above and does not belong ahead of the
   * revenue path — but it is a single request rather than a model call, and an
   * owner waiting to hear that a quotation needs signing should not queue
   * behind an AI job.
   *
   * Which provider is deliberately not named here, and not only in prose: the
   * runner claims, hands off and settles, and the handler owns every fact
   * about where the message goes. `tests/cron-scheduler.test.ts` enforces
   * that by refusing the word in this file.
   */
  const announcements = await runEventJobs(
    admin,
    ANNOUNCE_JOB_KIND,
    handleApprovalRequested,
    'runAnnounceJobs',
  );

  /**
   * ── escalation announcements (Doc 09 §7, §36) ─────────────────────────
   *
   * Beside the approval announcements and drained by the same generic loop,
   * because it is the same act: telling the internal group that something
   * needs a person. It is placed after them rather than before on the same
   * reasoning the comment above gives — a decision somebody is blocked on
   * outranks a conversation, though not by much, and both are one HTTP
   * request rather than a model call.
   */
  const escalations = await runEventJobs(
    admin,
    ESCALATION_JOB_KIND,
    handleConversationEscalated,
    'runEscalationJobs',
  );

  /**
   * ── the handover acknowledgement (owner decision 2026-10-03) ─────────
   *
   * A client wrote while their thread waits for a person. The application —
   * not the agent — tells them once that a colleague has it, and alerts staff.
   * One HTTP request, no model call, so it drains beside the announcements.
   */
  const clientWaiting = await runEventJobs(
    admin,
    CLIENT_WAITING_JOB_KIND,
    handleClientWaiting,
    'runClientWaitingJobs',
  );

  /**
   * ── Phase 3 revision-limit and completion announcements (G-309) ──────
   *
   * Beside the other internal-group announcements and drained by the same
   * generic loop, for the same reason: telling a person something needs
   * them, or that a task closed, is one HTTP request rather than a model
   * call. Both events previously reached nobody — see the handlers' own
   * comments in `modules/crm/handlers.ts`.
   */
  const revisionLimitAnnouncements = await runEventJobs(
    admin,
    REVISION_LIMIT_JOB_KIND,
    handleRevisionLimitEscalated,
    'runRevisionLimitAnnouncementJobs',
  );

  const phaseThreeCompletedAnnouncements = await runEventJobs(
    admin,
    PHASE_THREE_COMPLETED_JOB_KIND,
    handlePhaseThreeCompleted,
    'runPhaseThreeCompletedAnnouncementJobs',
  );

  /**
   * ── PM Task 2 milestone announcements (Impl §8; PM §5) ────────────────
   *
   * Same weight and the same place as Phase 3's completion announcement
   * above: one internal-group WhatsApp send, no model call. Four separate
   * events rather than one, because each names a different milestone with
   * its own idempotency key — collapsing them into one handler would lose
   * that.
   */
  const phaseFourStartedAnnouncements = await runEventJobs(
    admin,
    PHASE_FOUR_STARTED_JOB_KIND,
    announcePhaseFourStarted,
    'runPhaseFourStartedAnnouncementJobs',
  );

  const uiVersionAdminReviewedAnnouncements = await runEventJobs(
    admin,
    UI_VERSION_ADMIN_REVIEWED_JOB_KIND,
    announceUiVersionAdminReviewed,
    'runUiVersionAdminReviewedAnnouncementJobs',
  );

  const uiVersionChangeRequestedAnnouncements = await runEventJobs(
    admin,
    UI_VERSION_CHANGE_REQUESTED_JOB_KIND,
    announceUiVersionChangeRequested,
    'runUiVersionChangeRequestedAnnouncementJobs',
  );

  const uiVersionLockedAnnouncements = await runEventJobs(
    admin,
    UI_VERSION_LOCKED_ANNOUNCE_JOB_KIND,
    announceUiVersionLocked,
    'runUiVersionLockedAnnouncementJobs',
  );

  const prototypeSubmittedAnnouncements = await runEventJobs(
    admin,
    PROTOTYPE_SUBMITTED_JOB_KIND,
    announcePrototypeSubmitted,
    'runPrototypeSubmittedAnnouncementJobs',
  );

  const prototypeChangeRequestedAnnouncements = await runEventJobs(
    admin,
    PROTOTYPE_CHANGE_REQUESTED_JOB_KIND,
    announcePrototypeChangeRequested,
    'runPrototypeChangeRequestedAnnouncementJobs',
  );

  const task2CompleteAnnouncements = await runEventJobs(
    admin,
    TASK2_COMPLETE_JOB_KIND,
    announceTask2Complete,
    'runTask2CompleteAnnouncementJobs',
  );

  // PM6 (Phase 6 PM Agent spec): testing started, candidate approved, M4 verified.
  const testingStartedAnnouncements = await runEventJobs(admin, TESTING_STARTED_ANNOUNCE_JOB_KIND, announceTestingStarted, 'runTestingStartedAnnouncementJobs');
  const qaClarificationAnnouncements = await runEventJobs(admin, QA_CLARIFICATION_ANNOUNCE_JOB_KIND, announceQaClarification, 'runQaClarificationAnnouncementJobs');
  const qaDefectProgressAnnouncements = await runEventJobs(admin, QA_DEFECT_PROGRESS_ANNOUNCE_JOB_KIND, announceQaDefectProgress, 'runQaDefectProgressAnnouncementJobs');
  const rcApprovedAnnouncements = await runEventJobs(admin, RC_APPROVED_ANNOUNCE_JOB_KIND, announceReleaseCandidateApproved, 'runReleaseCandidateApprovedAnnouncementJobs');
  const rcReadyAnnouncements = await runEventJobs(admin, RC_READY_ANNOUNCE_JOB_KIND, announceReleaseCandidateReady, 'runReleaseCandidateReadyAnnouncementJobs');
  const rcExceptionAnnouncements = await runEventJobs(admin, RC_EXCEPTION_ANNOUNCE_JOB_KIND, announceReleaseExceptionRequested, 'runReleaseExceptionAnnouncementJobs');
  // PM8 (Phase 8A): Customer Success / Support announcements, internal channel only.
  const phaseEightStartedAnnouncements = await runEventJobs(admin, PHASE_EIGHT_STARTED_ANNOUNCE_JOB_KIND, announcePhaseEightStarted, 'runPhaseEightStartedAnnouncementJobs');
  const supportEscalatedAnnouncements = await runEventJobs(admin, SUPPORT_ESCALATED_ANNOUNCE_JOB_KIND, announceSupportTicketEscalated, 'runSupportTicketEscalatedAnnouncementJobs');
  const supportSlaBreachedAnnouncements = await runEventJobs(admin, SUPPORT_SLA_BREACHED_ANNOUNCE_JOB_KIND, announceSupportSlaBreached, 'runSupportSlaBreachedAnnouncementJobs');
  const retentionRecoveryAnnouncements = await runEventJobs(admin, RETENTION_RECOVERY_ANNOUNCE_JOB_KIND, announceRetentionRecoveryRequired, 'runRetentionRecoveryAnnouncementJobs');
  const maintenanceRenewalDueAnnouncements = await runEventJobs(admin, MAINTENANCE_RENEWAL_DUE_ANNOUNCE_JOB_KIND, announceMaintenanceRenewalDue, 'runMaintenanceRenewalDueAnnouncementJobs');
  // PM8-C (Phase 8C): the post-launch maintenance events (work, QA, release, billing draft, SLA breach, stall). Internal channel only.
  const maintenanceWorkOpenedAnnouncements = await runEventJobs(admin, MAINTENANCE_WORK_OPENED_ANNOUNCE_JOB_KIND, announceMaintenanceWorkOpened, 'runMaintenanceWorkOpenedAnnouncementJobs');
  const maintenanceQaFailedAnnouncements = await runEventJobs(admin, MAINTENANCE_QA_FAILED_ANNOUNCE_JOB_KIND, announceMaintenanceQaFailed, 'runMaintenanceQaFailedAnnouncementJobs');
  const maintenanceReleaseRequestedAnnouncements = await runEventJobs(admin, MAINTENANCE_RELEASE_REQUESTED_ANNOUNCE_JOB_KIND, announceMaintenanceReleaseRequested, 'runMaintenanceReleaseRequestedAnnouncementJobs');
  const maintenanceReleaseApprovedAnnouncements = await runEventJobs(admin, MAINTENANCE_RELEASE_APPROVED_ANNOUNCE_JOB_KIND, announceMaintenanceReleaseApproved, 'runMaintenanceReleaseApprovedAnnouncementJobs');
  const maintenanceReleasedAnnouncements = await runEventJobs(admin, MAINTENANCE_RELEASED_ANNOUNCE_JOB_KIND, announceMaintenanceReleased, 'runMaintenanceReleasedAnnouncementJobs');
  const maintenanceBillingProposedAnnouncements = await runEventJobs(admin, MAINTENANCE_BILLING_PROPOSED_ANNOUNCE_JOB_KIND, announceMaintenanceBillingProposed, 'runMaintenanceBillingProposedAnnouncementJobs');
  const maintenanceSlaBreachedAnnouncements = await runEventJobs(admin, MAINTENANCE_SLA_BREACHED_ANNOUNCE_JOB_KIND, announceMaintenanceSlaBreached, 'runMaintenanceSlaBreachedAnnouncementJobs');
  const maintenanceWorkStalledAnnouncements = await runEventJobs(admin, MAINTENANCE_WORK_STALLED_ANNOUNCE_JOB_KIND, announceMaintenanceWorkStalled, 'runMaintenanceWorkStalledAnnouncementJobs');
  const qaReverificationAnnouncements = await runEventJobs(admin, QA_REVERIFICATION_ANNOUNCE_JOB_KIND, announceQaReverification, 'runQaReverificationAnnouncementJobs');
  const m4VerifiedAnnouncements = await runEventJobs(admin, M4_VERIFIED_ANNOUNCE_JOB_KIND, announceM4PaymentVerified, 'runM4VerifiedAnnouncementJobs');
  // Phase 9: the project's finances were closed.
  const financiallyClosedAnnouncements = await runEventJobs(admin, FINANCIALLY_CLOSED_ANNOUNCE_JOB_KIND, announceFinanciallyClosed, 'runFinanciallyClosedAnnouncementJobs');
  // PM6-M01 (Phase 6 PM Agent spec): Task 4 start.
  const phaseSixReadyAnnouncements = await runEventJobs(admin, PHASE_SIX_READY_ANNOUNCE_JOB_KIND, announcePhaseSixReady, 'runPhaseSixReadyAnnouncementJobs');
  // PM7 (Phase 7 PM Agent spec): Task 5 start, deployment approved, production validated / failed, handover ready, project completed.
  const phaseSevenReadyAnnouncements = await runEventJobs(admin, PHASE_SEVEN_READY_ANNOUNCE_JOB_KIND, announcePhaseSevenReady, 'runPhaseSevenReadyAnnouncementJobs');
  const deploymentApprovedAnnouncements = await runEventJobs(admin, DEPLOYMENT_APPROVED_ANNOUNCE_JOB_KIND, announceDeploymentApproved, 'runDeploymentApprovedAnnouncementJobs');
  const productionValidatedAnnouncements = await runEventJobs(admin, PRODUCTION_VALIDATED_ANNOUNCE_JOB_KIND, announceProductionValidated, 'runProductionValidatedAnnouncementJobs');
  const productionValidationFailedAnnouncements = await runEventJobs(admin, PRODUCTION_VALIDATION_FAILED_ANNOUNCE_JOB_KIND, announceProductionValidationFailed, 'runProductionValidationFailedAnnouncementJobs');
  const handoverReadyAnnouncements = await runEventJobs(admin, HANDOVER_READY_ANNOUNCE_JOB_KIND, announceHandoverReady, 'runHandoverReadyAnnouncementJobs');
  const projectCompletedAnnouncements = await runEventJobs(admin, PROJECT_COMPLETED_ANNOUNCE_JOB_KIND, announceProjectCompleted, 'runProjectCompletedAnnouncementJobs');
  // PM5-M01..M04 (Phase 5 PM Agent spec), beside the Task 2 set.
  const m3VerifiedAnnouncements = await runEventJobs(admin, M3_VERIFIED_ANNOUNCE_JOB_KIND, announceM3PaymentVerified, 'runM3VerifiedAnnouncementJobs');
  const buildFeedbackRoutedAnnouncements = await runEventJobs(admin, BUILD_FEEDBACK_ROUTED_ANNOUNCE_JOB_KIND, announceBuildFeedbackRouted, 'runBuildFeedbackRoutedAnnouncementJobs');
  const phaseFiveStartedAnnouncements = await runEventJobs(admin, PHASE_FIVE_STARTED_ANNOUNCE_JOB_KIND, announcePhaseFiveStarted, 'runPhaseFiveStartedAnnouncementJobs');
  const buildSharedAnnouncements = await runEventJobs(admin, BUILD_SHARED_ANNOUNCE_JOB_KIND, announceBuildShared, 'runBuildSharedAnnouncementJobs');
  const buildFeedbackAnnouncements = await runEventJobs(admin, BUILD_FEEDBACK_ANNOUNCE_JOB_KIND, announceBuildFeedbackReceived, 'runBuildFeedbackAnnouncementJobs');
  const buildReadyForAdminAnnouncements = await runEventJobs(admin, BUILD_READY_FOR_ADMIN_ANNOUNCE_JOB_KIND, announceBuildReadyForAdmin, 'runBuildReadyForAdminAnnouncementJobs');
  const developmentEscalatedAnnouncements = await runEventJobs(admin, DEVELOPMENT_ESCALATED_ANNOUNCE_JOB_KIND, announceDevelopmentEscalated, 'runDevelopmentEscalatedAnnouncementJobs');
  const moduleCompletedAnnouncements = await runEventJobs(admin, MODULE_COMPLETED_ANNOUNCE_JOB_KIND, announceModuleCompleted, 'runModuleCompletedAnnouncementJobs');
  const devClarificationAnnouncements = await runEventJobs(admin, DEV_CLARIFICATION_ANNOUNCE_JOB_KIND, announceDevClarification, 'runDevClarificationAnnouncementJobs');
  const buildApprovedAnnouncements = await runEventJobs(admin, BUILD_APPROVED_ANNOUNCE_JOB_KIND, announceBuildApproved, 'runBuildApprovedAnnouncementJobs');

  // Q-PH56: the PM's Task 3 / Task 4 Complete messages, beside Task 2's.
  const task3CompleteAnnouncements = await runEventJobs(admin, TASK3_COMPLETE_JOB_KIND, announceTask3Complete, 'runTask3CompleteAnnouncementJobs');
  const task4CompleteAnnouncements = await runEventJobs(admin, TASK4_COMPLETE_JOB_KIND, announceTask4Complete, 'runTask4CompleteAnnouncementJobs');

  /**
   * ── the issued invoice is delivered (Phase 2 Finance §4.5) ──────────────
   *
   * One HTTP request per channel, no model call, so it drains beside the
   * announcements. A person issued the invoice; this carries it to the client.
   */
  // Phase 7 complete → the free-maintenance document (Finance §9), drained before its delivery.
  const freeMaintenance = await runEventJobs(admin, FREE_MAINTENANCE_JOB_KIND, handleHandoverAcceptedForFinance, 'runFreeMaintenanceJobs');
  const invoiceDeliveries = await runEventJobs(
    admin,
    INVOICE_DELIVERY_JOB_KIND,
    handleInvoiceIssuedForDelivery,
    'runInvoiceDeliveryJobs',
  );

  /**
   * ── the project manager talks to the client (Phase 2 PM §6) ─────────────
   *
   * Fixed templates, one HTTP request each, no model call: drained beside the
   * announcements. The billing answer is read here too; it only tells staff.
   */
  const pmWelcomes = await runEventJobs(admin, PM_WELCOME_JOB_KIND, handleWelcomeClient, 'runPmWelcomeJobs');
  const pmPhaseThreeAnnouncements = await runEventJobs(admin, PM_PHASE3_ANNOUNCE_JOB_KIND, handleAnnouncePhaseThree, 'runPmPhaseThreeAnnounceJobs');
  const pmFinalAsks = await runEventJobs(admin, PM_DESIGN_FINAL_ASK_JOB_KIND, handleAskFinalConfirmation, 'runPmDesignFinalAskJobs');
  const pmGstDetails = await runEventJobs(admin, PM_GST_DETAILS_JOB_KIND, handleAskGstDetails, 'runPmGstDetailsJobs');
  const pmPaymentUpdates = await runEventJobs(admin, PM_PAYMENT_UPDATE_JOB_KIND, handlePaymentUpdate, 'runPmPaymentUpdateJobs');
  const pmBillingReplies = await runEventJobs(admin, PM_BILLING_REPLY_JOB_KIND, handleReadBillingReply, 'runPmBillingReplyJobs');
  const pmClarifications = await runEventJobs(admin, PM_CLARIFY_JOB_KIND, handleAskClarification, 'runPmClarifyJobs');
  const pmClarificationAnswers = await runEventJobs(admin, PM_CLARIFICATION_ANSWER_JOB_KIND, handleReadClarificationAnswer, 'runPmClarificationAnswerJobs');

  const m2PaymentVerifiedAnnouncements = await runEventJobs(
    admin,
    M2_PAYMENT_VERIFIED_JOB_KIND,
    announceM2PaymentVerified,
    'runM2PaymentVerifiedAnnouncementJobs',
  );

  /**
   * ── approved-quotation dispatch (ADM-96, G-162) ───────────────────────
   *
   * The second half of a decision: an approved quotation goes to the client,
   * carried by the handler and authored with the person who approved it.
   * Drained beside the announcements because it is the same weight — one
   * outbound request, not a model call — and placed after them on the same
   * ranking: a decision somebody is BLOCKED on outranks the consequences of
   * one already taken.
   */
  const dispatches = await runEventJobs(
    admin,
    DISPATCH_JOB_KIND,
    dispatchApprovedQuotation,
    'runProposalDispatchJobs',
  );

  /**
   * ── the owner is told what an offer sent (G-184) ──────────────────────
   *
   * Drained beside the other announcements and immediately after the dispatch
   * that sent it, because it is the same weight — one outbound request — and
   * because the thing it reports has already happened. The client has the
   * quotation; this is the person who authorised the concession finding out
   * that it was used.
   */
  const offerNotices = await runEventJobs(
    admin,
    OFFER_JOB_KIND,
    announceOfferApplied,
    'runOfferAnnouncementJobs',
  );

  /**
   * ── what the owner's decision teaches (G-180) ─────────────────────────
   *
   * Pure database work — a read, a comparison and one insert, with no model
   * call and no outside provider — so it costs about what an unlock does and
   * is drained on the same terms.
   *
   * Placed AFTER the dispatch deliberately. Both listen to the same event, but
   * the dispatch is what a client is waiting for and this is a note the agency
   * writes to itself. A tick that could only do one of them should do the one
   * somebody is waiting on.
   */
  const lessons = await runEventJobs(
    admin,
    LEARN_JOB_KIND,
    learnFromDecision,
    'runQuotationLearningJobs',
  );

  /**
   * ── what the owner changed (G-185) ────────────────────────────────────
   *
   * Beside the pricing lesson and after it, for the same reason that one sits
   * after the dispatch: both are notes the agency writes to itself, and a tick
   * short of time should spend it on the client who is waiting.
   */
  const revisionLessons = await runEventJobs(
    admin,
    REVISION_JOB_KIND,
    learnFromRevision,
    'runRevisionLearningJobs',
  );

  /**
   * ── a discount decision hears what the owner decided (Business Phase 1-4
   *    audit step 1.27) ───────────────────────────────────────────────────
   *
   * Pure database work, the same weight as the pricing lesson beside it: read
   * the settled request, carry `approved`/anything-else onto the
   * discount_decisions row. Placed with the other approval.decided consumers
   * that write a note to the agency rather than a message to a client.
   */
  const discountDecisionSyncs = await runEventJobs(
    admin,
    DISCOUNT_SYNC_JOB_KIND,
    syncDiscountDecision,
    'runDiscountDecisionSyncJobs',
  );

  /**
   * ── follow-up delivery (G-012, ADM-69) ────────────────────────────────
   *
   * The follow-up worker claims an attempt and writes the message; this hands
   * it to the provider. Drained through the same generic loop as the
   * announcements, so it inherits the retry budget, the backoff and the
   * parking rather than growing its own — and for the same reason there is no
   * early return here either.
   */
  const followUpDeliveries = await runEventJobs(
    admin,
    FOLLOWUP_JOB_KIND,
    deliverFollowUp,
    'runFollowUpDeliveryJobs',
  );
  /**
   * **No early return here**, and that is the fix rather than an oversight.
   *
   * It had one, copied from the unlock drain above. The unlock path can afford
   * it: those are milliseconds of pure database work, so a tick that spends
   * itself on them has spent almost nothing. An announcement reaches an
   * outside provider, which makes it the same shape as the extraction path
   * below — and returning here meant **a single queued announcement starved
   * every later queue for that whole invocation**.
   *
   * Demonstrated rather than reasoned about: with one announce job queued, a
   * tick answered `{"claimed":1,"kind":"approval.announce"}` and left
   * `requirement.extract` untouched at `queued`, attempts 0. In CI, where the
   * scripts drive the runner directly rather than waiting for cron, that broke
   * `verify-requirement-proposal`'s concurrency section twice with the same
   * signature: two runners, neither reaching extraction, both answering with
   * no `reason` because this branch does not set one.
   *
   * The wall clock stays bounded: announcements are capped by the same batch
   * size as unlocks, and the extraction path below claims exactly one job.
   */

  // ── drain agent jobs until the budget runs out ──────────────────────────
  //
  // `AGENT_JOB_KINDS` rather than one constant. Until PR #280 the runner
  // claimed a single hard-coded kind, so twelve of the thirteen agents ADM-82
  // defined could be enabled and still receive nothing — the queue they would
  // have been fed from was never read.
  //
  // That version looped over the kinds and took the first with a queued row,
  // because `core.claim_jobs` takes one kind. **That starved every kind after
  // the first busy one.** `core.claim_agent_job` asks the queue one question
  // instead of eleven: the oldest queued row among the kinds this runner can
  // perform, under the same `for update skip locked`.
  //
  // AND UNTIL G-174 IT CLAIMED EXACTLY ONE JOB PER INVOCATION. The comment
  // that fixed that in place said "claiming more would leave rows `running`
  // that nothing in this tick will settle" — true of an unbounded loop, and
  // the reason this one is bounded twice over. Cron runs once a minute, so
  // one-per-tick meant ten queued agent jobs took ten minutes and a busy
  // morning queued more than it drained. Eight agents were not slow at their
  // work; they were waiting in line for it.
  //
  // The event-job path solved the same problem years earlier — `runEventJobs`
  // drains up to UNLOCK_BATCH with per-job error isolation — and this is that
  // shape with one addition it needs and unlocks do not: agent jobs make model
  // calls, which take seconds rather than milliseconds, so a count alone
  // cannot bound the wall clock. The budget does, and it is checked BEFORE
  // each claim so a job is never started that the tick cannot finish.
  const agentRuns: Record<string, unknown>[] = [];
  let agentClaimFailed = false;

  for (let i = 0; i < AGENT_BATCH; i += 1) {
    // Before the claim, never after: a claimed row this tick abandons is a row
    // `running` with an attempt spent, invisible until the reaper.
    if (Date.now() - tickStartedAt > AGENT_BUDGET_MS) break;

    const { data: claimedJobs, error: claimError } = await admin
      .schema('core')
      .rpc('claim_agent_job', {
        p_worker_id: `jobs-run:${correlationId}`,
        p_kinds: [...AGENT_JOB_KINDS],
      });

    if (claimError) {
      // Not "nothing queued": a claim that failed says nothing about the
      // queue, and answering `claimed: 0` would report an empty backlog on
      // exactly the blip that caused it.
      console.error(
        JSON.stringify({ level: 'error', scope: 'jobs/run', detail: `claim failed: ${claimError.message}` }),
      );
      agentClaimFailed = true;
      break;
    }

    const claimedRow: unknown = (claimedJobs ?? [])[0] ?? null;
    if (!claimedRow) break;

    const job = claimedRow as JobRow;
    claimed.job = job;

    const outcome = await runOneAgentJob(admin, job, correlationId);
    agentRuns.push(outcome);

    // Cleared once the job is settled, because `claimed.job` exists so the
    // outer catch can fail the job that threw. Left pointing at a FINISHED
    // job, a throw in the next iteration's claim would fail a row that had
    // already succeeded — a bug the one-job-per-tick shape could not have.
    claimed.job = null;
  }

  // A failed claim with nothing drained is still the 503 it always was: the
  // queue's state is unknown. A failed claim after work was done is not — that
  // work happened, and reporting it beats discarding it.
  if (agentClaimFailed && agentRuns.length === 0) {
    return NextResponse.json({ error: 'could not claim a job' }, { status: 503 });
  }

  return NextResponse.json({
    claimed: agentRuns.length,
    agentRuns,
    reaped,
    dispatched,
    followUps,
    invoiceReminders,
    campaigns,
    dueAnnouncements,
    suiteSchedules,
    semantic,
    leadRouting: leadRouting.results,
    leadIdentity: leadIdentity.results,
    unlocks: unlocks.results,
    announcements: announcements.results,
    escalations: escalations.results,
    clientWaiting: clientWaiting.results,
    phaseTwoStatesChanged: phaseTwoStates.data ?? 0,
    onboardingFollowUps,
    freeMaintenance: freeMaintenance.results,
    invoiceDeliveries: invoiceDeliveries.results,
    pmWelcomes: pmWelcomes.results,
    pmPhaseThreeAnnouncements: pmPhaseThreeAnnouncements.results,
    pmFinalAsks: pmFinalAsks.results,
    pmGstDetails: pmGstDetails.results,
    pmPaymentUpdates: pmPaymentUpdates.results,
    pmBillingReplies: pmBillingReplies.results,
    pmClarifications: pmClarifications.results,
    pmClarificationAnswers: pmClarificationAnswers.results,
    revisionLimitAnnouncements: revisionLimitAnnouncements.results,
    phaseThreeCompletedAnnouncements: phaseThreeCompletedAnnouncements.results,
    phaseFourStartedAnnouncements: phaseFourStartedAnnouncements.results,
    uiVersionAdminReviewedAnnouncements: uiVersionAdminReviewedAnnouncements.results,
    uiVersionChangeRequestedAnnouncements: uiVersionChangeRequestedAnnouncements.results,
    uiVersionLockedAnnouncements: uiVersionLockedAnnouncements.results,
    prototypeSubmittedAnnouncements: prototypeSubmittedAnnouncements.results,
    prototypeChangeRequestedAnnouncements: prototypeChangeRequestedAnnouncements.results,
    task2CompleteAnnouncements: task2CompleteAnnouncements.results,
    task3CompleteAnnouncements: task3CompleteAnnouncements.results,
    phaseFiveStartedAnnouncements: phaseFiveStartedAnnouncements.results,
    buildSharedAnnouncements: buildSharedAnnouncements.results,
    buildFeedbackAnnouncements: buildFeedbackAnnouncements.results,
    buildApprovedAnnouncements: buildApprovedAnnouncements.results,
    buildReadyForAdminAnnouncements: buildReadyForAdminAnnouncements.results,
    developmentEscalatedAnnouncements: developmentEscalatedAnnouncements.results,
    moduleCompletedAnnouncements: moduleCompletedAnnouncements.results,
    devClarificationAnnouncements: devClarificationAnnouncements.results,
    m3VerifiedAnnouncements: m3VerifiedAnnouncements.results,
    phaseSixReadyAnnouncements: phaseSixReadyAnnouncements.results,
    phaseSevenReadyAnnouncements: phaseSevenReadyAnnouncements.results,
    deploymentApprovedAnnouncements: deploymentApprovedAnnouncements.results,
    productionValidatedAnnouncements: productionValidatedAnnouncements.results,
    productionValidationFailedAnnouncements: productionValidationFailedAnnouncements.results,
    handoverReadyAnnouncements: handoverReadyAnnouncements.results,
    projectCompletedAnnouncements: projectCompletedAnnouncements.results,
    testingStartedAnnouncements: testingStartedAnnouncements.results,
    qaClarificationAnnouncements: qaClarificationAnnouncements.results,
    qaDefectProgressAnnouncements: qaDefectProgressAnnouncements.results,
    rcApprovedAnnouncements: rcApprovedAnnouncements.results,
    rcReadyAnnouncements: rcReadyAnnouncements.results,
    rcExceptionAnnouncements: rcExceptionAnnouncements.results,
    phaseEightStartedAnnouncements: phaseEightStartedAnnouncements.results,
    supportEscalatedAnnouncements: supportEscalatedAnnouncements.results,
    supportSlaBreachedAnnouncements: supportSlaBreachedAnnouncements.results,
    retentionRecoveryAnnouncements: retentionRecoveryAnnouncements.results,
    maintenanceRenewalDueAnnouncements: maintenanceRenewalDueAnnouncements.results,
    maintenanceWorkOpenedAnnouncements: maintenanceWorkOpenedAnnouncements.results,
    maintenanceQaFailedAnnouncements: maintenanceQaFailedAnnouncements.results,
    maintenanceReleaseRequestedAnnouncements: maintenanceReleaseRequestedAnnouncements.results,
    maintenanceReleaseApprovedAnnouncements: maintenanceReleaseApprovedAnnouncements.results,
    maintenanceReleasedAnnouncements: maintenanceReleasedAnnouncements.results,
    maintenanceBillingProposedAnnouncements: maintenanceBillingProposedAnnouncements.results,
    maintenanceSlaBreachedAnnouncements: maintenanceSlaBreachedAnnouncements.results,
    maintenanceWorkStalledAnnouncements: maintenanceWorkStalledAnnouncements.results,
    qaReverificationAnnouncements: qaReverificationAnnouncements.results,
    m4VerifiedAnnouncements: m4VerifiedAnnouncements.results,
    financiallyClosedAnnouncements: financiallyClosedAnnouncements.results,
    buildFeedbackRoutedAnnouncements: buildFeedbackRoutedAnnouncements.results,
    task4CompleteAnnouncements: task4CompleteAnnouncements.results,
    m2PaymentVerifiedAnnouncements: m2PaymentVerifiedAnnouncements.results,
    dispatches: dispatches.results,
    offerNotices: offerNotices.results,
    lessons: lessons.results,
    revisionLessons: revisionLessons.results,
    discountDecisionSyncs: discountDecisionSyncs.results,
    followUpDeliveries: followUpDeliveries.results,
    correlationId,
  });
}

/**
 * One agent job, start to settled — G-174.
 *
 * Extracted from the tick so the batch above can call it in a loop. Every
 * branch that used to answer the HTTP request now returns the same fact as a
 * value, because a batch cannot return early on behalf of the jobs behind it.
 */
async function runOneAgentJob(
  admin: Admin,
  job: JobRow,
  correlationId: string,
): Promise<Record<string, unknown>> {
  // ── which agent is this job for? ────────────────────────────────────────
  //
  // The job's kind decides, not a constant. A kind with no workflow is a job
  // nothing can perform; it fails loudly rather than being claimed forever by
  // a runner that has no idea what to do with it.
  const workflow = workflowFor(job.kind);

  if (!workflow) {
    await failJob(admin, job, `no agent workflow is registered for job kind "${job.kind}"`);
    return { jobId: job.id, status: 'failed', reason: 'no workflow' };
  }

  // ── agent registry: model, ceilings and kill switch are data, not code ──
  const { data: agent } = await admin
    .schema('ai')
    .from('agents')
    .select('key, enabled, default_model, default_effort, autonomy_level, allowed_work_classes')
    .eq('key', workflow.agentKey)
    .maybeSingle();

  if (!agent) {
    await failJob(admin, job, `agent "${workflow.agentKey}" is not registered`);
    return { jobId: job.id, status: 'failed', reason: 'agent missing' };
  }

  if (!agent.enabled) {
    await failJob(admin, job, `agent "${workflow.agentKey}" is disabled`);
    return { jobId: job.id, agent: workflow.agentKey, status: 'failed', reason: 'agent disabled' };
  }

  // The level AND the work. A level-only gate refused every L2 agent using an
  // argument written about one path; ADM-61 distinguishes by what the work is,
  // so the gate does too.
  const autonomy = mayAgentRun(agent.autonomy_level, workflow.workClass);
  if (!autonomy.allowed) {
    await failJob(admin, job, `agent "${workflow.agentKey}": ${autonomy.reason}`);
    return { jobId: job.id, agent: workflow.agentKey, status: 'failed', reason: 'agent autonomy' };
  }

  // SCR-063: the owner's list of work classes for this agent, beside the
  // autonomy gate. Empty is every class; a non-empty list is exhaustive.
  const allowed = agent.allowed_work_classes ?? [];
  if (allowed.length > 0 && !allowed.includes(workflow.workClass)) {
    await failJob(admin, job, `agent "${workflow.agentKey}" is not allowed ${workflow.workClass} work (allowed: ${allowed.join(', ')})`);
    return { jobId: job.id, agent: workflow.agentKey, status: 'failed', reason: 'agent work class' };
  }

  // ── and then the work, which is the only part that differs ──────────────
  //
  // Decision 3 (2026-09-29): a workflow that opens a run on a project the
  // agent is not assigned to is stopped by `openRun` throwing
  // AgentPolicyRefusal — recorded and audited there. Caught here, and the
  // job is parked rather than retried: a retry would not change the policy.
  try {
    const outcome = await workflow.run({ admin, job, agent, correlationId, workClass: workflow.workClass });
    return { jobId: job.id, agent: workflow.agentKey, ...outcome };
  } catch (error) {
    // Stream F-F: the three between-step gates, each settled its own way.
    if (error instanceof JobCancelled) {
      await settleCancelledJob(admin, error);
      return { jobId: job.id, agent: workflow.agentKey, status: 'cancelled', reason: 'cancelled while running', detail: error.reason, runId: error.runId };
    }
    if (error instanceof AgentsPaused) {
      await requeuePausedJob(admin, job, error);
      return { jobId: job.id, agent: workflow.agentKey, status: 'requeued', reason: 'agents paused', detail: error.message, runId: error.runId };
    }
    if (error instanceof AgentBudgetRefusal) {
      await parkBudgetRefusedJob(admin, job, error);
      return { jobId: job.id, agent: workflow.agentKey, status: 'failed', reason: 'provider budget', detail: error.message, runId: error.runId };
    }
    if (!(error instanceof AgentPolicyRefusal)) throw error;
    await parkRefusedJob(admin, job, error);
    return { jobId: job.id, agent: workflow.agentKey, status: 'failed', reason: 'agent policy', detail: error.message, runId: error.runId };
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}


// ═══════════════════════════════════════════════════════════════════════════
// invoice.paid → next milestone
//
// The consumer half of the revenue path. The dispatcher above has already
// turned `invoice.paid` events into `milestone.unlock` jobs; this claims them
// and hands each to the projects module's handler, which owns every decision.
// Nothing here inspects a payload or judges a milestone — the runner's job is
// claiming, settling and reporting.
// ═══════════════════════════════════════════════════════════════════════════

const UNLOCK_JOB_KIND = HANDLER_JOB_KIND['projects:unlockNextMilestone'];
const PHASE_TWO_JOB_KIND = HANDLER_JOB_KIND['projects:startPhaseTwo'];
const PHASE_THREE_JOB_KIND = HANDLER_JOB_KIND['projects:startPhaseThree'];
const PHASE_FOUR_JOB_KIND = HANDLER_JOB_KIND['projects:startPhaseFour'];
const TASK2_ROUTE_JOB_KIND = HANDLER_JOB_KIND['orchestrator:routeTask2Design'];
const DEV_PLAN_ROUTE_JOB_KIND = HANDLER_JOB_KIND['orchestrator:routeDevelopmentPlan'];
const QA_OUTCOME_ROUTE_JOB_KIND = HANDLER_JOB_KIND['orchestrator:routeQaOutcome'];
const LEAD_ROUTE_JOB_KIND = HANDLER_JOB_KIND['crm:routeLead'];
const LEAD_IDENTITY_JOB_KIND = HANDLER_JOB_KIND['crm:classifyLeadIdentity'];
const UI_VERSION_QA_JOB_KIND = HANDLER_JOB_KIND['quality_assurance:reviewUIVersion'];
const UI_VERSION_ADMIN_REVIEW_JOB_KIND = HANDLER_JOB_KIND['orchestrator:requestUIVersionAdminReview'];
const PROTOTYPE_QA_JOB_KIND = HANDLER_JOB_KIND['quality_assurance:reviewPrototypeBuild'];
const M1_INVOICE_JOB_KIND = HANDLER_JOB_KIND['finance:generateM1Invoice'];
const INVOICE_DELIVERY_JOB_KIND = HANDLER_JOB_KIND['finance:deliverIssuedInvoice'];
const FREE_MAINTENANCE_JOB_KIND = HANDLER_JOB_KIND['finance:raiseFreeMaintenance'];
const PM_WELCOME_JOB_KIND = HANDLER_JOB_KIND['projects:welcomeClient'];
const PM_PHASE3_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['projects:announcePhaseThree'];
const PM_DESIGN_FINAL_ASK_JOB_KIND = HANDLER_JOB_KIND['projects:askFinalDesignConfirmation'];
const PM_GST_DETAILS_JOB_KIND = HANDLER_JOB_KIND['projects:askGstDetails'];
const PM_PAYMENT_UPDATE_JOB_KIND = HANDLER_JOB_KIND['projects:updateClientOnPayment'];
const PM_BILLING_REPLY_JOB_KIND = HANDLER_JOB_KIND['projects:readBillingReply'];
const PM_CLARIFY_JOB_KIND = HANDLER_JOB_KIND['projects:askClarification'];
const PM_CLARIFICATION_ANSWER_JOB_KIND = HANDLER_JOB_KIND['projects:readClarificationAnswer'];
const PHASE_FOUR_COMPLETE_JOB_KIND = HANDLER_JOB_KIND['projects:completePhaseFourOnPrototypeApproval'];
const PHASE_FIVE_START_JOB_KIND = HANDLER_JOB_KIND['projects:startPhaseFive'];
const M3_VERIFIED_JOB_KIND = HANDLER_JOB_KIND['projects:recordM3Verified'];
const PHASE_SIX_START_JOB_KIND = HANDLER_JOB_KIND['projects:startPhaseSix'];
const QA_SCHEDULE_JOB_KIND = HANDLER_JOB_KIND['projects:scheduleQaJobs'];
const QA_REOPEN_JOB_KIND = HANDLER_JOB_KIND['projects:reopenOnSourceChange'];
const TESTING_STARTED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceTestingStarted'];
const QA_CLARIFICATION_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceQaClarification'];
const BUILD_READY_FOR_ADMIN_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceBuildReadyForAdmin'];
const DEVELOPMENT_ESCALATED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceDevelopmentEscalated'];
const MODULE_COMPLETED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceModuleCompleted'];
const DEV_CLARIFICATION_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceDevClarification'];
const QA_DEFECT_PROGRESS_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceQaDefectProgress'];
const M4_VERIFIED_JOB_KIND = HANDLER_JOB_KIND['projects:recordM4Verified'];
const RC_APPROVED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceReleaseCandidateApproved'];
const RC_READY_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceReleaseCandidateReady'];
const RC_EXCEPTION_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceReleaseExceptionRequested'];
const PHASE_EIGHT_STARTED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announcePhaseEightStarted'];
const SUPPORT_ESCALATED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceSupportTicketEscalated'];
const SUPPORT_SLA_BREACHED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceSupportSlaBreached'];
const RETENTION_RECOVERY_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceRetentionRecoveryRequired'];
const MAINTENANCE_RENEWAL_DUE_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceMaintenanceRenewalDue'];
const MAINTENANCE_WORK_OPENED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceMaintenanceWorkOpened'];
const MAINTENANCE_QA_FAILED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceMaintenanceQaFailed'];
const MAINTENANCE_RELEASE_REQUESTED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceMaintenanceReleaseRequested'];
const MAINTENANCE_RELEASE_APPROVED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceMaintenanceReleaseApproved'];
const MAINTENANCE_RELEASED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceMaintenanceReleased'];
const MAINTENANCE_BILLING_PROPOSED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceMaintenanceBillingProposed'];
const MAINTENANCE_SLA_BREACHED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceMaintenanceSlaBreached'];
const MAINTENANCE_WORK_STALLED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceMaintenanceWorkStalled'];
const QA_REVERIFICATION_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceQaReverification'];
const M4_VERIFIED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceM4PaymentVerified'];
const FINANCIALLY_CLOSED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceFinanciallyClosed'];
const QA_INTAKE_JOB_KIND = HANDLER_JOB_KIND['projects:validateQaIntake'];
const PHASE_SIX_READY_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announcePhaseSixReady'];
const PHASE_SEVEN_OPEN_JOB_KIND = HANDLER_JOB_KIND['projects:openPhaseSeven'];
const PHASE_SEVEN_DEPLOY_JOB_KIND = HANDLER_JOB_KIND['projects:runDeployment'];
const PHASE_SEVEN_ROUTE_JOB_KIND = HANDLER_JOB_KIND['projects:routePhaseSevenTask'];
const PHASE_EIGHT_INTAKE_JOB_KIND = HANDLER_JOB_KIND['projects:fillPhaseEightIntake'];
const SUPPORT_FROM_MESSAGE_JOB_KIND = HANDLER_JOB_KIND['projects:openSupportTicketFromMessage'];
const DRAFT_HANDOVER_JOB_KIND = HANDLER_JOB_KIND['projects:createDraftHandoverPackage'];
const PHASE_SEVEN_READY_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announcePhaseSevenReady'];
const DEPLOYMENT_APPROVED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceDeploymentApproved'];
const PRODUCTION_VALIDATED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceProductionValidated'];
const PRODUCTION_VALIDATION_FAILED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceProductionValidationFailed'];
const HANDOVER_READY_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceHandoverReady'];
const PROJECT_COMPLETED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceProjectCompleted'];
const M3_VERIFIED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceM3PaymentVerified'];
const BUILD_FEEDBACK_ROUTED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceBuildFeedbackRouted'];
const M2_INVOICE_JOB_KIND = HANDLER_JOB_KIND['finance:generateM2Invoice'];
const M3_INVOICE_JOB_KIND = HANDLER_JOB_KIND['finance:generateM3Invoice'];
const M4_INVOICE_JOB_KIND = HANDLER_JOB_KIND['finance:generateM4Invoice'];
const SCOPE_CHANGE_REQUEST_JOB_KIND = HANDLER_JOB_KIND['projects:openChangeRequestFromScopeEscalation'];
const ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceApproval'];
const ESCALATION_JOB_KIND = HANDLER_JOB_KIND['crm:announceEscalation'];
const CLIENT_WAITING_JOB_KIND = HANDLER_JOB_KIND['crm:acknowledgeHandover'];
const FOLLOWUP_JOB_KIND = HANDLER_JOB_KIND['crm:deliverFollowUp'];
const DISPATCH_JOB_KIND = HANDLER_JOB_KIND['crm:dispatchApprovedQuotation'];
const LEARN_JOB_KIND = HANDLER_JOB_KIND['sales:learnFromDecision'];
const REVISION_JOB_KIND = HANDLER_JOB_KIND['sales:learnFromRevision'];
const DISCOUNT_SYNC_JOB_KIND = HANDLER_JOB_KIND['sales:syncDiscountDecision'];
const OFFER_JOB_KIND = HANDLER_JOB_KIND['crm:announceOfferApplied'];
const REVISION_LIMIT_JOB_KIND = HANDLER_JOB_KIND['crm:announceRevisionLimitEscalated'];
const PHASE_THREE_COMPLETED_JOB_KIND = HANDLER_JOB_KIND['crm:announcePhaseThreeCompleted'];
const PHASE_FOUR_STARTED_JOB_KIND = HANDLER_JOB_KIND['crm:announcePhaseFourStarted'];
const UI_VERSION_ADMIN_REVIEWED_JOB_KIND = HANDLER_JOB_KIND['crm:announceUiVersionAdminReviewed'];
const UI_VERSION_CHANGE_REQUESTED_JOB_KIND = HANDLER_JOB_KIND['crm:announceUiVersionChangeRequested'];
const UI_VERSION_LOCKED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceUiVersionLocked'];
const PROTOTYPE_SUBMITTED_JOB_KIND = HANDLER_JOB_KIND['crm:announcePrototypeSubmitted'];
const PROTOTYPE_CHANGE_REQUESTED_JOB_KIND = HANDLER_JOB_KIND['crm:announcePrototypeChangeRequested'];
const TASK2_COMPLETE_JOB_KIND = HANDLER_JOB_KIND['crm:announceTask2Complete'];
const TASK3_COMPLETE_JOB_KIND = HANDLER_JOB_KIND['crm:announceTask3Complete'];
const PHASE_FIVE_STARTED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announcePhaseFiveStarted'];
const BUILD_SHARED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceBuildShared'];
const BUILD_FEEDBACK_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceBuildFeedbackReceived'];
const BUILD_APPROVED_ANNOUNCE_JOB_KIND = HANDLER_JOB_KIND['crm:announceBuildApproved'];
const TASK4_COMPLETE_JOB_KIND = HANDLER_JOB_KIND['crm:announceTask4Complete'];
const M2_PAYMENT_VERIFIED_JOB_KIND = HANDLER_JOB_KIND['crm:announceM2PaymentVerified'];

/**
 * How many unlocks one invocation drains.
 *
 * Bounded because a serverless function has a wall clock. Cron runs every
 * minute, so a larger backlog simply takes a few more ticks; an unbounded loop
 * would instead be killed mid-job and leave rows locked for the reaper.
 */
const UNLOCK_BATCH = 10;

/**
 * How much of one cron minute an agent batch may spend, and how many jobs it
 * may take — G-174.
 *
 * Two bounds because one is not enough. The COUNT keeps a pathological queue
 * from monopolising a tick. The BUDGET is the one that matters: agent jobs
 * make model calls, so their duration is measured in seconds and varies by an
 * order of magnitude between a classification and a full quotation. A count
 * alone would let eight slow jobs run past the serverless wall clock and be
 * killed mid-flight, leaving rows `running` with their attempts spent — the
 * exact failure the old one-job-per-tick rule was protecting against.
 *
 * 45s of a 60s cron window leaves room for the reap, dispatch, unlock and
 * announcement stages that run before this one, plus the response itself.
 * Both are deliberately conservative: a backlog simply takes another tick,
 * which is the same promise the unlock path has always made.
 */
const AGENT_BATCH = 8;
const AGENT_BUDGET_MS = 45_000;

type ClaimedUnlockJob = UnlockJob & { attempts: number; max_attempts: number };

/**
 * Drain one kind of event-driven job.
 *
 * Generic over the kind and the handler because the claim, the retry budget,
 * the backoff and the parking are identical for every one of them, and a
 * second copy of this loop is how a fix stops applying to half the queue —
 * D16, where RLS drifted wider than the code guarding it, and D18, whose
 * backoff would have had to be remembered twice.
 *
 * `scope` is the label the logs carry, so a parked job still says which queue
 * it came from.
 */
async function runEventJobs(
  admin: Admin,
  kind: string,
  handler: (admin: Admin, job: ClaimedUnlockJob) => Promise<HandlerResult>,
  scope: string,
): Promise<{ claimed: number; results: (HandlerResult & { jobId: string })[] }> {
  const results: (HandlerResult & { jobId: string })[] = [];

  for (let i = 0; i < UNLOCK_BATCH; i += 1) {
    const job = await claimUnlockJob(admin, kind);
    // Nothing available to this runner, or the claim itself failed. Both end
    // the batch; only the second is worth a line in the log, and the claim
    // already wrote it.
    if (job === 'empty' || job === 'unavailable') break;

    // A thrown client is the same fact as a returned error, and it is the one
    // most likely during exactly the blip this retry budget exists for — an
    // undici socket error or a malformed response arrives as an exception, not
    // as `{ error }` (gap G-081).
    //
    // Unguarded it cost more than one job. The throw left this row `running`
    // with its attempt already spent, invisible to every claim until the reaper
    // released it fifteen minutes on — and it propagated out of the loop, so
    // the rest of the batch never ran and the whole tick answered 500.
    let result: HandlerResult;
    try {
      result = await handler(admin, job);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          level: 'error',
          scope,
          jobId: job.id,
          detail: `handler threw: ${detail}`,
        }),
      );
      // Retryable, deliberately: a throw says nothing about whether the work
      // is possible, only that this attempt did not finish. The backoff in
      // settleUnlockJob then spaces the next one (D18).
      result = { status: 'failed', permanent: false, detail: `handler threw: ${detail}` };
    }

    await settleUnlockJob(admin, job, result, kind, scope);

    results.push({ jobId: job.id, ...result });
  }

  return { claimed: results.length, results };
}

/**
 * Claims one unlock job.
 *
 * Two steps rather than one, matching the extraction path above: select a
 * candidate, then update it with `status = 'queued'` still in the predicate.
 * That predicate is the whole lock — a second runner's update matches zero
 * rows, so the same job cannot be handled twice concurrently.
 */
async function claimUnlockJob(
  admin: Admin,
  kind: string,
): Promise<ClaimedUnlockJob | 'empty' | 'unavailable'> {
  // One statement (gap G-082). The status change, the lock and the attempt
  // increment happen together, and `attempts = attempts + 1` is evaluated
  // against the row being locked rather than against a copy read a statement
  // earlier — so two runners cannot both write "the count I saw, plus one".
  //
  // This replaced a SELECT-then-compare-and-swap that was correct only because
  // D18 remembered to restate two conditions on the write. `for update skip
  // locked` makes the same guarantee structural: a second runner steps over a
  // row somebody else is taking instead of racing it, so there is no longer a
  // `raced` outcome to distinguish — an empty result means nothing is
  // available to *this* runner, which is the same instruction either way.
  const { data, error } = await admin.schema('core').rpc('claim_jobs', {
    p_worker_id: `jobs-run:${kind}`,
    p_kind: kind,
    // One at a time. A caller must be able to settle every row it claims, and
    // an invocation killed part-way through a larger batch would strand the
    // rest in `running` with their attempts already spent.
    p_batch_size: 1,
  });

  if (error) {
    // A claim that failed is not a queue that is empty. Reporting it as empty
    // would end the batch silently on exactly the blip the retry budget exists
    // for — the D3 and D5 shape, one layer up.
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'claimUnlockJob',
        detail: error.message,
      }),
    );
    return 'unavailable';
  }

  const row = (data ?? [])[0];
  if (!row) return 'empty';

  return {
    id: row.id,
    organization_id: row.organization_id,
    payload: row.payload as ClaimedUnlockJob['payload'],
    // Already incremented by the claim, so this is the attempt now in
    // progress — the same number the old two-step reported.
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    correlation_id: row.correlation_id,
  };
}

/**
 * Says out loud that a job will never be tried again.
 *
 * Gap G-080. Nothing in this repository moves a row out of `dead`: the reaper
 * matches `status = 'running'` only, and the outbox cannot re-enqueue because
 * the job's `dedupe_key` still exists. So the moment a job is parked is the
 * last moment anyone could act on it — and until now that moment produced no
 * distinct signal at all. `last_error` was written to the row, and nothing
 * reads `core.jobs`: no page, no API, no metric.
 *
 * A permanent refusal already logged its reason from the handler. What was
 * missing is the *death* — the difference between "this attempt failed" and
 * "this will not be attempted again", which is the only one worth waking
 * somebody for.
 *
 * One line, at error level, with the fields an alert would filter on. This is
 * not monitoring: nothing ingests it and nothing pages. G-053 and ADM-21 are
 * where that lives. It is the signal being emitted so that when there is
 * something to ingest, there is something to ingest.
 */
/**
 * Records what became of a job.
 *
 * A permanent refusal — wrong organization, wrong project, an invoice that is
 * not actually paid — is parked as `dead` immediately rather than retried five
 * times, because none of those become true by waiting. The reason is written
 * to `last_error` either way, so a refused unlock is visible in the queue
 * instead of vanishing: the runner never reports success it did not achieve.
 */
async function settleUnlockJob(
  admin: Admin,
  job: ClaimedUnlockJob,
  result: HandlerResult,
  kind: string,
  scope: string,
): Promise<void> {
  if (result.status === 'succeeded') {
    /**
     * A deferred send owns its own row — G-214.
     *
     * `crm.defer_send` has already put this job back to `queued` with a far
     * `run_at`, given back the attempt it spent discovering the shut window,
     * and written the reason. Settling it `succeeded` here would erase all of
     * that and the client would never receive their quotation: the wake would
     * find a finished job and leave it alone.
     *
     * So the handler keeps the row and this returns without touching it. The
     * lock is already cleared by `defer_send`.
     */
    if (result.outcome === 'deferred') return;

    await admin
      .schema('core')
      .from('jobs')
      .update({ status: 'succeeded', locked_at: null, locked_by: null, last_error: null })
      .eq('id', job.id);
    return;
  }

  // `job.attempts` is the attempt now in progress: core.claim_jobs increments
  // it inside the statement that takes the lock (G-082).
  const settlement = settlementFor(
    { attemptsMade: job.attempts, maxAttempts: job.max_attempts },
    result.permanent,
    Date.now(),
  );

  if (settlement.status === 'dead') {
    logJobParked(job, kind, result.detail ?? 'no reason recorded');
  }

  const { error } = await admin
    .schema('core')
    .from('jobs')
    .update({
      status: settlement.status,
      last_error: result.detail,
      locked_at: null,
      locked_by: null,
      // Audit finding D18. Without this the row goes back to `queued` carrying
      // the run_at it was enqueued with — still in the past, and still the
      // oldest queued unlock, so the very next turn of the loop above claims
      // it again. Five turns, five attempts, `dead` inside one cron tick and a
      // few hundred milliseconds. A retryable failure is retryable precisely
      // because waiting might help; this is what makes waiting happen.
      ...(settlement.status === 'queued' ? { run_at: settlement.runAt } : {}),
    })
    .eq('id', job.id);

  // The one failure that leaves no trace anywhere else.
  //
  // The retryable results this settles are database read failures, so the blip
  // that failed the read is the blip most likely to fail this write a
  // millisecond later — on the same pool. When it does, the row stays
  // `running` with the attempt already spent, invisible to every claim until
  // the reaper releases it fifteen minutes on. That is recoverable, but it is
  // not the schedule above, and a silent `await` would make it look like one.
  if (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        scope: `${scope}:settle`,
        jobId: job.id,
        intended: settlement.status,
        detail: error.message,
      }),
    );
  }
}

/**
 * Writes the ai.agent_steps row for one model call and returns the number of
 * steps now recorded, so the caller can keep agent_runs.step_count honest.
 *
 * What goes in `request` is the shape of the call, not a copy of the
 * conversation: the model, effort, schema and message count, plus the system
 * prompt — which is ours and constant. The transcript itself already lives in
 * crm.conversation_messages under RLS, and duplicating customer text into the
 * ai schema would spread the same PII across two owners for no diagnostic gain.
 *
 * `response` holds what the model actually returned, *before* Zod validation.
 * That is deliberate: when validation rejects the output there is no
 * requirement_version to inspect, and this row is the only place the malformed
 * payload survives.
 *
 * A failure to write the trace is logged, never fatal. Losing an audit row is
 * bad; failing an otherwise-successful extraction because the audit row would
 * not insert is worse.
 */
/**
 * Settles a failed extraction, and records it where a human will look.
 *
 * A transient failure is not a failed *proposal*. The job is requeued, the next
 * tick may well succeed, and the reason already lives in `core.jobs.last_error`
 * and `ai.agent_runs.error` — which is what those columns are for. Writing a
 * `failed` version for every bad attempt would fill the owner's view with
 * proposals that a retry then contradicts.
 *
 * When the attempts run out that stops being true. `failed` then states a fact
 * about the conversation — this one will not produce a proposal — rather than
 * about one attempt, and it belongs in crm.requirement_versions where the owner
 * is already reading. Without it, a permanently failed extraction is invisible
 * outside the queue and looks exactly like one nobody has run.
 *
 * Idempotent on `source_job_id`: a reaped-and-retried job cannot write two.
 */
/**
 * Retries until max_attempts, then parks the job as dead.
 *
 * `job.attempts` is the attempt now in progress. Both paths claim through
 * core.claim_jobs since G-082, which increments inside the same statement that
 * takes the lock — so both hand `attemptsMade` the same number and the
 * off-by-one the two conventions used to invite is gone.
 *
 * This path never storms the way the unlock path did (D18): there is no loop
 * here — POST claims exactly one extraction job and every branch after the
 * claim returns — so a requeued row waits for the next cron tick regardless.
 * It gets the same backoff anyway, for two reasons. Two settle paths with two
 * retry policies is how policies drift. And a minute between attempts is not
 * much spacing for the failure this path actually sees — a model provider
 * erroring or rate-limiting — where five tries in five minutes can easily fall
 * entirely inside one incident.
 *
 * "One rule in one place" would overstate it: `core.reap_stalled_jobs` is a
 * third path that returns a row to `queued`, and it consults nothing here. It
 * is left alone deliberately — a stalled worker never made an attempt, so
 * there is nothing to back off from — but it does mean a queued row's `run_at`
 * cannot be read as "the retry rule put it there".
 */
