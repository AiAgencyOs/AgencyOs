import { agencyClock } from '@/lib/admin/agency-clock';
import { P789DoorForm } from '@/modules/projects/p789-round2-form';
import { readCertificateDocument, readMajorReleases, readPendingReminders } from '@/modules/projects/p789-round2-queries';
import { Badge, Card, CardHeader, humanize } from '@/ui';

/**
 * Round-two records for ONE project: the completion certificate document (render once, download), the client-action reminders waiting for a person, and the
 * major releases on record. Server component; mount it with `<P789RoundTwoPanel projectId={projectId} />`. Every figure is a stored fact; the reminders are derived
 * (a request that is no longer open drops out). Nothing here sends a message to the client. Not rendered in a browser by the builder.
 */
export async function P789RoundTwoPanel({ projectId }: { projectId: string }) {
  const clock = await agencyClock();
  const [certificate, reminders, releases] = await Promise.all([readCertificateDocument(projectId), readPendingReminders(projectId), readMajorReleases(projectId)]);
  return (
    <Card>
      <CardHeader title="Certificate, reminders and releases" description="Round-two records. The certificate is not signed; a reminder is sent by a person; a release is recorded by a person." />
      <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
        <section className="flex flex-col gap-2 text-[13px]">
          <h3 className="font-medium">Completion certificate</h3>
          {certificate ? (
            <p>
              {certificate.number}, rendered {clock.date(certificate.renderedAt)}.{' '}
              <a className="underline" href={`/api/p789/certificate/${projectId}`}>Download</a>
              {certificate.intact ? '' : ' (the stored checksum does not match the body: do not rely on it)'}
            </p>
          ) : (
            <P789DoorForm door="certificate_render" hidden={{ projectId }} intro="Available once the project has completed. It is built once, from the completion record, and never edited." submit="Render the certificate" />
          )}
        </section>

        <section className="flex flex-col gap-2 text-[13px]">
          <h3 className="font-medium">Client action reminders</h3>
          <P789DoorForm door="reminder_sweep" hidden={{ projectId }} intro="Looks at open client action requests due within three days, or overdue, and queues a reminder for each. Sends nothing." submit="Check for reminders" />
          {reminders.length === 0 ? <p className="text-muted">No reminder is waiting.</p> : null}
          {reminders.map((r) => (
            <div key={r.reminderId} className="flex flex-col gap-2 rounded-md border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={r.kind === 'overdue' ? 'danger' : 'warning'}>{humanize(r.kind)}</Badge>
                <span>{r.title}</span>
                <span className="text-muted">due {clock.date(r.dueAt)}</span>
              </div>
              <P789DoorForm
                door="reminder_sent"
                hidden={{ reminderId: r.reminderId, projectId }}
                intro="After you have reminded the client yourself, record how."
                fields={[{ kind: 'select', name: 'channel', label: 'Channel', options: [['call', 'Call'], ['whatsapp', 'WhatsApp'], ['email', 'E-mail'], ['portal', 'Portal'], ['meeting', 'Meeting']] }, { kind: 'text', name: 'note', label: 'What you told them', required: true }]}
                submit="Record that I reminded them"
              />
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-2 text-[13px]">
          <h3 className="font-medium">Major releases</h3>
          {releases.length === 0 ? <p className="text-muted">None recorded.</p> : null}
          {releases.map((m) => (
            <p key={m.id}>{m.versionLabel}, {clock.date(m.releasedOn)}: {m.summary} <span className="text-muted">({m.releaseRef})</span></p>
          ))}
          <P789DoorForm
            door="major_release"
            hidden={{ projectId }}
            intro="Record a major release of the delivered product. It raises a major-release check-in for Customer Success."
            fields={[{ kind: 'text', name: 'versionLabel', label: 'Version', required: true }, { kind: 'date', name: 'releasedOn', label: 'Released on', required: true }, { kind: 'text', name: 'releaseRef', label: 'Where the release notes live', required: true }, { kind: 'textarea', name: 'summary', label: 'What changed', required: true }]}
            submit="Record the release"
          />
        </section>
      </div>
    </Card>
  );
}
