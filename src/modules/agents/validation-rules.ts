import { mayContinue } from './ceilings';
import { definitionFor, mayHandOff, registryRevision } from './registry';
import { toolDefinition } from './tools';

/**
 * What "validate this agent's configuration" checks — SCR-062, and the rule
 * with no database attached.
 *
 * The cron tick (`stampAgentDefinitions`) compares one thing: the row's
 * `definition_version` against the registry revision, and stamps when they
 * disagree. `scripts/verify-agent-definitions.mjs` asks the fuller set — does
 * an enabled row have a definition, do the handoff and verifier mirrors match
 * the registry, is the roster complete — and stamps only what verified.
 *
 * A person pressing "Validate now" gets the fuller set, answered by the same
 * pure functions the runtime decides with (`definitionFor`, `mayHandOff`,
 * `toolDefinition`, `mayContinue`, `registryRevision`), so a finding here is
 * the same fact the runner would act on rather than a second reading of the
 * rules. Nothing is corrected: `ai.agents` is global and not tenant-writable
 * (20260815380000), and a validation that found problems is a record beside
 * the row, not a stamp on it.
 */

export type LiveAgent = {
  readonly key: string;
  readonly enabled: boolean;
  readonly defaultModel: string | null;
  readonly maxSteps: number | null;
  readonly maxCostMinor: number | null;
  readonly definitionVersion: string | null;
};

export type LiveMirrors = {
  /** `ai.agent_handoff_targets.to_agent` where from_agent = this agent. */
  readonly handoffTargets: readonly string[];
  /** `ai.agent_verifiers.verifier` where producer = this agent. */
  readonly verifiers: readonly string[];
};

export type Finding = {
  readonly check:
    | 'definition'
    | 'revision'
    | 'model'
    | 'ceilings'
    | 'tools'
    | 'handoffs'
    | 'verifier'
    | 'self_verification';
  readonly ok: boolean;
  readonly detail: string;
};

export type Validation = {
  readonly outcome: 'ok' | 'problems';
  readonly revision: string;
  readonly findings: readonly Finding[];
};

export function validateAgent(row: LiveAgent, mirrors: LiveMirrors): Validation {
  const revision = registryRevision();
  const findings: Finding[] = [];
  const definition = definitionFor(row.key);

  if (!definition) {
    // The rule G-125 established: an enabled row with no definition cannot
    // run. A disabled one may lack a definition — ADM-82 folded
    // lead_qualifier and proposal_drafter into sales and kept the rows.
    findings.push({
      check: 'definition',
      ok: !row.enabled,
      detail: row.enabled
        ? 'enabled in the database and absent from the registry — nothing can run it'
        : 'no definition in the registry; a preserved row (ADM-82), disabled, and nothing to validate against',
    });
    return { outcome: row.enabled ? 'problems' : 'ok', revision, findings };
  }

  findings.push({ check: 'definition', ok: true, detail: `defined as ${definition.displayName} (${definition.layer})` });

  findings.push({
    check: 'revision',
    ok: row.definitionVersion === revision,
    detail:
      row.definitionVersion === null
        ? `never stamped; the registry is at ${revision}`
        : row.definitionVersion === revision
          ? `stamped against the current registry revision ${revision}`
          : `stamped against ${row.definitionVersion}; the registry is at ${revision} — the tick will restamp, and the row should be re-read against the new definition`,
  });

  const model = row.defaultModel?.trim() ?? '';
  findings.push({
    check: 'model',
    ok: model.length > 0 || !row.enabled,
    detail: model ? `default model ${model}` : row.enabled ? 'enabled with no default model — every run would fail to resolve a provider' : 'no default model; disabled',
  });

  if (row.maxSteps === null || row.maxCostMinor === null) {
    findings.push({ check: 'ceilings', ok: false, detail: 'a ceiling is missing — the runtime cannot bound this agent' });
  } else {
    const gate = mayContinue({ steps: 0, costMinor: 0 }, { maxSteps: row.maxSteps, maxCostMinor: row.maxCostMinor });
    findings.push({
      check: 'ceilings',
      ok: gate.ok,
      detail: gate.ok ? `at most ${row.maxSteps} steps and ${row.maxCostMinor} minor units per run` : gate.error.message,
    });
  }

  const unknownTools = definition.tools.filter((name) => toolDefinition(name) === null);
  findings.push({
    check: 'tools',
    ok: unknownTools.length === 0,
    detail:
      unknownTools.length === 0
        ? definition.tools.length === 0
          ? 'binds no tools'
          : `every bound tool is implemented (${definition.tools.length})`
        : `bound to tools nothing implements: ${unknownTools.join(', ')}`,
  });

  const declaredTargets = definition.handoffTargets;
  const missingTargets = declaredTargets.filter((t) => !mirrors.handoffTargets.includes(t));
  const extraTargets = mirrors.handoffTargets.filter((t) => !mayHandOff(row.key, t));
  findings.push({
    check: 'handoffs',
    ok: missingTargets.length === 0 && extraTargets.length === 0,
    detail:
      missingTargets.length === 0 && extraTargets.length === 0
        ? declaredTargets.length === 0
          ? 'hands work to nobody, as declared'
          : `the live handoff mirror matches the registry (${declaredTargets.join(', ')})`
        : [
            missingTargets.length ? `declared but not in the live mirror: ${missingTargets.join(', ')}` : '',
            extraTargets.length ? `in the live mirror but not declared: ${extraTargets.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
  });

  const declaredVerifier = definition.verification.verifiedBy;
  const expected = declaredVerifier ? [declaredVerifier] : [];
  const verifierMatches =
    expected.length === mirrors.verifiers.length && expected.every((v) => mirrors.verifiers.includes(v));
  findings.push({
    check: 'verifier',
    ok: verifierMatches,
    detail: verifierMatches
      ? declaredVerifier
        ? `verified by ${declaredVerifier}, and the live mirror agrees`
        : 'nothing verifies this agent, as declared (ADM-83: nothing verifies the verifier)'
      : `declared ${declaredVerifier ?? 'no verifier'}; the live mirror says ${mirrors.verifiers.join(', ') || 'none'}`,
  });

  const verifier = declaredVerifier ? definitionFor(declaredVerifier) : null;
  const selfOk = declaredVerifier !== row.key && (declaredVerifier === null || verifier?.mayVerify === true);
  findings.push({
    check: 'self_verification',
    ok: selfOk,
    detail: selfOk
      ? 'never declares its own work complete'
      : declaredVerifier === row.key
        ? 'declares itself as its own verifier — forbidden by ADM-82'
        : `declares ${declaredVerifier} as verifier, which may not verify`,
  });

  return { outcome: findings.every((f) => f.ok) ? 'ok' : 'problems', revision, findings };
}
