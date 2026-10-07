import type { P4uiPrototypeView } from '@/modules/projects/p4ui-queries';
import { Badge, Card, humanize } from '@/ui';

import { ResolveBlockerForm } from './p4ui-forms';

/**
 * PROTO section 13, the Admin surfaces: overview with the next gate, build history with from-to lineage, route coverage per screen, artifacts, known
 * limitations, Prototype QA handoff and share eligibility, revision timeline with its origin, and blockers. Read from the stored rows; a build that failed
 * or is blocked shows as such. Nothing here approves or submits a build.
 */
export function P4uiPrototypePanel({ projectId, view }: { projectId: string; view: P4uiPrototypeView }) {
  const { current } = view;
  if (!current) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-semibold">Prototype</h2>
        <p className="mt-2 text-sm text-muted">No prototype build has been planned yet. A build is planned from a locked UI version only.</p>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Prototype overview</h2>
          <Badge tone={current.status === 'failed' || current.status === 'blocked' ? 'danger' : current.status === 'locked' ? 'success' : 'info'} dot>
            build {current.buildNumber} {humanize(current.status)}
          </Badge>
        </div>
        <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-muted">Source UI: </dt><dd className="inline">{current.uiVersion ? `version ${current.uiVersion} (locked)` : 'unknown'}</dd></div>
          <div><dt className="inline text-muted">Platform: </dt><dd className="inline">{current.platform ? humanize(current.platform) : 'not named'}</dd></div>
          <div><dt className="inline text-muted">Mode: </dt><dd className="inline">{humanize(current.buildMode)}, {humanize(current.environment)}</dd></div>
          <div><dt className="inline text-muted">Next gate: </dt><dd className="inline">{current.nextGate}</dd></div>
        </dl>
        {current.failureReason ? <p className="mt-2 text-sm text-danger">Failed: {current.failureReason}</p> : null}
        {view.shareEligibility ? (
          <p className="mt-2 text-sm">
            Share eligibility: {view.shareEligibility.eligible ? 'eligible' : `not yet. ${view.shareEligibility.reasons.join('; ')}`}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted">QA handoff package: {view.hasQaHandoff ? 'assembled' : 'not assembled'}.</p>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Build history</h2>
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {view.builds.map((b) => (
            <li key={b.id}>
              <span className="font-medium">Build {b.buildNumber}</span> {humanize(b.status)}
              {b.revisionOf ? ` (follows build ${b.revisionOf})` : ''} on UI version {b.uiVersion ?? '?'}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Coverage of the exact build</h2>
        {view.coverage.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No coverage has been computed: it is computed when an artifact is attached.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {view.coverage.map((c) => (
              <li key={c.screenKey}>
                <Badge tone={c.coverage === 'covered' ? 'success' : 'danger'}>{humanize(c.coverage)}</Badge> {c.screenKey}{c.detail ? `: ${c.detail}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Known limitations</h2>
        {current.limitations.length === 0 ? (
          <p className="mt-2 text-sm text-danger">No limitations are stated. The QA handoff will not be assembled until they are.</p>
        ) : (
          <ul className="mt-2 list-disc pl-5 text-sm">
            {current.limitations.map((l) => <li key={l}>{l}</li>)}
          </ul>
        )}
        {current.simulatedIntegrations.length > 0 ? <p className="mt-2 text-sm text-muted">Simulated, not real: {current.simulatedIntegrations.join(', ')}.</p> : null}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Artifacts and test data</h2>
        {view.artifacts.length === 0 ? <p className="mt-2 text-sm text-muted">No artifact records.</p> : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {view.artifacts.map((a, i) => (
              <li key={`${a.kind}-${i}`}>
                {humanize(a.kind)}: {humanize(a.uploadStatus)}{a.sha256 ? ` (sha256 ${a.sha256.slice(0, 12)}…)` : ''}{a.failureReason ? ` – ${a.failureReason}` : ''}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-sm text-muted">Mock data sets: {view.testData.map((t) => `${t.name}${t.edgeCase ? ' (edge case)' : ''}`).join(', ') || 'none'}. Test data is mock and never holds a credential.</p>
        <p className="mt-1 text-xs text-muted">A native package (APK, iOS, desktop) needs signing and distribution accounts only the owner holds; until a person attaches one it shows as environment missing.</p>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Revision timeline</h2>
        {view.revisions.length === 0 ? <p className="mt-2 text-sm text-muted">No revision rounds yet.</p> : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {view.revisions.map((r, i) => (
              <li key={i}>Build {r.fromBuild ?? '?'} to build {r.toBuild ?? '?'} ({humanize(r.origin)}): {r.summary}</li>
            ))}
          </ul>
        )}
        {view.feedbackRoutes.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
            {view.feedbackRoutes.map((r) => <li key={r.id}>{humanize(r.classification.toLowerCase())} goes to {humanize(r.route)}: {r.reasoning}</li>)}
          </ul>
        ) : null}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Open blockers</h2>
        {view.blockers.length === 0 ? <p className="mt-2 text-sm text-muted">Nothing is blocking the prototype.</p> : (
          <ul className="mt-2 flex flex-col gap-3 text-sm">
            {view.blockers.map((b) => (
              <li key={b.id} className="flex flex-col gap-1">
                <span>
                  <Badge tone="danger">{humanize(b.kind)}</Badge> owner {humanize(b.owner)}{b.external ? ' (needs an owner-held account or credential)' : ''}{b.buildNumber ? `, build ${b.buildNumber}` : ''}: {b.reason}
                </span>
                <span className="text-muted">Resumes when: {b.resumeCondition}</span>
                <div className="max-w-md"><ResolveBlockerForm projectId={projectId} blockerId={b.id} kind="prototype" /></div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
