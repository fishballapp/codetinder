import type { ReactNode } from 'react';
import { CodeHeart } from '../brand/CodeHeart';
import { RoundProgress } from './RoundProgress';

/**
 * The round's header as the app's bar draws it on a phone, sized by its font-size: the mark, the MR
 * and function, an action; then how far the swiping is.
 */
export const RoundHeader = ({
  mergeRequestIid,
  symbol,
  swipedCount,
  total,
  action,
}: {
  readonly mergeRequestIid: number;
  readonly symbol: string;
  readonly swipedCount: number;
  readonly total: number;
  readonly action?: ReactNode;
}) => (
  <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-[1em] gap-y-[0.75em]">
    <CodeHeart className="size-[2em] text-lipstick" />
    <p className="flex min-w-0 items-center gap-[0.4em] whitespace-nowrap font-semibold text-wine">
      <span className="flex-none">!{mergeRequestIid}</span>
      <span aria-hidden="true" className="flex-none">
        ·
      </span>
      <code className="overflow-hidden text-ellipsis text-[0.95em] text-ink">{symbol}</code>
    </p>
    {action}
    <div className="col-span-full flex items-center gap-[0.75em]">
      <span className="whitespace-nowrap font-semibold text-wine tabular-nums">
        {Math.min(swipedCount + 1, total)} of {total}
      </span>
      <RoundProgress className="flex-1" swipedCount={swipedCount} total={total} />
    </div>
  </header>
);
