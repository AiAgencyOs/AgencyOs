import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { Executor, StageResult, BuildStage } from './build-runner';

/**
 * Builds on GitHub Actions - DevOps/Build spec. AgencyOS does not run a toolchain: it REQUESTS a workflow run on the exact commit through the
 * governed git writer (the only code that writes to GitHub, audited as git.build_triggered) and accepts the run's signed REPORT. Nothing a
 * worker says is trusted unsigned, and a report is accepted only for a build request that exists for that deliverable and commit.
 *
 * Pure: the signature and report rules are proven against fakes. What the tests cannot prove is a real workflow run: that needs the owner's
 * repository, token and workflow (see docs/phase-5-github-actions-build.md).
 */

/** HMAC-SHA256 over `${timestamp}.${rawBody}`; a stale timestamp is refused so a captured report cannot be replayed later. */
export function signBuildReport(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyBuildReport(input: {
  secret: string;
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  now: Date;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'bad_signature' } {
  if (!input.signature || !input.timestamp || !input.secret) return { ok: false, reason: 'missing' };
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'missing' };
  if (Math.abs(input.now.getTime() / 1000 - ts) > (input.toleranceSeconds ?? 300)) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(signBuildReport(input.secret, input.timestamp, input.rawBody), 'hex');
  const given = Buffer.from(input.signature.replace(/^sha256=/, ''), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

const STAGE = z.object({ name: z.enum(['source', 'env', 'install', 'lint_type', 'test', 'build', 'artifact_verify']), status: z.enum(['passed', 'failed']), duration_ms: z.number().int().min(0).optional(), transient: z.boolean().optional(), log: z.string().max(4000).optional() }).strict();

export const buildReportSchema = z
  .object({
    requestId: z.uuid(),
    deliverableId: z.uuid(),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    stages: z.array(STAGE).min(1).max(20),
    artifact: z
      .object({
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        type: z.enum(['web_bundle', 'container_image', 'apk', 'aab', 'ipa', 'archive', 'other']),
        storageRef: z.string().min(1).max(500),
        platform: z.string().max(40).optional(),
        sizeBytes: z.number().int().min(0).optional(),
        distributable: z.boolean(),
        limitation: z.string().max(300).optional(),
      })
      .strict()
      .nullable(),
    smoke: z.object({ result: z.enum(['passed', 'failed', 'blocked']), checks: z.array(z.object({ name: z.string().min(1).max(200) }).strict()).max(50), deviceTarget: z.string().max(80).optional(), reason: z.string().max(300).optional(), evidenceUrl: z.string().url().optional() }).strict().nullable(),
    fingerprint: z.record(z.string(), z.string().max(200)),
    command: z.string().max(300),
    runUrl: z.string().url(),
  })
  .strict();
export type BuildReport = z.infer<typeof buildReportSchema>;

/** The worker's own report, replayed as an Executor so the SAME runner decisions (classification, mandatory stages, no false green) apply. */
export function reportExecutor(report: BuildReport): Executor {
  const byName = new Map(report.stages.map((s) => [s.name, s] as const));
  return {
    async stage(name: BuildStage): Promise<StageResult> {
      const s = byName.get(name);
      // a stage the worker never reported did not run: that is a failure of the report, not a pass
      if (!s) return { status: 'failed', log: `the report does not include the ${name} stage` };
      return { status: s.status, transient: s.transient, log: s.log, durationMs: s.duration_ms };
    },
    async artifactSha256() { return report.artifact?.sha256 ?? null; },
    command: () => report.command,
    fingerprint: () => ({ ...report.fingerprint, run_url: report.runUrl }),
    // no smoke result in the report: the executor has no `smoke`, so the runner records NOT_TESTED with a reason, never a pass
    ...(report.smoke
      ? { smoke: async () => ({ result: report.smoke!.result, checks: report.smoke!.checks, deviceTarget: report.smoke!.deviceTarget, reason: report.smoke!.reason, evidenceUrl: report.smoke!.evidenceUrl }) }
      : {}),
    async artifactInfo() {
      const a = report.artifact;
      return a ? { type: a.type, platform: a.platform, storageRef: a.storageRef, sizeBytes: a.sizeBytes, distributable: a.distributable, limitation: a.limitation } : null;
    },
  };
}
