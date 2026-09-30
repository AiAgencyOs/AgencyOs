import type { Metadata } from 'next';

import { agencyClock } from '@/lib/admin/agency-clock';
import { readOwnProfile } from '@/modules/identity/profile-queries';
import { Avatar, Badge, Callout, Card, CardBody, CardHeader, DetailList, DetailRow, humanize, PageHeader } from '@/ui';

import { AvatarUploadForm, PreferencesForm, ProfileNameForm } from './profile-forms';

export const metadata: Metadata = { title: 'Profile' };

/**
 * Profile / Preferences — bucket E, decision E3 (blueprint A32).
 *
 * The person's own row and nothing else: identity (name editable, email
 * read-only because the sign-in provider owns it, avatar in the `avatars`
 * bucket), and preferences that follow the person across organisations —
 * the display timezone every date on every screen is now rendered in.
 *
 * Two things the plan sketched are not here, on purpose and said so:
 *   - "Your sessions": the auth gateway in use exposes no per-user session
 *     list to the signed-in person (supabase-js reads the current session
 *     only), so a list would be invented. Omitted.
 *   - A link to `/audit?actor=me`: the audit page filters by actor TYPE
 *     (person / agent / system), not by actor id, and it is owner/ops_admin
 *     only. A link that most people cannot open, to a filter that does not
 *     exist, is not a link. Omitted.
 */
export default async function ProfilePage() {
  const [profile, clock] = await Promise.all([readOwnProfile(), agencyClock()]);
  const displayName = profile.fullName ?? profile.email;
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="You"
        title="Profile & preferences"
        description="Your name and avatar as the panel shows them, and the preferences that follow you into every organisation you belong to."
        meta={
          <>
            <Badge tone="neutral">{humanize(profile.role)}</Badge>
            <Badge tone="info" wrap>
              Times shown in {clock.timeZone} — now {clock.dateTime(now)}
            </Badge>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader title="Identity" description="Who you are on every screen." />
          <CardBody className="flex flex-col gap-5">
            <div className="flex items-center gap-4">
              {profile.avatarSignedUrl ? (
                // A plain <img>: the source is a short-lived signed URL, which next/image would try to cache and re-sign.
                <img src={profile.avatarSignedUrl} alt="" width={64} height={64} className="h-16 w-16 rounded-full border border-line object-cover" />
              ) : (
                <Avatar name={displayName} size="lg" />
              )}
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-foreground">{displayName}</p>
                <p className="truncate text-[13px] text-muted">{profile.email}</p>
                {profile.avatarUrl && !profile.avatarSignedUrl ? (
                  <p className="mt-1 text-xs text-muted">An avatar is stored, but storage did not answer, so it cannot be shown right now.</p>
                ) : null}
              </div>
            </div>

            <DetailList>
              <DetailRow label="Email" value={<span className="text-[13px] text-foreground">{profile.email}</span>} />
              <DetailRow label="Role" value={<span className="text-[13px] text-foreground">{humanize(profile.role)}</span>} />
              <DetailRow label="User id" value={<code className="font-mono text-[12px] text-muted">{profile.userId}</code>} />
            </DetailList>
            <p className="text-xs leading-relaxed text-faint">
              The email is read-only: it is what you sign in with, and the sign-in provider owns it.
            </p>

            <ProfileNameForm fullName={profile.fullName} />

            <div className="border-t border-line pt-4">
              <AvatarUploadForm storage={profile.storage} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Preferences"
            description={
              profile.preferences.updatedAt
                ? `Last saved ${clock.dateTime(profile.preferences.updatedAt)}.`
                : 'Never saved — every value below is the default.'
            }
          />
          <CardBody className="flex flex-col gap-4">
            <Callout tone="info">
              These follow you, not the organisation: set your timezone once and every organisation you belong to shows dates in it. Each change is
              recorded in the audit trail of the organisation you are working in.
            </Callout>
            <PreferencesForm preferences={profile.preferences} organizationTimeZone={profile.organizationTimeZone} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
