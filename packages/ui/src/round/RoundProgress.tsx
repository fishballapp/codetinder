import { Progress } from '@base-ui/react/progress';

const segmentState = (index: number, swipedCount: number) => {
  if (index < swipedCount) return 'done';
  if (index === swipedCount) return 'current';
  return 'next';
};

/** How far through the round's cards the swiping is: one segment per card. */
export const RoundProgress = ({
  swipedCount,
  total,
  className,
}: {
  readonly swipedCount: number;
  readonly total: number;
  readonly className?: string;
}) => (
  <Progress.Root
    className={className}
    value={swipedCount}
    max={total}
    aria-label="Cards swiped"
    getAriaValueText={() => `${swipedCount} of ${total} swiped`}
  >
    <Progress.Track className="flex h-[0.5em] gap-[0.2em]">
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className="flex-1 rounded-pill bg-rule [transition:background-color_300ms_var(--ease-out)] data-[state=current]:bg-petal data-[state=done]:bg-lipstick"
          data-state={segmentState(index, swipedCount)}
        />
      ))}
    </Progress.Track>
  </Progress.Root>
);
