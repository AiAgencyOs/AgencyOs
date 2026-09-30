import {
  IconActivity,
  IconTrendUp,
  IconCalendar,
  IconCheck,
  IconCode,
  IconFile,
  IconFlag,
  IconGrid,
  IconList,
  IconMessage,
  IconOverview,
  IconRupee,
  IconPalette,
  IconSettings,
  IconSparkle,
  IconTarget,
  IconUsers,
  TabStrip,
  type TabItem,
} from '@/ui';
import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';

/**
 * The project workspace's tab row — the reference's icon-led underline strip
 * (Overview · Tasks · Milestones · Timeline · Team · Files · Activity · Settings, the rest under More). Before this existed,
 * `/projects/:id/design` and `/projects/:id/plan` were real, working routes
 * with no link to them anywhere in the application. The current tab is
 * decided from the URL inside `TabStrip`, so a page cannot light the wrong one.
 */
export async function ProjectSubNav({ projectId }: { projectId: string }) {
  const context = await requireInternal(`/projects/${projectId}`);
  // The Finance tab is offered only to a role that can open it; the page still checks for itself.
  const base = `/projects/${projectId}`;
  // The reference's primary row: Overview · Tasks · Milestones · Timeline · Team
  // · Files · Activity · Settings (its Discussion tab has no model here). Board
  // keeps its own tab beside Tasks because it is the working view. Every other
  // section stays one click away under "More", so no route is stranded.
  const tabs: TabItem[] = [
    { href: base, label: 'Overview', icon: <IconOverview size={15} />, exact: true },
    { href: `${base}/tasks`, label: 'Tasks', icon: <IconList size={15} /> },
    { href: `${base}/board`, label: 'Board', icon: <IconGrid size={15} /> },
    { href: `${base}/milestones`, label: 'Milestones', icon: <IconFlag size={15} /> },
    { href: `${base}/timeline`, label: 'Timeline', icon: <IconTrendUp size={15} /> },
    { href: `${base}/team`, label: 'Team', icon: <IconUsers size={15} /> },
    { href: `${base}/files`, label: 'Files', icon: <IconFile size={15} /> },
    { href: `${base}/communication`, label: 'Discussion', icon: <IconMessage size={15} /> },
    { href: `${base}/activity`, label: 'Activity', icon: <IconActivity size={15} /> },
    { href: `${base}/settings`, label: 'Settings', icon: <IconSettings size={15} /> },
  ];
  const moreTabs: TabItem[] = [
    { href: `${base}/plan`, label: 'Plan', icon: <IconFlag size={15} /> },
    { href: `${base}/scope`, label: 'Scope', icon: <IconTarget size={15} /> },
    { href: `${base}/requirements`, label: 'Requirements', icon: <IconList size={15} /> },
    { href: `${base}/design`, label: 'Design', icon: <IconPalette size={15} /> },
    { href: `${base}/prototype`, label: 'Prototype', icon: <IconSparkle size={15} /> },
    { href: `${base}/development`, label: 'Development', icon: <IconCode size={15} /> },
    { href: `${base}/repository`, label: 'Repository', icon: <IconList size={15} /> },
    { href: `${base}/builds`, label: 'Builds', icon: <IconList size={15} /> },
    { href: `${base}/qa`, label: 'QA', icon: <IconCheck size={15} /> },
    { href: `${base}/release`, label: 'Release', icon: <IconFlag size={15} /> },
    { href: `${base}/calendar`, label: 'Calendar', icon: <IconCalendar size={15} /> },
    ...(can(context, 'invoice.read') ? [{ href: `${base}/finance`, label: 'Finance', icon: <IconRupee size={15} /> }] : []),
    { href: `${base}/reports`, label: 'Reports', icon: <IconTrendUp size={15} /> },
  ];
  return <TabStrip tabs={tabs} moreTabs={moreTabs} label="Project sections" />;
}
