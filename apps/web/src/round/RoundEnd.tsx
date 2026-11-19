import type { LearnState } from '@codetinder/api';
import { cn, pillVariants } from '@codetinder/ui';
import { CodeHeart } from '@codetinder/ui/react';
import { HeartIcon } from '@phosphor-icons/react';
import { learnLine } from './doneState';

/** The card under the round's last: what the swipes came to, and Done. */
export const RoundEnd = ({
  likedCount,
  total,
  learn,
  doneLabel,
  canFinish,
  hasHeart,
  isSending,
  onDone,
  onSwipeAgain,
}: {
  readonly likedCount: number;
  readonly total: number;
  /** Where learning the swipes stands; none until it loads. */
  readonly learn: LearnState | undefined;
  readonly doneLabel: string;
  readonly canFinish: boolean;
  readonly hasHeart: boolean;
  readonly isSending: boolean;
  readonly onDone: () => void;
  readonly onSwipeAgain: () => void;
}) => {
  const line = (() => {
    const asked = learn === undefined ? null : learnLine(learn);
    if (asked !== null) return asked;
    if (likedCount === 0) {
      return 'Picky! Press Done and CodeTinder learns what you swipe left on, too.';
    }
    return 'Press Done and CodeTinder learns your type.';
  })();
  return (
    <section
      className="grid flex-1 content-center justify-items-center gap-4 p-4 text-center text-ink cursor-default"
      aria-live="polite"
    >
      <CodeHeart className="size-[4.5em] text-lipstick" />
      <h2 className="font-display text-[2.2em] font-bold leading-[1.05] text-candy-red text-shadow-emboss">
        That's all {total}.
      </h2>
      <p className="max-w-[30ch] text-[1.05em] text-ink-soft text-balance">
        You liked {likedCount} of {total}. {line}
      </p>
      <button
        type="button"
        className={cn(pillVariants(), 'mt-2 px-[2.5em] py-[0.9em] text-[1.05em]')}
        disabled={!canFinish}
        onClick={onDone}
      >
        {doneLabel}
        {hasHeart && <HeartIcon weight="fill" aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="cursor-pointer bg-transparent px-2 py-1 text-[0.95em] font-semibold text-ink-faint underline underline-offset-[0.2em] not-disabled:hover:text-ink disabled:cursor-default disabled:opacity-60"
        disabled={isSending}
        onClick={onSwipeAgain}
      >
        Swipe again
      </button>
    </section>
  );
};
