import type { Card, Principle, Verdict } from '@codetinder/core';
import { cn, pillVariants, wait } from '@codetinder/ui';
import phoneBezel from '@codetinder/ui/plates/phone-bezel.webp';
import {
  CodeDiff,
  RoundHeader,
  SwipeButtons,
  SwipeDeck,
  type SwipeDeckHandle,
} from '@codetinder/ui/react';
import {
  BatteryFullIcon,
  CellSignalFullIcon,
  HeartIcon,
  WifiHighIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { DemoFinale } from './DemoFinale';
import { DEMO_ROUND } from './demoRound';

/** The rest between sways, and how long each sway holds its stamp. */
const TEASE_PAUSE_MS = 900;
const TEASE_LINGER_MS = 1100;

/** The demo deck: the round's cards, then the match card that ends it. */
type DemoCard =
  | { readonly kind: 'change'; readonly id: string; readonly card: Card }
  | { readonly kind: 'finale'; readonly id: 'finale' };

const FINALE_CARD: DemoCard = { kind: 'finale', id: 'finale' };

/**
 * A phone running the real round screen on the demo round, for the visitor to swipe: a swiped
 * card dissolves where it was let go, and its verdict comes with that place. The last card shows
 * what the swipes said and the way to the waitlist; it won't swipe away, only spring back. Done,
 * as in the app, ends the round early, once there is a swipe to learn from.
 */
export const DemoPhone = ({
  className,
  principles,
  onVerdict,
  onRestart,
}: {
  readonly className?: string;
  readonly principles: readonly Principle[];
  readonly onVerdict: (card: Card, verdict: Verdict, place: DOMRect) => void;
  readonly onRestart: () => void;
}) => {
  const deckRef = useRef<SwipeDeckHandle>(null);
  const [swipedCount, setSwipedCount] = useState(0);
  // Each play deals a fresh deck, so no card still leaving from the last one comes back with it.
  const [playthrough, setPlaythrough] = useState(0);
  const remaining = DEMO_ROUND.cards.slice(swipedCount);
  const isFinished = remaining.length === 0;
  const deck: DemoCard[] = [
    ...remaining.map(card => ({ kind: 'change' as const, id: card.id, card })),
    FINALE_CARD,
  ];

  const restart = () => {
    setSwipedCount(0);
    setPlaythrough(count => count + 1);
    onRestart();
  };

  const onSwipe = (item: DemoCard, verdict: Verdict, place: DOMRect) => {
    if (item.kind !== 'change') return;
    setSwipedCount(count => count + 1);
    onVerdict(item.card, verdict, place);
  };

  const finish = () => setSwipedCount(DEMO_ROUND.cards.length);

  // Until the visitor's pointer is on the phone, the top card sways between like and nope to
  // show it can be swiped; it never swipes itself, so every swipe in the demo is the visitor's.
  // Once they have touched the cards, they know: the swaying stops for good.
  const [isVisitorHere, setIsVisitorHere] = useState(false);
  const [hasVisitorPlayed, setHasVisitorPlayed] = useState(false);

  useEffect(() => {
    if (isFinished || isVisitorHere || hasVisitorPlayed) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const visitorArrived = new AbortController();
    const { signal } = visitorArrived;
    const sway = async () => {
      for (let beat = 0; !signal.aborted; beat++) {
        await wait(TEASE_PAUSE_MS, signal);
        await deckRef.current?.nudge(beat % 2 === 0 ? 'like' : 'dislike', {
          lingerMs: TEASE_LINGER_MS,
          signal,
        });
      }
    };
    void sway();
    return () => visitorArrived.abort();
  }, [isFinished, isVisitorHere, hasVisitorPlayed]);

  // Sized by its box; everything inside is drawn in the slot's unit, --u (1/430 of the phone).
  return (
    <div
      className={cn('relative aspect-[906/1806]', className)}
      onPointerEnter={() => setIsVisitorHere(true)}
      onPointerLeave={() => setIsVisitorHere(false)}
      onPointerDown={() => setHasVisitorPlayed(true)}
    >
      <div
        className={cn(
          'absolute top-[5.4%] left-[9%] h-[89.4%] w-[82.2%] rounded-[calc(46*var(--u))]',
          'bg-[linear-gradient(to_bottom,var(--card)_55%,var(--blush-light))]',
        )}
      />
      <img
        className="pointer-events-none absolute inset-0 size-full select-none"
        src={phoneBezel.src}
        alt=""
        draggable={false}
      />
      <div
        className={cn(
          'absolute top-[5.4%] left-[9%] h-[89.4%] w-[82.2%] rounded-[calc(46*var(--u))]',
          'flex flex-col px-[calc(16*var(--u))] text-[calc(16.5*var(--u))]',
        )}
      >
        <div
          className={cn(
            'mt-[calc(12*var(--u))] flex h-[calc(26*var(--u))] items-center justify-between',
            'px-[calc(18*var(--u))] text-[calc(15*var(--u))] font-bold text-ink',
          )}
          aria-hidden="true"
        >
          <span>9:41</span>
          <span className="flex gap-[0.3em] [&_svg]:size-[1.05em] [&_svg]:stroke-[2.5]">
            <CellSignalFullIcon />
            <WifiHighIcon />
            <BatteryFullIcon />
          </span>
        </div>
        <div className="mt-[calc(14*var(--u))]">
          <RoundHeader
            mergeRequestIid={DEMO_ROUND.mergeRequestIid}
            symbol={DEMO_ROUND.target.symbol}
            swipedCount={swipedCount}
            total={DEMO_ROUND.cards.length}
            action={
              <button
                type="button"
                className={cn(pillVariants(), 'px-[1.1em] py-[0.5em] text-[0.95em]')}
                disabled={swipedCount === 0 || isFinished}
                onClick={finish}
              >
                Done
                <HeartIcon weight="fill" aria-hidden="true" />
              </button>
            }
          />
        </div>
        {/* A touch smaller than the screen's text, so a card's longest diff fits unscrolled. */}
        <div className="mt-[calc(24*var(--u))] mb-[calc(34*var(--u))] min-h-0 flex-1 text-[calc(15.5*var(--u))]">
          <SwipeDeck
            key={playthrough}
            ref={deckRef}
            cards={deck}
            renderCard={item =>
              item.kind === 'change' ? (
                <CodeDiff
                  before={DEMO_ROUND.target.text}
                  after={item.card.after}
                  symbols={DEMO_ROUND.symbols}
                  layout="wrap"
                />
              ) : (
                <DemoFinale principles={principles} onRestart={restart} />
              )
            }
            canSwipe={item => item.kind === 'change'}
            exit="dissolve"
            onSwipe={onSwipe}
          />
        </div>
        <div className="mb-[calc(52*var(--u))] text-[calc(15.5*var(--u))]">
          <SwipeButtons
            onSwipe={verdict => void deckRef.current?.swipe(verdict)}
            disabled={isFinished}
          />
        </div>
      </div>
    </div>
  );
};
