import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireClient } from '@/lib/auth/session';
import { readClientProject } from '@/modules/portal/queries';
import { guardPhaseEightProject } from '@/modules/projects/phase-eight-access';
import { G1DoorForm } from '@/modules/projects/phase-eight-g1-form';
import { readPortalArticles, readPortalFeedback, readPortalPreferences } from '@/modules/projects/phase-eight-g1-queries';
import { IconArrowLeft } from '@/ui';

export const metadata: Metadata = { title: 'Tell us how we are doing' };

const CHANNELS: [string, string][] = [['whatsapp', 'WhatsApp'], ['email', 'Email'], ['portal', 'This portal'], ['call', 'Phone call'], ['meeting', 'Meeting']];

/**
 * The client's own page: tell the agency how things are going or what you want, say how you prefer to be contacted, and read the help articles the agency has
 * approved for clients. Everything shown comes from client-safe database functions that filter by the signed-in client's own account.
 */
export default async function PortalFeedbackPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requireClient();
  const { projectId } = await params;
  if (!(await guardPhaseEightProject(projectId, 'feedback'))) notFound();
  const project = await readClientProject(projectId);
  if (!project) notFound();
  const [feedback, prefs, articles] = await Promise.all([readPortalFeedback(), readPortalPreferences(), readPortalArticles()]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <Link href={`/portal/${projectId}`} className="flex w-fit items-center gap-1.5 text-[13px] text-muted hover:text-foreground">
          <IconArrowLeft size={14} />
          {project.name}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Tell us how we are doing</h1>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-[15px] font-medium">Send feedback or a goal</h2>
        <p className="text-sm text-muted">This goes to your project contact. Please never type a password or key.</p>
        <G1DoorForm
          portal
          door="feedback_submit"
          hidden={{ projectId }}
          fields={[
            { kind: 'select', name: 'kind', label: 'This is', options: [['feedback', 'Feedback'], ['goal', 'Something I want to achieve (no rating)']] },
            { kind: 'select', name: 'sentiment', label: 'How it feels (feedback only)', options: [['positive', 'Good'], ['neutral', 'Okay'], ['negative', 'Not good'], ['mixed', 'Mixed']] },
            { kind: 'number', name: 'rating', label: 'Rating 1 to 5 (optional)' },
            { kind: 'textarea', name: 'body', label: 'Your message', required: true },
          ]}
          submit="Send"
        />
        {feedback.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {feedback.map((f) => (
              <li key={f.id} className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
                <p>{f.body}</p>
                <p className="text-[12px] text-muted">{f.submittedAt.slice(0, 10)} - {f.acknowledged ? 'your project contact has read this' : 'waiting to be read'}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-[15px] font-medium">How you would like us to contact you</h2>
        <p className="text-sm text-muted">{prefs ? 'We have your preferences on record. You can change them here.' : 'We have no preference on record yet.'}</p>
        <G1DoorForm
          portal
          door="preferences_set"
          hidden={{ projectId }}
          fields={[
            { kind: 'select', name: 'preferredChannel', label: 'Preferred channel', options: [['', 'No preference'], ...CHANNELS], defaultValue: prefs?.preferredChannel ?? '' },
            { kind: 'text', name: 'language', label: 'Language code (en, hi)', defaultValue: prefs?.language ?? '' },
            { kind: 'checks', name: 'avoidChannels', label: 'Please do not contact me by', options: CHANNELS, checked: prefs?.avoidChannels },
          ]}
          submit="Save"
        />
      </section>

      {articles.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-[15px] font-medium">Help articles</h2>
          {articles.map((a) => (
            <details key={a.key} className="rounded-lg border border-line bg-surface px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium">{a.title}</summary>
              <p className="mt-2 whitespace-pre-wrap text-sm">{a.body}</p>
            </details>
          ))}
        </section>
      ) : null}
    </div>
  );
}
