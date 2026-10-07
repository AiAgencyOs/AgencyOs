import { G1DoorForm } from '@/modules/projects/phase-eight-g1-form';
import { readEligibilityWithPreferences, readRelationship } from '@/modules/projects/phase-eight-g1-queries';
import { Badge, Card, CardHeader, humanize } from '@/ui';

const CHANNELS: [string, string][] = [['whatsapp', 'WhatsApp'], ['email', 'Email'], ['portal', 'Portal'], ['call', 'Call'], ['meeting', 'Meeting']];
const PURPOSES: [string, string][] = [['operational', 'Operational'], ['relationship', 'Relationship'], ['commercial', 'Commercial']];

/**
 * The relationship records of one client: feedback and goals, the strategic/VIP designation (an Admin decision under a stated rule), contact preferences, the
 * Admin-set cadence, and the eligibility answer that includes them. Self-contained: pass the client id. Nothing here sends anything, and nothing here changes health.
 */
export async function RelationshipPanel({ clientId }: { clientId: string }) {
  const [rel, eligibility] = await Promise.all([readRelationship(clientId), readEligibilityWithPreferences(clientId, 'call', 'relationship')]);
  const live = rel.designations.filter((d) => d.active);
  return (
    <>
      <Card>
        <CardHeader title="Strategic / VIP" description="Decided by an Admin under a stated rule. An agent cannot decide it, and it changes no health, priority or price." />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {rel.designations.length === 0 ? <p className="text-[13px] text-muted">Not designated.</p> : null}
          {rel.designations.map((d) => (
            <div key={d.id} className="flex flex-col gap-1 text-[13px]">
              <span>
                <Badge tone={d.active ? 'info' : 'neutral'}>{d.designation.toUpperCase()}</Badge> {d.active ? 'active' : `ended: ${d.endedReason ?? ''}`} - rule: {d.criteria} - reason: {d.reason}
              </span>
              {d.active ? (
                <G1DoorForm door="designation_end" hidden={{ clientId, designation: d.designation }} fields={[{ kind: 'text', name: 'reason', label: 'Why end it', required: true }]} submit="End designation (Admin)" />
              ) : null}
            </div>
          ))}
          {live.length < 2 ? (
            <G1DoorForm
              door="designation_set"
              hidden={{ clientId }}
              intro="Admin only. State the rule you decided it under and why."
              fields={[
                { kind: 'select', name: 'designation', label: 'Designation', options: [['strategic', 'Strategic'], ['vip', 'VIP']] },
                { kind: 'text', name: 'criteria', label: 'The rule it was decided under', required: true },
                { kind: 'text', name: 'reason', label: 'Why this client', required: true },
              ]}
              submit="Designate (Admin)"
            />
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="What the client has said" description="Feedback and goals, recorded by a person or submitted by the client. Nothing is inferred; a negative entry stays a next action until someone acknowledges it." />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {rel.feedback.length === 0 ? <p className="text-[13px] text-muted">Nothing recorded yet.</p> : null}
          {rel.feedback.map((f) => (
            <div key={f.id} className="flex flex-col gap-1 text-[13px]">
              <span>
                <Badge tone={f.sentiment === 'negative' ? 'danger' : f.sentiment === 'positive' ? 'success' : 'neutral'}>{humanize(f.kind === 'goal' ? 'goal' : (f.sentiment ?? 'feedback'))}</Badge> {f.occurredOn} via {humanize(f.source)}
                {f.rating ? ` - ${f.rating}/5` : ''} {f.acknowledged ? ' - acknowledged' : ''}
              </span>
              <span>{f.body}</span>
              {!f.acknowledged ? (
                <G1DoorForm door="feedback_ack" hidden={{ clientId, feedbackId: f.id }} fields={[{ kind: 'text', name: 'note', label: 'What you did about it', required: true }]} submit="Acknowledge" />
              ) : null}
            </div>
          ))}
          <G1DoorForm
            door="feedback_record"
            hidden={{ clientId }}
            intro="Record what the client told you."
            fields={[
              { kind: 'select', name: 'kind', label: 'Kind', options: [['feedback', 'Feedback'], ['goal', 'A goal (no score)']] },
              { kind: 'select', name: 'source', label: 'Source', options: [['call', 'Call'], ['meeting', 'Meeting'], ['email', 'Email'], ['whatsapp', 'WhatsApp'], ['survey', 'Survey'], ['other', 'Other']] },
              { kind: 'select', name: 'sentiment', label: 'How it felt (feedback only)', options: [['positive', 'Positive'], ['neutral', 'Neutral'], ['negative', 'Negative'], ['mixed', 'Mixed']] },
              { kind: 'number', name: 'rating', label: 'Rating 1 to 5 (optional)' },
              { kind: 'textarea', name: 'body', label: 'What was said (no passwords)', required: true },
            ]}
            submit="Record"
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="How to contact them" description="Preferences, the Admin-set cadence, and whether a call would be allowed now. Nothing here sends." />
        <div className="flex flex-col gap-3 px-4 pb-4 sm:px-5">
          {eligibility ? (
            <p className="text-[13px]">
              A relationship call now: <Badge tone={eligibility.allowed ? 'success' : 'danger'}>{eligibility.allowed ? 'allowed' : 'not now'}</Badge> {eligibility.reasons.join('; ')}{' '}
              {eligibility.advisories.length > 0 ? `(advice: ${eligibility.advisories.join('; ')})` : ''}
            </p>
          ) : null}
          <p className="text-[13px] text-muted">
            {rel.preferences
              ? `Prefers ${rel.preferences.preferredChannel ? humanize(rel.preferences.preferredChannel) : 'no particular channel'}, language ${rel.preferences.language ?? 'not recorded'}, avoids ${rel.preferences.avoidChannels.length ? rel.preferences.avoidChannels.join(', ') : 'nothing'} (${humanize(rel.preferences.source)}).`
              : 'No preference recorded.'}
          </p>
          <G1DoorForm
            door="preferences_set"
            hidden={{ clientId }}
            fields={[
              { kind: 'select', name: 'preferredChannel', label: 'Preferred channel', options: [['', 'No preference'], ...CHANNELS] },
              { kind: 'text', name: 'language', label: 'Language code (en, hi)' },
              { kind: 'checks', name: 'avoidChannels', label: 'Never contact by', options: CHANNELS, checked: rel.preferences?.avoidChannels },
              { kind: 'text', name: 'note', label: 'Note' },
            ]}
            submit="Save preferences"
          />
          <p className="text-[13px] text-muted">
            Cadence (Admin-set, none by default):{' '}
            {rel.cadence.filter((c) => c.active).length === 0 ? 'none' : rel.cadence.filter((c) => c.active).map((c) => `${c.purpose}${c.channel ? ` on ${c.channel}` : ''}: ${c.minGapDays} days`).join('; ')}
          </p>
          <G1DoorForm
            door="cadence_set"
            hidden={{ clientId }}
            intro="Admin only. The minimum days between two person-sent contacts of one purpose."
            fields={[
              { kind: 'select', name: 'purpose', label: 'Purpose', options: PURPOSES },
              { kind: 'select', name: 'channel', label: 'Channel', options: [['all', 'Any channel'], ...CHANNELS] },
              { kind: 'number', name: 'minGapDays', label: 'Minimum gap in days', required: true },
            ]}
            submit="Set cadence (Admin)"
          />
        </div>
      </Card>
    </>
  );
}
