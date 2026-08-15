import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { requireInternal } from '@/lib/auth/session';
import { can } from '@/lib/authz/permissions';
import { listPortfolioItems } from '@/modules/crm/queries';
import { PORTFOLIO_KIND_LABELS, type PortfolioKind } from '@/modules/crm/schema';

import { AddPortfolioItemForm, TogglePortfolioItemForm } from './portfolio-form';

export const metadata: Metadata = { title: 'Portfolio · AgencyOS' };

/**
 * The list AgencyOS may send from — G-013 parts 1 and 2, ADM-12.
 *
 * Business rules §5.3: *"AgencyOS may send samples, demos and past work only
 * from a list the Admin maintains. The list is empty until the Admin fills it;
 * until then AgencyOS sends nothing from it."*
 *
 * This is the maintaining, and only that. **Nothing in AgencyOS sends from
 * this list yet** — selecting an item and putting it in front of a client is
 * G-013 part 3, which waits on sales-agent activation under ADM-82's layer
 * gates. The consent gate it also needs now exists at
 * `crm.send_outbound_message` (G-012); §5.3 names only AgencyOS as sender, so
 * a human-triggered send path is not buildable without a new owner decision.
 *
 * The empty state says so rather than implying the feature is working and the
 * list merely short. An empty configuration table is not a delivered feature,
 * and a screen that hides that is the defect class this repository keeps
 * finding: telling an operator something the system does not do.
 */
export default async function PortfolioPage() {
  const context = await requireInternal();
  if (!can(context.role, 'portfolio.write')) redirect('/dashboard');

  const items = await listPortfolioItems();
  const active = items.filter((item) => item.is_active).length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted">Configuration</p>
        <h1 className="text-xl font-semibold tracking-tight">Portfolio</h1>
        <p className="text-sm text-muted">
          Samples, demos and past work AgencyOS may send. Nothing is sent from this list yet —
          adding an item makes it available, not delivered.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Add an item</h2>
        <AddPortfolioItemForm />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">
          The list{items.length > 0 ? ` (${active} of ${items.length} active)` : ''}
        </h2>

        {items.length === 0 ? (
          <p className="text-sm text-muted">
            The list is empty, so AgencyOS has nothing it may send. It stays empty until you fill
            it — nothing is generated, and no example content is supplied.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-1 rounded-lg border border-black/10 p-3 dark:border-white/10"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs uppercase tracking-wide text-muted">
                      {PORTFOLIO_KIND_LABELS[item.kind as PortfolioKind] ?? item.kind}
                      {item.is_active ? '' : ' · retired'}
                    </span>
                    <span className={item.is_active ? 'text-sm' : 'text-sm text-muted line-through'}>
                      {item.title}
                    </span>
                    <span className="break-all text-xs text-muted">{item.url}</span>
                    {item.description ? (
                      <span className="text-sm text-muted">{item.description}</span>
                    ) : null}
                  </div>
                  <TogglePortfolioItemForm itemId={item.id} isActive={item.is_active} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
