import { cn, pillVariants } from '@codetinder/ui';
import { HeartIcon } from '@phosphor-icons/react';

/** The pill to the signup card on the landing page, from anywhere on the site. */
export const WaitlistLink = ({ className }: { readonly className?: string }) => (
  <a href="/#join" className={cn(pillVariants(), className)}>
    Join the waitlist <HeartIcon weight="fill" aria-hidden="true" />
  </a>
);
