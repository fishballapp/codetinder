import { cn, pillVariants } from '@codetinder/ui';
import { CodeHeart } from '@codetinder/ui/react';
import type { ReactNode } from 'react';
import { siteUrl } from './config';

/** A page with nothing to show yet: what happened, plainly, and the way on. */
export const PageNotice = ({
  title,
  children,
  action,
  isWaiting = false,
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: { readonly label: ReactNode; readonly onClick: () => void };
  readonly isWaiting?: boolean;
}) => (
  <main className="grid min-h-dvh grid-rows-[auto_1fr] bg-page px-[clamp(1rem,3vw,2.5rem)] pt-[0.85rem] pb-[calc(2rem_+_env(safe-area-inset-bottom))]">
    <a
      href={siteUrl('/')}
      className="justify-self-start rounded-[0.6rem] text-lipstick"
      aria-label="CodeTinder home"
    >
      <CodeHeart className="size-10" />
    </a>
    <section
      className="grid w-[min(32rem,100%)] justify-items-center gap-4 self-center justify-self-center rounded-[2rem] bg-card px-[clamp(1.5rem,4vw,2.5rem)] py-[clamp(2rem,5vw,3rem)] text-center text-ink shadow-lift"
      aria-busy={isWaiting}
    >
      <CodeHeart
        className={cn(
          'size-18 text-lipstick',
          isWaiting && 'animate-beat motion-reduce:animate-none',
        )}
      />
      <h1 className="font-display text-[clamp(1.75rem,1.3rem_+_1.2vw,2.5rem)] leading-[1.1] font-bold text-balance text-candy-red text-shadow-emboss">
        {title}
      </h1>
      {children && (
        <p className="max-w-[34ch] text-[1.1rem] text-pretty text-ink-soft">{children}</p>
      )}
      {action && (
        <button
          type="button"
          className={cn(pillVariants({ size: 'md' }), 'mt-2 gap-[0.6rem]')}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </section>
  </main>
);
