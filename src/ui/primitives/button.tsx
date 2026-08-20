import Link from 'next/link';

import { buttonClass, type ButtonSize, type ButtonVariant } from '../tokens';

/**
 * The two things a button can be: something that acts, or something that
 * navigates. They are separate components because an `<a>` styled as a button
 * and a `<button>` that navigates are the two most common accessibility bugs
 * in an admin panel, and keeping the element honest is free.
 */

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: React.ReactNode;
};

export function Button({
  variant,
  size,
  className,
  type = 'button',
  children,
  ...rest
}: Common & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  // `type` defaults to "submit" in HTML, so a button rendered inside a form
  // submits it unless told otherwise — which is how a "cancel" or a filter
  // control ends up saving the record. Opt in to submitting instead.
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant,
  size,
  className,
  children,
  ...rest
}: Common & { href: string } & Omit<React.ComponentProps<typeof Link>, 'href' | 'className'>) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </Link>
  );
}
