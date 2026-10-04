import { LeadGenTabs } from './lead-gen-tabs';

export default function LeadGenerationLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <LeadGenTabs />
      {children}
    </div>
  );
}
