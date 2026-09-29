import Link from 'next/link';

import { cx } from '../tokens';
import { Card, CardHeader } from './card';

export type QuickAction = {
  label: string;
  icon?: React.ReactNode;
  href?: string;
  /** A custom control — a form button — rendered in place of a link. */
  node?: React.ReactNode;
  tone?: 'default' | 'whatsapp';
};

/**
 * The two-column button grid on the right rail ("Call Now · Send Template ·
 * Create Quote …"). A link when the action is a page; a node when the action
 * is a governed write, so the page's own server-action form is the control
 * and nothing here pretends a click succeeded.
 */
export function QuickActions({ title = 'Quick actions', actions, className }: { title?: string; actions: readonly QuickAction[]; className?: string }) {
  if (actions.length === 0) return null;
  return (
    <Card className={className}>
      <CardHeader title={title} />
      <div className="grid grid-cols-2 gap-2 p-3 sm:p-4">
        {actions.map((a) => {
          const inner = (
            <>
              {a.icon ? (
                <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-md', a.tone === 'whatsapp' ? 'bg-wa-accent/15 text-wa-deep' : 'bg-brand-soft text-brand')}>
                  {a.icon}
                </span>
              ) : null}
              <span className="truncate">{a.label}</span>
            </>
          );
          const skin =
            'flex h-10 min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[13px] font-medium text-foreground shadow-xs transition-colors hover:border-line-strong hover:bg-surface-hover';
          if (a.node) {
            return (
              <div key={a.label} className="min-w-0 [&>form]:contents [&_button]:w-full">
                {a.node}
              </div>
            );
          }
          return a.href ? (
            <Link key={a.label} href={a.href} className={skin}>
              {inner}
            </Link>
          ) : (
            <span key={a.label} className={cx(skin, 'opacity-60')}>
              {inner}
            </span>
          );
        })}
      </div>
    </Card>
  );
}
