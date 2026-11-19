import { cn } from '../cn';
import { CodeHeart } from './CodeHeart';

/** The code-heart mark and "CodeTinder"; sized by the surrounding font-size. */
export const Wordmark = ({ className }: { readonly className?: string }) => (
  <span
    className={cn(
      'inline-flex items-center gap-[0.28em] font-display font-bold tracking-[-0.01em] whitespace-nowrap text-lipstick',
      className,
      // After the caller's classes: tailwind-merge drops a line height that a later font size follows.
      'leading-none',
    )}
  >
    <CodeHeart className="size-[1.15em] flex-none" />
    CodeTinder
  </span>
);
