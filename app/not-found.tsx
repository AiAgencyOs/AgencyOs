import Link from 'next/link';

import { buttonClass, EmptyState, IconSearch } from '@/ui';

/**
 * The root not-found boundary: a URL that matches no route at all lands
 * here, outside the internal shell (`app/(internal)/not-found.tsx` covers
 * the `notFound()` calls inside it). It says the same two things — this
 * address names nothing, and where to go — without reading anything.
 */
export default function RootNotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4">
      <EmptyState
        icon={<IconSearch size={22} />}
        title="There is nothing at this address"
        description="The page this link names does not exist or was removed. Nothing has been changed."
        action={
          <span className="flex flex-wrap items-center justify-center gap-2">
            <Link href="/dashboard" className={buttonClass('primary', 'sm')}>
              Back to the Command Center
            </Link>
            <Link href="/search" className={buttonClass('secondary', 'sm')}>
              Search for it
            </Link>
          </span>
        }
      />
    </main>
  );
}
