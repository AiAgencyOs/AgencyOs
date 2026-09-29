'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';

import { helpHref, resolveScreen } from '@/lib/help/screens';
import { IconHelp } from '@/ui';

/**
 * The shell's "?" — bucket E, decision E3 (A34). It was a dropdown of four
 * links the rail already carries; it is now the Help link, and it resolves
 * the current route to that screen's entry in the generated inventory
 * (`/help#scr-052` on an invoice) so the answer to "what is this screen?"
 * is one click away. A route the inventory does not serve (this Help page,
 * Profile) goes to the index.
 */
export function HelpLink() {
  const pathname = usePathname();
  const screen = useMemo(() => resolveScreen(pathname), [pathname]);
  const label = screen ? `Help: ${screen.title} (${screen.id})` : 'Help';
  return (
    <Link
      href={helpHref(screen)}
      aria-label={label}
      title={label}
      className="hidden h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground md:flex"
    >
      <IconHelp size={19} />
    </Link>
  );
}
