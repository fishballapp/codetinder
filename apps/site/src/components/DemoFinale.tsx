import type { Principle } from '@codetinder/core';
import { CodeHeart } from '@codetinder/ui/react';
import { WaitlistLink } from './WaitlistLink';

/** Where the demo round ends: what the swipes said, and what to do about it. */
export const DemoFinale = ({
  principles,
  onRestart,
}: {
  readonly principles: readonly Principle[];
  readonly onRestart: () => void;
}) => {
  const [firmest] = principles;
  return (
    // The face of the deck's last card, drawn in the phone's unit, --u, like the rest of the screen.
    <section
      className="grid flex-1 content-center justify-items-center gap-[0.9em] text-center text-ink"
      aria-live="polite"
    >
      <CodeHeart className="size-[2.6em] text-lipstick" />
      <h2 className="font-display text-[1.6em] font-bold leading-[1.1] text-candy-red">
        {firmest ? "It's a match!" : 'Hard to please?'}
      </h2>
      <p className="text-balance text-[0.85em] leading-[1.45] text-ink-soft [&_code]:font-semibold [&_code]:text-lipstick">
        {firmest ? (
          <>
            Your swipes suggest a taste for <code>{firmest.id}</code>. In CodeTinder, that taste
            becomes a principle your agents can follow.
          </>
        ) : (
          <>
            No matches this time! In CodeTinder, your swipes help your agents learn what you like.
          </>
        )}
      </p>
      <WaitlistLink className="mt-[0.4em] gap-[0.4em] px-[1.4em] py-[0.7em] text-[0.95em]" />
      <button
        type="button"
        className="cursor-pointer p-[0.2em] text-[0.85em] font-semibold text-ink-soft underline underline-offset-[0.2em]"
        onClick={onRestart}
      >
        Swipe again
      </button>
    </section>
  );
};
