import { signOutAction } from '@/modules/identity/actions';

import { buttonClass, IconSignOut } from '@/ui';

/**
 * A plain form rather than an onClick handler, so signing out works without
 * JavaScript and needs no client bundle.
 */
export function SignOutButton({
  label = 'Sign out',
  full = false,
}: {
  label?: string;
  /** Fills its container — the drawer footer, where a stray-width button looks broken. */
  full?: boolean;
}) {
  return (
    <form action={signOutAction} className={full ? 'w-full' : undefined}>
      <button
        type="submit"
        className={buttonClass('secondary', 'sm', full ? 'w-full' : undefined)}
      >
        <IconSignOut size={15} />
        {label}
      </button>
    </form>
  );
}
