import type { Card, Verdict } from '@codetinder/core';
import arrowLeft from '@codetinder/ui/plates/arrow-left.webp';
import arrowRight from '@codetinder/ui/plates/arrow-right.webp';
import heartMatch from '@codetinder/ui/plates/heart-match.webp';
import heartNameMe from '@codetinder/ui/plates/heart-name-me.webp';
import { FlyingHearts, type FlyingHeartsHandle } from '@codetinder/ui/react';
import { useRef, useState } from 'react';
import { DemoPhone } from './DemoPhone';
import { applyVerdict, demoPrinciples, NO_SCORES, principleSwayedBy } from './demoPrinciples';
import { MrNoteCard } from './MrNoteCard';
import { PrinciplesCard, type PrinciplesCardHandle } from './PrinciplesCard';

/**
 * The loop, the page's one island: the MR note, the round on a phone, and the principles doc each
 * swipe writes, with hearts flying from a liked card into the doc.
 */
export const DemoLoop = () => {
  const [scores, setScores] = useState(NO_SCORES);

  // The doc catches up with a like once its hearts have landed in it; a nope writes it at once.
  const [docScores, setDocScores] = useState(NO_SCORES);
  const [heartbeats, setHeartbeats] = useState<Readonly<Record<string, number>>>({});
  const heartsRef = useRef<FlyingHeartsHandle>(null);
  const docRef = useRef<PrinciplesCardHandle>(null);
  const playthrough = useRef(new AbortController());

  const onVerdict = async (card: Card, verdict: Verdict, place: DOMRect) => {
    const next = applyVerdict(scores, card, verdict);
    setScores(next);
    const { signal } = playthrough.current;
    if (verdict === 'like') {
      const swayed = principleSwayedBy(scores, next, card);
      const spot = docRef.current?.landingSpot(swayed);
      await heartsRef.current?.fly(place, spot ? [spot] : [], signal);
      if (signal.aborted) return;
      setHeartbeats(current => ({ ...current, [swayed]: (current[swayed] ?? 0) + 1 }));
    }
    setDocScores(current => applyVerdict(current, card, verdict));
  };

  const restart = () => {
    playthrough.current.abort();
    playthrough.current = new AbortController();
    setScores(NO_SCORES);
    setDocScores(NO_SCORES);
    setHeartbeats({});
  };

  return (
    <div className="relative">
      {/*
       * The loop: the MR note, the round on a phone, the principles doc it writes. Each slot is a
       * container, and its card is drawn in that container's unit (--u), so a card scales as a piece
       * while its width stays in rem and follows the reader's zoom.
       */}
      <div className="mt-[clamp(1rem,1.5vw,1.5rem)] grid grid-cols-[minmax(22rem,30rem)_22rem_minmax(22rem,29rem)] items-start justify-center gap-[var(--gap)] [--gap:clamp(3rem,5vw,6rem)] max-[75rem]:grid-cols-[minmax(0,25rem)] max-[75rem]:gap-10">
        {/* Narrow, the hero is the phone alone; How it works shows the note and the doc. */}
        <div className="relative @container mt-[clamp(6rem,9vw,8.5rem)] [--u:calc(100cqw_/_500)] max-[75rem]:hidden">
          {/* The arrows float in the gaps, never touching what they join. */}
          <img
            className="pointer-events-none absolute right-[calc(0.25rem_-_var(--gap))] bottom-[calc(100%_+_1rem)] w-56"
            src={arrowLeft.src}
            alt=""
          />
          <MrNoteCard />
        </div>
        {/* A dragged card passes over everything around the phone. */}
        <div className="relative @container z-1 [--u:calc(100cqw_/_430)]">
          <DemoPhone
            principles={demoPrinciples(scores)}
            onVerdict={(card, verdict, place) => void onVerdict(card, verdict, place)}
            onRestart={restart}
          />
        </div>
        <div className="relative @container mt-[clamp(9rem,13vw,12rem)] [--u:calc(100cqw_/_478)] max-[75rem]:hidden">
          <img
            className="pointer-events-none absolute left-[calc(-60_*_var(--u))] bottom-[calc(100%_+_12_*_var(--u))] w-[calc(150_*_var(--u))]"
            src={arrowRight.src}
            alt=""
          />
          {/* The doc's candies sit on its edge in its unit, clear of the arrow and each other at any size. */}
          <img
            className="pointer-events-none absolute left-[calc(105_*_var(--u))] bottom-[calc(100%_+_24_*_var(--u))] w-[calc(160_*_var(--u))] rotate-[4deg] animate-candy-float motion-reduce:animate-none [--float-delay:-4.1s] [--float-duration:5.4s]"
            src={heartNameMe.src}
            alt=""
          />
          <img
            className="pointer-events-none absolute left-[calc(255_*_var(--u))] bottom-[calc(100%_+_40_*_var(--u))] w-[calc(240_*_var(--u))] rotate-[-4deg] animate-candy-float motion-reduce:animate-none [--float-delay:-1.8s] [--float-duration:4.6s]"
            src={heartMatch.src}
            alt=""
          />
          <PrinciplesCard
            ref={docRef}
            principles={demoPrinciples(docScores)}
            heartbeats={heartbeats}
          />
        </div>
      </div>
      <FlyingHearts ref={heartsRef} />
    </div>
  );
};
