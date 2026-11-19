import type { Verdict } from '@codetinder/core';
import { ArrowLeftIcon, ArrowRightIcon, HeartIcon, XIcon } from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import { cn } from '../cn';

/** A button's label, in its verdict's colour. */
const buttonVariants = cva(
  'group grid cursor-pointer justify-items-center gap-[0.35em] bg-transparent p-0 text-[1em] font-semibold disabled:cursor-default disabled:opacity-50',
  {
    variants: {
      verdict: {
        dislike: 'text-ink-soft',
        like: 'text-lipstick',
      },
    },
  },
);

/**
 * The disc, in its verdict's colours. It presses in under a hover or a press of its button; a press
 * wins over a hover, so the two never both apply.
 */
const discVariants = cva(
  [
    'grid size-[4.6em] place-items-center rounded-full',
    '[transition:transform_200ms_var(--ease-spring),box-shadow_200ms_var(--ease-out)]',
    'group-[&:not(:disabled):hover:not(:active)]:[transform:scale(1.06)] group-[&:not(:disabled):active]:[transform:scale(0.94)]',
  ],
  {
    variants: {
      verdict: {
        dislike: 'bg-card text-lipstick shadow-card',
        like: 'bg-hot-pink text-white shadow-button',
      },
    },
  },
);

const VERDICTS = {
  dislike: { label: 'Nope', key: 'ArrowLeft', KeyIcon: ArrowLeftIcon },
  like: { label: 'Like', key: 'ArrowRight', KeyIcon: ArrowRightIcon },
} as const;

const icons = {
  dislike: <XIcon className="size-[2em]" weight="bold" aria-hidden="true" />,
  like: <HeartIcon className="size-[2em]" weight="fill" aria-hidden="true" />,
};

const VerdictButton = ({
  verdict,
  onSwipe,
  disabled,
  withKey,
}: {
  readonly verdict: Verdict;
  readonly onSwipe: (verdict: Verdict) => void;
  readonly disabled: boolean;
  readonly withKey: boolean;
}) => {
  const { label, key, KeyIcon } = VERDICTS[verdict];
  // Out of the flow, so the label stays centred under its disc. Without a keyboard there is no key
  // to show.
  const keyCap = withKey && (
    <kbd
      className={cn(
        'absolute top-1/2 grid size-[1.45em] -translate-y-1/2 place-items-center rounded-[0.3em] bg-white/70 text-wine shadow-[0_2px_0_rgb(164_9_44/0.18)] [@media(hover:none)]:hidden',
        verdict === 'dislike' ? 'right-[calc(100%+0.4em)]' : 'left-[calc(100%+0.4em)]',
      )}
    >
      <KeyIcon className="size-[0.85em]" aria-hidden="true" />
    </kbd>
  );

  return (
    <button
      type="button"
      className={buttonVariants({ verdict })}
      onClick={() => onSwipe(verdict)}
      disabled={disabled}
      aria-keyshortcuts={withKey ? key : undefined}
    >
      <span className={discVariants({ verdict })}>{icons[verdict]}</span>
      {/* The key sits on the outer side: ← before Nope, → after Like. */}
      <span className="relative">
        {label}
        {keyCap}
      </span>
    </button>
  );
};

/** Nope and Like: the button equivalents of a swipe. With `withKeys`, each shows its arrow key. */
export const SwipeButtons = ({
  onSwipe,
  disabled = false,
  withKeys = false,
}: {
  readonly onSwipe: (verdict: Verdict) => void;
  readonly disabled?: boolean;
  readonly withKeys?: boolean;
}) => (
  <div className="flex justify-center gap-[2.25em]">
    <VerdictButton verdict="dislike" onSwipe={onSwipe} disabled={disabled} withKey={withKeys} />
    <VerdictButton verdict="like" onSwipe={onSwipe} disabled={disabled} withKey={withKeys} />
  </div>
);
