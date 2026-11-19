import { CodeHeart } from '@codetinder/ui/react';
import type { ReactNode } from 'react';
import { siteUrl } from '../config';

export const titleClass =
  'font-display text-[clamp(2.25rem,1.5rem_+_2.5vw,3.75rem)] leading-[1.05] font-bold text-balance text-candy-red text-shadow-emboss';
export const leadClass =
  'mt-2 mb-[clamp(1.5rem,4vw,2.25rem)] max-w-[44ch] text-[1.15rem] font-semibold text-balance text-wine';

/** The projects pages' frame: the slim bar, its one action at right, and the page's column. */
export const ProjectsLayout = ({
  action,
  children,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) => (
  <div className="min-h-[100dvh] bg-page">
    <header className="flex items-center justify-between gap-4 bg-white/55 px-[clamp(1rem,3vw,2.5rem)] py-[0.85rem] shadow-[0_1px_0_rgb(164_9_44/0.08)]">
      <a
        href={siteUrl('/')}
        className="grid rounded-[0.6rem] text-lipstick"
        aria-label="CodeTinder home"
      >
        <CodeHeart className="size-10 max-sm:size-8" />
      </a>
      {action}
    </header>
    <main className="mx-auto w-[min(44rem,100%_-_2rem)] pt-[clamp(2rem,6vw,4rem)] pb-[calc(clamp(2rem,6vw,4rem)_+_env(safe-area-inset-bottom))]">
      {children}
    </main>
  </div>
);
