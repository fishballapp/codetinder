import type { MergeRequestLinks } from '@codetinder/gitlab';
import { cn, pillVariants } from '@codetinder/ui';
import { CodeHeart, RoundProgress } from '@codetinder/ui/react';
import { ArrowSquareOutIcon, HeartIcon } from '@phosphor-icons/react';
import { siteUrl } from '../config';

/** The MR and function on one line; a link underlines on hover, the plain line does not. */
const whereClass =
  'flex min-w-0 items-center gap-[0.4em] whitespace-nowrap text-[1.05rem] font-semibold text-wine max-sm:text-[0.95rem]';

/**
 * The round's bar: home, the MR and function it is about (a link to the function in the MR's
 * changes, once GitLab has said where), how far the swiping is, and Done.
 */
export const RoundBar = ({
  mergeRequestIid,
  symbol,
  links,
  swipedCount,
  total,
  doneLabel,
  canFinish,
  hasHeart,
  onDone,
}: {
  readonly mergeRequestIid: number;
  readonly symbol: string;
  readonly links: MergeRequestLinks | undefined;
  readonly swipedCount: number;
  readonly total: number;
  readonly doneLabel: string;
  readonly canFinish: boolean;
  /** Done asks for a learn, so it wears its heart. */
  readonly hasHeart: boolean;
  readonly onDone: () => void;
}) => {
  const where = (
    <>
      {links && (
        <span className="overflow-hidden text-ellipsis max-sm:hidden">{links.projectName}</span>
      )}
      <span className="flex-none">!{mergeRequestIid}</span>
      <span aria-hidden="true" className="flex-none">
        ·
      </span>
      <code className="overflow-hidden text-ellipsis text-[0.95em] text-ink">{symbol}</code>
    </>
  );
  return (
    <header
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-[clamp(1rem,2.5vw,2rem)] gap-y-3 bg-white/55 px-[clamp(1rem,3vw,2.5rem)] py-[0.85rem] shadow-[0_1px_0_rgb(164_9_44/0.08)]',
        // Phones: home, the MR and Done on one row; the progress takes the next one, full width.
        'max-sm:grid-cols-[auto_minmax(0,1fr)_auto] max-sm:pt-[0.6rem] max-sm:pb-[0.75rem]',
      )}
    >
      <a
        href={siteUrl('/')}
        className="grid rounded-[0.6rem] text-lipstick"
        aria-label="CodeTinder home"
      >
        <CodeHeart className="size-10 max-sm:size-8" />
      </a>
      {/* The page's heading: which merge request and function this round is on. */}
      <h1 className="min-w-0">
        {links ? (
          <a
            className={cn(whereClass, 'hover:underline')}
            href={links.functionUrl}
            target="_blank"
            rel="noreferrer"
            title={`${symbol} in the merge request's changes`}
          >
            {where}
            <ArrowSquareOutIcon className="size-[1em] flex-none" aria-hidden="true" />
          </a>
        ) : (
          <span className={whereClass}>{where}</span>
        )}
      </h1>
      <div className="flex items-center gap-3 max-sm:row-start-2 max-sm:col-span-full">
        <span className="whitespace-nowrap font-semibold text-wine tabular-nums">
          {Math.min(swipedCount + 1, total)} of {total}
        </span>
        <RoundProgress
          className="w-[clamp(8rem,18vw,16rem)] max-sm:flex-1 max-sm:w-auto"
          swipedCount={swipedCount}
          total={total}
        />
      </div>
      <button
        type="button"
        className={cn(
          pillVariants({ size: 'sm' }),
          'max-sm:px-[1.1rem] max-sm:py-[0.55rem] max-sm:text-[0.95rem]',
        )}
        disabled={!canFinish}
        onClick={onDone}
      >
        {doneLabel}
        {hasHeart && <HeartIcon weight="fill" aria-hidden="true" />}
      </button>
    </header>
  );
};
