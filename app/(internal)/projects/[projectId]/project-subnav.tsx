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

/**
 * The project workspace's tab row — the reference's icon-led underline strip
 * (Overview · Board · Plan · … · Settings). Before this existed,
 * `/projects/:id/design` and `/projects/:id/plan` were real, working routes
 * with no link to them anywhere in the application. The current tab is
 * decided from the URL inside `TabStrip`, so a page cannot light the wrong one.
 */
export function ProjectSubNav({ projectId }: { projectId: string }) {
  const base = `/projects/${projectId}`;
  const tabs: TabItem[] = [
    { href: base, label: 'Overview', icon: <IconOverview size={15} />, exact: true },
    { href: `${base}/board`, label: 'Board', icon: <IconGrid size={15} /> },
    { href: `${base}/plan`, label: 'Plan', icon: <IconFlag size={15} /> },
    { href: `${base}/scope`, label: 'Scope', icon: <IconTarget size={15} /> },
    { href: `${base}/design`, label: 'Design', icon: <IconPalette size={15} /> },
    { href: `${base}/prototype`, label: 'Prototype', icon: <IconSparkle size={15} /> },
    { href: `${base}/development`, label: 'Development', icon: <IconCode size={15} /> },
    { href: `${base}/repository`, label: 'Repository', icon: <IconList size={15} /> },
    { href: `${base}/builds`, label: 'Builds', icon: <IconList size={15} /> },
    { href: `${base}/qa`, label: 'QA', icon: <IconCheck size={15} /> },
    { href: `${base}/release`, label: 'Release', icon: <IconFlag size={15} /> },
    { href: `${base}/calendar`, label: 'Calendar', icon: <IconCalendar size={15} /> },
    { href: `${base}/files`, label: 'Files', icon: <IconFile size={15} /> },
    { href: `${base}/team`, label: 'Team', icon: <IconUsers size={15} /> },
    { href: `${base}/activity`, label: 'Activity', icon: <IconActivity size={15} /> },
    { href: `${base}/finance`, label: 'Finance', icon: <IconRupee size={15} /> },
    { href: `${base}/reports`, label: 'Reports', icon: <IconTrendUp size={15} /> },
    { href: `${base}/settings`, label: 'Settings', icon: <IconSettings size={15} /> },
  ];
  return <TabStrip tabs={tabs} label="Project sections" />;
}
