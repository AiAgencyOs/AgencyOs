import type { Metadata } from 'next';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listNotificationRules } from '@/lib/p13/notification-rules';
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@/ui';

import { RuleForm } from './rule-form';

export const metadata: Metadata = { title: 'Notification rules' };

/**
 * A26 Notification Rules (P1-BLUEPRINT-032): one central rule per event class and channel, so the modules cannot each invent their own quiet hours. A
 * class with no rule uses its module's default and says so. Changing a rule needs an admin and is audited; senders read it through
 * `notificationVerdict`, never from a copy.
 */
export default async function NotificationRulesPage() {
  const context = await requireInternal('/settings/notification-rules');
  const mayEdit = can(context, 'organization.settings');
  const rules = await listNotificationRules();
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Notification rules" description="Channels, frequency and quiet hours for internal and client notices. A critical notice can pass quiet hours; nothing passes an off switch." />
      <Card>
        <CardHeader title="Rules in force" description={rules.length === 0 ? 'No central rule is set: every module uses its own default.' : `${rules.length} rule${rules.length === 1 ? '' : 's'}.`} />
        <div className="flex flex-col gap-4 px-4 pb-4 sm:px-5">
          {rules.length === 0 ? <EmptyState title="No rules yet" description="Add one below." action={mayEdit ? <a href="#add-rule" className="text-sm underline">Add a rule</a> : undefined} /> : null}
          {rules.map((r) => (
            <div key={`${r.event_class}:${r.channel}`} className="flex flex-col gap-2 border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">
                  {r.event_class.replace('_', ' ')} by {r.channel.replace('_', ' ')}
                </span>
                <Badge tone={r.enabled ? 'success' : 'neutral'}>{r.enabled ? 'On' : 'Off'}</Badge>
                {r.quiet_start && r.quiet_end ? (
                  <span className="text-muted">
                    quiet {r.quiet_start.slice(0, 5)} to {r.quiet_end.slice(0, 5)} ({r.timezone})
                  </span>
                ) : null}
                {r.min_interval_seconds > 0 ? <span className="text-muted">at least {r.min_interval_seconds}s apart</span> : null}
              </div>
              {mayEdit ? (
                <details>
                  <summary className="cursor-pointer text-[13px]">Edit</summary>
                  <div className="pt-2">
                    <RuleForm
                      lockKey
                      defaults={{
                        eventClass: r.event_class,
                        channel: r.channel,
                        enabled: r.enabled,
                        minIntervalSeconds: r.min_interval_seconds,
                        quietStart: r.quiet_start?.slice(0, 5) ?? '',
                        quietEnd: r.quiet_end?.slice(0, 5) ?? '',
                        timezone: r.timezone,
                        criticalBypassesQuiet: r.critical_bypasses_quiet,
                      }}
                    />
                  </div>
                </details>
              ) : null}
            </div>
          ))}
        </div>
      </Card>
      {mayEdit ? (
        <Card id="add-rule">
          <CardHeader title="Add or replace a rule" description="Saving a rule for an event class and channel that already has one replaces it." />
          <div className="px-4 pb-4 sm:px-5">
            <RuleForm lockKey={false} defaults={{ eventClass: 'admin_alert', channel: 'in_app', enabled: true, minIntervalSeconds: 0, quietStart: '', quietEnd: '', timezone: 'Asia/Kolkata', criticalBypassesQuiet: true }} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
