import { readDeliverableDetails } from '@/modules/projects/build-details-queries';
import { readBuildConfigs, readBuildLogs, readBuildRequests, readBuildReproducibility, readBuildRuns, readClientBuildPackage } from '@/modules/projects/build-depth-queries';
import { BUILD_CONFIG_LABEL, REPRODUCIBILITY_LABEL } from '@/modules/projects/build-depth-schema';
import { listDeliverables } from '@/modules/projects/queries';
import { Badge, Card, humanize } from '@/ui';

import { BuildConfigForm, CancelBuildRequestForm, ClientPackageForm } from './build-depth-forms';

/**
 * Build pipeline depth, for staff: the versioned build configuration, each build's reproducibility and the package a client would be shown
 * (the database's own answer), the masked log of the newest run, and the build requests (an Admin can cancel an open one). Everything here
 * is READ from the records; the three writes go through their doors. Internal only: a client is never shown this panel.
 */
export async function BuildDepthPanel({ projectId, canAdmin }: { projectId: string; canAdmin: boolean }) {
  const [configs, requests, runs, deliverables, details] = await Promise.all([
    readBuildConfigs(projectId),
    readBuildRequests(projectId),
    readBuildRuns(projectId),
    listDeliverables(projectId),
    readDeliverableDetails(projectId),
  ]);
  const current = configs.find((c) => c.current) ?? null;
  const builds = deliverables.filter((d) => d.kind === 'build').slice(0, 10);
  const perBuild = await Promise.all(
    builds.map(async (b) => {
      const commit = details.get(b.id)?.commitRef ?? null;
      const newest = runs.find((r) => r.deliverableId === b.id) ?? null;
      const [repro, pkg, logs] = await Promise.all([
        commit ? readBuildReproducibility(b.id, commit) : Promise.resolve(null),
        readClientBuildPackage(b.id),
        newest ? readBuildLogs(newest.id) : Promise.resolve([]),
      ]);
      return { build: b, commit, newest, repro, pkg, logs };
    }),
  );

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <h3 className="text-sm font-semibold">Build configuration {current ? <Badge tone="info">version {current.version}</Badge> : <Badge tone="neutral">none yet</Badge>}</h3>
        <p className="mt-1 text-xs text-muted">A build recorded under an older version is stale and is not shared until it is built again. Names of variables only: never a value.</p>
        {current ? (
          <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
            {Object.entries(current.config).map(([k, v]) => (
              <div key={k}><dt className="inline font-medium">{(BUILD_CONFIG_LABEL as Record<string, string>)[k] ?? k}: </dt><dd className="inline">{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>
            ))}
          </dl>
        ) : null}
        {canAdmin ? <div className="mt-3"><BuildConfigForm projectId={projectId} current={current?.config ?? null} /></div> : <p className="mt-2 text-xs text-muted">Only an owner or ops admin changes it.</p>}
        {configs.length > 1 ? <p className="mt-2 text-xs text-muted">Earlier versions: {configs.filter((c) => !c.current).map((c) => `v${c.version}`).join(', ')}.</p> : null}
      </Card>

      <Card className="p-4">
        <h3 className="text-sm font-semibold">Build requests</h3>
        {requests.length === 0 ? <p className="mt-1 text-xs text-muted">No build has been requested.</p> : (
          <ul className="mt-2 flex flex-col gap-2">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 text-xs">
                <span><Badge tone={r.status === 'requested' ? 'info' : r.status === 'reported' ? 'success' : 'warning'}>{humanize(r.status)}</Badge> {r.environment} · {r.commit.slice(0, 12)}{r.detail ? ` · ${r.detail}` : ''}</span>
                {r.status === 'requested' && canAdmin ? <CancelBuildRequestForm projectId={projectId} requestId={r.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {perBuild.map(({ build, commit, newest, repro, pkg, logs }) => (
        <Card key={build.id} className="p-4">
          <h3 className="text-sm font-semibold">{build.title} <span className="text-muted">v{build.version}</span></h3>
          <p className="mt-1 text-xs">
            {repro ? <><Badge tone={repro === 'reproduced' ? 'success' : repro === 'differs' ? 'danger' : 'neutral'}>{humanize(repro)}</Badge> {REPRODUCIBILITY_LABEL[repro]}</> : 'Reproducibility is not known for this build yet.'}
          </p>
          {commit ? null : <p className="mt-1 text-xs text-muted">No commit is set for this build.</p>}
          {pkg ? (
            <div className="mt-2 rounded border border-border p-2 text-xs">
              <p className="font-medium">What the client sees: {pkg.label}</p>
              <p className="mt-1"><span className="font-medium">Limitations:</span> {pkg.limitations}</p>
              <p className="mt-1"><span className="font-medium">How to test:</span> {pkg.testingInstructions}</p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">No client package is ready for this build. It needs QA passed, Admin approval, the newest artifact, a shareable smoke verdict and the current configuration.</p>
          )}
          {build.status === 'draft' || build.status === 'changes_requested' || build.status === 'in_review' ? <div className="mt-2"><ClientPackageForm projectId={projectId} deliverableId={build.id} /></div> : null}
          {newest ? (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer">Newest run ({humanize(newest.status)}, attempt {newest.attempt}) - masked log, {logs.length} entr{logs.length === 1 ? 'y' : 'ies'}</summary>
              {logs.length === 0 ? <p className="mt-1 text-muted">No log was recorded for this run.</p> : (
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-muted p-2">{logs.map((l) => `[${l.stage} #${l.attempt}] ${l.text}`).join('\n')}</pre>
              )}
            </details>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
