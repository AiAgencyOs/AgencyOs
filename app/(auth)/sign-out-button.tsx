import { signOutAction } from '@/modules/identity/actions';

/**
 * A plain form rather than an onClick handler, so signing out works without
 * JavaScript and needs no client bundle.
 */
export function SignOutButton({ label = 'Sign out' }: { label?: string }) {
  return (
    <form action={signOutAction}>
      <button
        type="submit"
        className="rounded-lg border border-black/15 px-3 py-1.5 text-sm transition-colors hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
      >
        {label}
      </button>
    </form>
  );
}
