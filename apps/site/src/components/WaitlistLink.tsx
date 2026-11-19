import { cn, pillVariants } from '@codetinder/ui';
import { HeartIcon } from '@phosphor-icons/react';
import type { WaitlistPlacement } from '../analytics';

/**
 * The pill to the signup card on the landing page. `placement` is where this one sits, for the
 * visits counted. On the landing page itself it stays in the document (`#join`), so the visit's
 * UTM tags stay in its URL for every event after the click; from another page it goes there.
 */
export const WaitlistLink = ({
  className,
  placement,
}: {
  readonly className?: string;
  readonly placement: WaitlistPlacement;
}) => (
  <a
    href={placement === 'not_found' ? '/#join' : '#join'}
    data-waitlist-cta={placement}
    className={cn(pillVariants(), className)}
  >
    Join the waitlist <HeartIcon weight="fill" aria-hidden="true" />
  </a>
);
