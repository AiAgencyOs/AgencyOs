import type { P4uiDesignView } from '@/modules/projects/p4ui-queries';
import { Badge, Card, humanize } from '@/ui';

import { ConfirmIssueForm, DecidePostLockForm, DesignInputsForm, FigmaRefsForm, RequestPostLockForm, ResolveBlockerForm, RouteFeedbackForm } from './p4ui-forms';

/**
 * UID section 18, the Admin surfaces the single overview panel did not cover: overview with the activation reason and the next gate, the Phase 3 baseline
 * reused, the requirement trace and completeness, version lineage, Design QA defects, Figma source, the Designer's activation history (refusals included),
 * and the stops. Read-only except for the forms, each of which is one door a person walks through.
 */
export function P4uiDesignPanel({ projectId, view }: { projectId: string; view: P4uiDesignView }) {
  const { current } = view;
  const inputsCard = view.phaseFourId ? (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Design inputs{view.designInputs ? ` (revision ${view.designInputs.revision})` : ''}</h2>
      <p className="mt-1 text-sm text-muted">Brand assets, accessibility and device targets and a planning note, given to the Designer.</p>
      <div className="mt-2 max-w-xl"><DesignInputsForm projectId={projectId} phaseFourId={view.phaseFourId} current={view.designInputs} /></div>
    </Card>
  ) : null;
  if (!current) {
    return (
      <div className="flex flex-col gap-4">
        <Card className="p-4">
          <h2 className="text-sm font-semibold">UI design</h2>
          <p className="mt-2 text-sm text-muted">No UI version has been drafted for this project yet.</p>
        </Card>
        {inputsCard}
      </div>
    );
  }
  const clientChange = current.status === 'client_change' && !view.feedbackRoutes.some((r) => r.uiVersionId === current.id);
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">UI design overview</h2>
          <Badge tone={current.status === 'locked' ? 'success' : current.status.endsWith('required') || current.status.endsWith('edit') ? 'warning' : 'info'} dot>
            v{current.version} {humanize(current.status)}
          </Badge>
        </div>
        <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-muted">Activation reason: </dt><dd className="inline">{current.activationReason ? humanize(current.activationReason) : 'not recorded'}</dd></div>
          <div><dt className="inline text-muted">Owner: </dt><dd className="inline">{view.owner ?? 'unknown'}</dd></div>
          <div><dt className="inline text-muted">Next gate: </dt><dd className="inline">{current.nextGate}</dd></div>
          <div><dt className="inline text-muted">Scope version: </dt><dd className="inline">{current.scopeVersion ?? 'not recorded'}</dd></div>
        </dl>
        {view.blockers.length > 0 ? <p className="mt-2 text-sm text-danger">{view.blockers.length} open blocker(s) below.</p> : null}
      </Card>

      {inputsCard}

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Phase 3 baseline reused</h2>
        {view.baseline ? (
          <p className="mt-2 text-sm">
            The locked baseline names {view.baseline.screens} screen(s){view.baseline.lockedAt ? `, locked ${new Date(view.baseline.lockedAt).toLocaleDateString()}` : ''}. Themes, colours and tokens are inherited from it, not redrawn.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">The baseline could not be found.</p>
        )}
        <p className="mt-1 text-xs text-muted">See Design for the chosen theme, colours and the final direction.</p>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Coverage and requirements (version {current.version})</h2>
        {view.coverageGaps && (view.coverageGaps.missingScreens.length > 0 || view.coverageGaps.stateGaps.length > 0) ? (
          <p className="mt-2 text-sm">
            Missing from the baseline: {view.coverageGaps.missingScreens.join(', ') || 'no screens'}; state gaps: {view.coverageGaps.stateGaps.map((g) => `${g.screenKey} ${g.state}`).join(', ') || 'none'}.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">Every baseline screen and declared state is designed.</p>
        )}
        {view.trace ? (
          <p className="mt-1 text-sm">
            Screens with no requirement: {view.trace.orphanScreens.join(', ') || 'none'}. Included requirements with no screen: {view.trace.uncoveredRequirements.join(', ') || 'none'}.
          </p>
        ) : null}
        {view.completeness ? (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {view.completeness.map((c) => (
              <li key={c.screenKey}>
                <span className="font-medium">{c.screenKey}</span>: {c.hasSpec ? 'specified' : 'no specification yet'}
                {c.missingStates.length > 0 ? `; missing states ${c.missingStates.join(', ')}` : ''}
                {c.missingVariants.length > 0 ? `; missing platform variants ${c.missingVariants.join(', ')}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Version lineage</h2>
        <ul className="mt-2 flex flex-col gap-2 text-sm">
          {view.versions.map((v) => (
            <li key={v.id}>
              <span className="font-medium">v{v.version}</span> {humanize(v.status)}
              {v.parentVersion ? ` from v${v.parentVersion}` : ''}
              {v.activationReason ? ` (${humanize(v.activationReason)})` : ''}
              {v.changedScreens.length + v.addedScreens.length + v.removedScreens.length > 0
                ? `: changed ${v.changedScreens.join(', ') || 'none'}, added ${v.addedScreens.join(', ') || 'none'}, removed ${v.removedScreens.join(', ') || 'none'}`
                : ''}
              {v.changeSummary ? <span className="block text-muted">{v.changeSummary}</span> : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Design QA defects</h2>
        {view.defects.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No defect rows. A QA verdict that returns a version is turned into rows by the importer.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {view.defects.map((d) => (
              <li key={d.id}>
                <Badge tone={d.status === 'verified' ? 'success' : d.status === 'fix_ready' ? 'warning' : 'danger'}>{humanize(d.status)}</Badge> {d.screenKey ? `${d.screenKey}: ` : ''}{d.description}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-muted">Fix ready is the Designer&apos;s claim. Verified needs a Design QA verdict on the fix version, by someone other than its producer.</p>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Figma source</h2>
        <p className="mt-2 text-sm">
          State: {current.figmaState ? humanize(current.figmaState) : 'not recorded'}; write: {current.figmaWriteState ? humanize(current.figmaWriteState) : 'not attempted'}
          {current.figmaFileRef ? `; file ${current.figmaFileRef}` : ''}.
        </p>
        <p className="mt-1 text-xs text-muted">Figma is not written by AgencyOS from here: it needs Figma credentials this environment does not have. References are recorded by a person.</p>
        {current.status !== 'locked' ? <div className="mt-2 max-w-md"><FigmaRefsForm projectId={projectId} uiVersionId={current.id} /></div> : null}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Designer activations and refusals</h2>
        {view.jobs.length === 0 ? (
          <p className="mt-2 text-sm text-muted">The Designer has not been asked for anything yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {view.jobs.map((j) => (
              <li key={j.id}>
                <Badge tone={j.status === 'refused' ? 'neutral' : j.status === 'delivered' ? 'success' : 'info'}>{humanize(j.status)}</Badge>{' '}
                {j.status === 'refused' ? `${humanize(j.refusedTrigger ?? '')} did not activate the Designer; it goes to ${j.routeTo ?? 'its owner'}` : humanize(j.reason ?? '')}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Open blockers</h2>
        {view.blockers.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing is blocking the Designer.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3 text-sm">
            {view.blockers.map((b) => (
              <li key={b.id} className="flex flex-col gap-1">
                <span><Badge tone="danger">{humanize(b.kind)}</Badge> owner {humanize(b.owner)}{b.stopsPhase ? ' (stops the phase)' : ''}: {b.reason}</span>
                <span className="text-muted">Resumes when: {b.resumeCondition}</span>
                <div className="max-w-md"><ResolveBlockerForm projectId={projectId} blockerId={b.id} kind="design" /></div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {clientChange ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Classify the client&apos;s feedback</h2>
          <p className="mt-1 text-sm text-muted">The Designer wakes for a correction or an included revision only.</p>
          <div className="mt-2 max-w-md"><RouteFeedbackForm projectId={projectId} subjectId={current.id} kind="ui" /></div>
        </Card>
      ) : null}

      {view.feedbackRoutes.length > 0 ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">Client feedback routing</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {view.feedbackRoutes.map((r) => (
              <li key={r.id}>{humanize(r.classification.toLowerCase())} goes to {humanize(r.route)}: {r.reasoning}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Changing a locked UI</h2>
        {view.postLockRequests.map((r) => (
          <div key={r.id} className="mt-2 text-sm">
            <Badge tone={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'neutral' : 'warning'}>{humanize(r.status)}</Badge> {humanize(r.kind)}: {r.reason}
            {r.status === 'requested' ? <div className="mt-1 max-w-md"><DecidePostLockForm projectId={projectId} requestId={r.id} /></div> : null}
          </div>
        ))}
        {current.status === 'locked' ? <div className="mt-2 max-w-md"><RequestPostLockForm projectId={projectId} uiVersionId={current.id} /></div> : <p className="mt-2 text-sm text-muted">Only a locked version can have a post-lock request. The locked version is never edited.</p>}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Prototype issues against the design</h2>
        {view.prototypeIssues.length === 0 ? (
          <p className="mt-2 text-sm text-muted">None reported.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3 text-sm">
            {view.prototypeIssues.map((i) => (
              <li key={i.id}>
                <Badge tone={i.status === 'confirmed' ? 'danger' : 'neutral'}>{humanize(i.status)}</Badge> {i.screenKey ? `${i.screenKey}: ` : ''}{i.description}
                {i.status === 'reported' ? <div className="mt-1 max-w-md"><ConfirmIssueForm projectId={projectId} issueId={i.id} /></div> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
