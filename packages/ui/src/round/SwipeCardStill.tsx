import { HeartIcon } from '@phosphor-icons/react';
import { cn } from '../cn';
import { CodeDiff } from './CodeDiff';
import { BEHIND_TRANSFORM, cardClass, leanTransform, stampVariants } from './SwipeDeck';

/**
 * A swipe card frozen mid-like, with the next card under it: a picture of swiping. Sized by its
 * font-size, like the deck it pictures.
 */
export const SwipeCardStill = ({
  before,
  after,
  symbols,
}: {
  readonly before: string;
  readonly after: string;
  readonly symbols: readonly string[];
}) => (
  <div className="relative h-[17em]" aria-hidden="true">
    <div
      className={cn(cardClass, 'shadow-lift cursor-default')}
      style={{ transform: BEHIND_TRANSFORM }}
    />
    <div
      className={cn(cardClass, 'shadow-lift cursor-default')}
      style={{ transform: leanTransform('like') }}
    >
      <CodeDiff before={before} after={after} symbols={symbols} layout="wrap" />
      <span className={cn(stampVariants({ verdict: 'like' }), 'opacity-100')}>
        Like <HeartIcon className="size-[0.8em]" weight="fill" />
      </span>
    </div>
  </div>
);
