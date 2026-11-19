import type { Verdict } from '@codetinder/core';
import { HeartIcon } from '@phosphor-icons/react';
import { cva } from 'class-variance-authority';
import {
  type PointerEvent,
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../cn';
import { wait } from '../wait';

export type SwipeDeckHandle = {
  /**
   * Swipes the top card as a drag would: it leans, shows its stamp, then leaves. Resolves once
   * `onSwipe` has run; does nothing while the card is already moving.
   */
  readonly swipe: (verdict: Verdict) => Promise<void>;
  /**
   * Leans the top card toward a verdict, stamp showing, for `lingerMs`, then settles it back
   * without swiping: a hint that the card can be swiped. Aborting `signal` settles it early.
   */
  readonly nudge: (
    verdict: Verdict,
    options: { readonly lingerMs: number; readonly signal: AbortSignal },
  ) => Promise<void>;
  /**
   * Call just before putting a swiped card back on top of `cards`: it flies back in from where
   * `verdict` sent it, a swipe in reverse. False, and nothing to put back, while the top card is
   * already moving: its swipe would land on the card coming back.
   */
  readonly bringBack: (verdict: Verdict) => boolean;
};

/** How far a drag must travel, as a share of the card's width, to count as a swipe. */
const SWIPE_DISTANCE = 0.3;
/** A quick flick counts too, in px per ms. */
const SWIPE_VELOCITY = 0.5;
/** How far a press moves before it drags the card, in px; one that moves less is a tap. */
const DRAG_SLOP = 6;

/** Where the next card waits, peeking out from under the top one. */
export const BEHIND_TRANSFORM = 'translate(-0.35em, -0.45em) rotate(-2.5deg) scale(0.98)';

const verdictDirection = (verdict: Verdict): number => (verdict === 'like' ? 1 : -1);

/** The card tipped toward a verdict, as at the start of a drag. */
export const leanTransform = (verdict: Verdict) => {
  const direction = verdictDirection(verdict);
  return `translate(${direction * 9}%, -2%) rotate(${direction * 5}deg)`;
};

/**
 * A card's face: its size, padding and code. The shadow and pointer events are the caller's, as
 * the card's place in the deck decides them. Its `:active` grab cursor is shared with the card
 * still on the landing page. Its side padding is `--card-inset`, which a diff bleeds across.
 *
 * A sideways drag anywhere on the card swipes it, so under a finger its code (a `CodeDiff`,
 * `wrap-on-touch`) wraps rather than scrolls sideways, and leaves sideways pans to the card: a
 * scroller would otherwise claim them.
 */
export const cardClass =
  'absolute inset-0 flex flex-col rounded-[1em] bg-card pt-[1.6em] px-[var(--card-inset)] pb-[1.25em] [--card-inset:1.25em] touch-pan-y select-none cursor-grab active:cursor-grabbing [&>pre]:min-h-0 [&>pre]:flex-1 [&>pre]:touch-pan-y';

/**
 * A verdict's stamp: a tilted label on the card's corner, hidden until a drag or lean shows it.
 * The like and nope stamps sit on opposite corners and tilt opposite ways.
 */
export const stampVariants = cva(
  'absolute top-[0.75em] inline-flex items-center gap-[0.25em] rounded-[0.4em] border-[0.16em] border-current bg-white/85 px-[0.45em] py-[0.1em] font-display text-[1.75em] font-bold leading-[1.2] tracking-[0.02em] uppercase opacity-0 pointer-events-none',
  {
    variants: {
      verdict: {
        like: 'right-[0.5em] text-bubblegum -rotate-12',
        dislike: 'left-[0.5em] text-lipstick rotate-12',
      },
    },
  },
);

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How far a card that can't be swiped gives under a pull of `distance`: less the further it goes. */
const rubberBand = (distance: number, limit: number) =>
  (distance * limit) / (Math.abs(distance) + limit);

const dragTransform = (dx: number, dy: number) =>
  `translate(${dx}px, ${dy * 0.25}px) rotate(${dx * 0.05}deg)`;

/** How a swiped card leaves: flying off toward its verdict, or fading out where it was let go. */
export type SwipeExit = 'fly' | 'dissolve';

/** Where a swiped card flies off to, gone: the end of its exit, and where a card brought back starts. */
const flownAway = (verdict: Verdict): Keyframe => {
  const direction = verdictDirection(verdict);
  return {
    transform: `translate(${direction * 150}%, -6%) rotate(${direction * 24}deg)`,
    opacity: 0,
  };
};

const leaveKeyframes = (card: HTMLElement, verdict: Verdict, exit: SwipeExit): Keyframe[] => {
  if (prefersReducedMotion()) return [{ opacity: 1 }, { opacity: 0 }];
  const from = card.style.transform || 'none';
  if (exit === 'dissolve') {
    return [
      { transform: from, opacity: 1 },
      { transform: `${card.style.transform} scale(0.85)`, opacity: 0 },
    ];
  }
  return [{ transform: from, opacity: 1 }, flownAway(verdict)];
};

/**
 * A deck of cards, top first: drag the top one right to like it or left to dislike it, or call the
 * handle's `swipe` (buttons, keys, the landing page's demo). `renderCard` draws a card's face, the
 * round's cards or anything else; `isTop` when it is the card on top. A card `canSwipe` turns
 * down only drags as far as a rubber band would and springs back.
 *
 * `onSwipe` runs the moment a card is let go, with where it was: the card leaves on its own (its
 * `exit`), and the next one can be grabbed at once, so quick swipes never wait on an animation.
 */
export const SwipeDeck = <Card extends { readonly id: string }>({
  cards,
  renderCard,
  canSwipe = () => true,
  exit = 'fly',
  onSwipe,
  ref,
}: {
  readonly cards: readonly Card[];
  readonly renderCard: (card: Card, isTop: boolean) => ReactNode;
  readonly canSwipe?: (card: Card) => boolean;
  readonly exit?: SwipeExit;
  readonly onSwipe: (card: Card, verdict: Verdict, place: DOMRect) => void;
  readonly ref?: Ref<SwipeDeckHandle>;
}) => {
  const [top, next] = cards;
  const isTopSwipeable = top !== undefined && canSwipe(top);
  const cardRef = useRef<HTMLElement>(null);
  const likeStampRef = useRef<HTMLSpanElement>(null);
  const nopeStampRef = useRef<HTMLSpanElement>(null);
  const isMoving = useRef(false);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    t: number;
    dx: number;
    dy: number;
    isDragging: boolean;
  } | null>(null);
  // Swiped cards still on their way out. Each keeps its element (the same key, last in the deck),
  // so its exit carries on while the card under it takes the top.
  const [leaving, setLeaving] = useState<readonly Card[]>([]);

  // A card brought back flies in the way it left; see the handle's `bringBack`.
  const returningFrom = useRef<Verdict | null>(null);

  // When a card leaves, the one under it straightens up into its place.
  const previousTopId = useRef(top?.id);
  useLayoutEffect(() => {
    const card = cardRef.current;
    const hasNewTop = previousTopId.current !== undefined && previousTopId.current !== top?.id;
    const returning = returningFrom.current;
    returningFrom.current = null;
    previousTopId.current = top?.id;
    if (!card || !hasNewTop) return;
    // A card back so soon may still be leaving: its exit, held at its end, would hide it.
    for (const animation of card.getAnimations()) animation.cancel();
    if (prefersReducedMotion()) return;
    if (returning) {
      card.animate([flownAway(returning), { transform: 'none', opacity: 1 }], {
        duration: 420,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      });
      return;
    }
    card.animate([{ transform: BEHIND_TRANSFORM }, { transform: 'none' }], {
      duration: 320,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    });
  }, [top?.id]);

  const showStamps = (lean: number) => {
    likeStampRef.current?.style.setProperty('opacity', String(Math.max(0, lean)));
    nopeStampRef.current?.style.setProperty('opacity', String(Math.max(0, -lean)));
  };

  const leave = (card: HTMLElement, swiped: Card, verdict: Verdict) => {
    const place = card.getBoundingClientRect();
    const exiting = card.animate(leaveKeyframes(card, verdict, exit), {
      duration: exit === 'dissolve' ? 260 : 420,
      easing: 'cubic-bezier(0.5, 0, 0.75, 0)',
      fill: 'forwards',
    });
    const forget = () => setLeaving(current => current.filter(gone => gone.id !== swiped.id));
    exiting.addEventListener('finish', forget);
    exiting.addEventListener('cancel', forget);
    setLeaving(current => [...current, swiped]);
    isMoving.current = false;
    onSwipe(swiped, verdict, place);
  };

  /** Springs the card back to rest, stamps hidden. */
  const settle = (card: HTMLElement) => {
    if (!prefersReducedMotion()) {
      card.animate([{ transform: card.style.transform || 'none' }, { transform: 'none' }], {
        duration: 420,
        easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      });
    }
    card.style.transform = '';
    showStamps(0);
  };

  /** Tips the card toward a verdict with its stamp showing, as the start of a drag would. */
  const lean = async (card: HTMLElement, verdict: Verdict) => {
    showStamps(verdictDirection(verdict));
    if (prefersReducedMotion()) return;
    const leaning = card.animate([{ transform: 'none' }, { transform: leanTransform(verdict) }], {
      duration: 320,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards',
    });
    await leaning.finished;
    leaning.commitStyles();
    leaning.cancel();
  };

  /**
   * Claims the card for a button, a key or the demo: never while it is dragged, and a press that
   * isn't a drag yet gives way, so the hand can't take the card mid-lean.
   */
  const claimForHandle = () => {
    if (isMoving.current || drag.current?.isDragging) return false;
    drag.current = null;
    isMoving.current = true;
    return true;
  };

  useImperativeHandle(ref, () => ({
    swipe: async verdict => {
      const card = cardRef.current;
      if (!card || !top || !isTopSwipeable || !claimForHandle()) return;
      await lean(card, verdict);
      leave(card, top, verdict);
    },
    nudge: async (verdict, { lingerMs, signal }) => {
      const card = cardRef.current;
      if (!card || !isTopSwipeable || signal.aborted || !claimForHandle()) return;
      await lean(card, verdict);
      await wait(lingerMs, signal);
      settle(card);
      isMoving.current = false;
    },
    bringBack: verdict => {
      if (isMoving.current || drag.current?.isDragging) return false;
      returningFrom.current = verdict;
      return true;
    },
  }));

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (isMoving.current || event.button !== 0) return;
    // A press in a popup the card opened (a definition, its sheet) bubbles here through React,
    // though the popup is portalled outside the card: only the card itself starts a drag.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    // Another finger can't take over a drag; the same pointer pressing again starts afresh.
    if (drag.current && drag.current.pointerId !== event.pointerId) return;
    // Not a drag yet: a press that doesn't move is a tap, which a name in the code opens on.
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      t: event.timeStamp,
      dx: 0,
      dy: 0,
      isDragging: false,
    };
  };

  /** Ends the drag as a swipe or a spring back, however the release reached the card. */
  const release = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!start.isDragging) return;
    const card = event.currentTarget;
    if (!top || !isTopSwipeable) {
      settle(card);
      return;
    }
    const velocity = Math.abs(start.dx) / Math.max(1, event.timeStamp - start.t);
    const isSwipe =
      Math.abs(start.dx) > card.offsetWidth * SWIPE_DISTANCE ||
      (velocity > SWIPE_VELOCITY && Math.abs(start.dx) > 24);
    if (isSwipe) {
      leave(card, top, start.dx > 0 ? 'like' : 'dislike');
      return;
    }
    settle(card);
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    // The button is already up: the release went somewhere the card never heard it.
    if (event.buttons === 0) {
      release(event);
      return;
    }
    start.dx = event.clientX - start.x;
    start.dy = event.clientY - start.y;
    const card = event.currentTarget;
    if (!start.isDragging) {
      if (Math.hypot(start.dx, start.dy) < DRAG_SLOP) return;
      start.isDragging = true;
      // A grab cuts short a spring back or a step up into place, so the card follows the pointer;
      // held by the card, the release can't go on to click the name it started on.
      for (const animation of card.getAnimations()) animation.cancel();
      card.setPointerCapture(event.pointerId);
    }
    if (!isTopSwipeable) {
      const limit = card.offsetWidth * 0.2;
      card.style.transform = dragTransform(
        rubberBand(start.dx, limit),
        rubberBand(start.dy, limit),
      );
      return;
    }
    card.style.transform = dragTransform(start.dx, start.dy);
    showStamps(start.dx / (card.offsetWidth * SWIPE_DISTANCE));
  };

  const stamps = (isTop: boolean) => (
    <>
      <span
        ref={isTop ? likeStampRef : undefined}
        className={stampVariants({ verdict: 'like' })}
        aria-hidden="true"
      >
        Like <HeartIcon className="size-[0.8em]" weight="fill" />
      </span>
      <span
        ref={isTop ? nopeStampRef : undefined}
        className={stampVariants({ verdict: 'dislike' })}
        aria-hidden="true"
      >
        Nope
      </span>
    </>
  );

  // One keyed list, so a card keeps its element as it goes from behind to top to leaving.
  const deck = [
    ...(next ? [{ card: next, place: 'behind' as const }] : []),
    ...(top ? [{ card: top, place: 'top' as const }] : []),
    ...leaving
      .filter(card => card.id !== top?.id && card.id !== next?.id)
      .map(card => ({ card, place: 'leaving' as const })),
  ];

  return (
    <div className="relative h-full">
      {deck.map(({ card, place }) => {
        if (place === 'behind') {
          return (
            <article
              key={card.id}
              className={cn(cardClass, 'shadow-card pointer-events-none')}
              style={{ transform: BEHIND_TRANSFORM }}
              inert
            >
              {renderCard(card, false)}
            </article>
          );
        }
        // A swiped card on its way out, over the deck; the card under it already takes the pointer.
        if (place === 'leaving') {
          return (
            <article
              key={card.id}
              className={cn(cardClass, 'shadow-lift pointer-events-none')}
              inert
            >
              {renderCard(card, false)}
              {stamps(false)}
            </article>
          );
        }
        return (
          <article
            key={card.id}
            ref={cardRef}
            className={cn(cardClass, 'shadow-lift')}
            aria-label={isTopSwipeable ? 'Card to swipe: right to like, left to nope' : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={release}
            onPointerCancel={release}
            // Only the card's own capture: taking it over from what was pressed fires one there too.
            onLostPointerCapture={event => {
              if (event.target === event.currentTarget) release(event);
            }}
          >
            {renderCard(card, true)}
            {stamps(true)}
          </article>
        );
      })}
    </div>
  );
};
