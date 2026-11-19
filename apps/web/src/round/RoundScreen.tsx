import type { AskId, GetRoundSuccess, RoundId } from '@codetinder/api';
import type { Card, Verdict, Verdicts } from '@codetinder/core';
import { CodeDiff, SwipeButtons, SwipeDeck, type SwipeDeckHandle } from '@codetinder/ui/react';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { ArrowUUpLeftIcon } from '@phosphor-icons/react';
import { useLocation } from '@tanstack/react-router';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useEffect, useRef, useState } from 'react';
import {
  doneAtom,
  retryLearnAtom,
  roundLearnAtom,
  roundLinksAtom,
  saveVerdictsAtom,
  startSignInAtom,
} from '../state/atoms';
import { CardInfo } from './CardInfo';
import { askToRepeat, doneState } from './doneState';
import { RoundBar } from './RoundBar';
import { RoundEnd } from './RoundEnd';
import { RoundSent } from './RoundSent';
import { SymbolPeek } from './SymbolPeek';

/** The deck: the round's cards still to swipe, then the one that ends the round. */
type DeckCard =
  | { readonly kind: 'change'; readonly id: string; readonly card: Card }
  | { readonly kind: 'end'; readonly id: 'end' };

const END_CARD: DeckCard = { kind: 'end', id: 'end' };

const KEY_VERDICTS: Readonly<Record<string, Verdict>> = {
  ArrowLeft: 'dislike',
  ArrowRight: 'like',
};

/**
 * Swiping a round: the cards the developer hasn't judged yet, one at a time, by drag, buttons or
 * ← / →. Each card is one change to the function, shown as a diff of the whole function, never
 * naming its principle; an info button in the corner says what the card changed. Each verdict is
 * saved as it is given; Done replies on the MR to start learning, and the page follows the learn
 * run: if GitLab never starts it while the page watches, the page asks again, once, by itself.
 */
export const RoundScreen = ({
  roundId,
  details,
  savedVerdicts,
}: {
  readonly roundId: RoundId;
  readonly details: GetRoundSuccess;
  readonly savedVerdicts: Verdicts;
}) => {
  const { round } = details;
  const [verdicts, setVerdicts] = useState(savedVerdicts);
  // What a screen reader hears after a swipe: the card moved, and which one is up now.
  const [announcement, setAnnouncement] = useState('');
  const [saveResult, save] = useAtom(saveVerdictsAtom(roundId));
  const [doneResult, finish] = useAtom(doneAtom(roundId));
  const learnResult = useAtomValue(roundLearnAtom(roundId));
  // A read that failed shows no state, not the last one read: that may be a Learning… long over.
  const isLearnUnreadable = AsyncResult.isFailure(learnResult);
  const learn = isLearnUnreadable ? undefined : AsyncResult.getOrElse(learnResult, () => undefined);
  const repeatAsk = useAtomSet(retryLearnAtom(roundId));
  // The asks this page saw learning: only those may it ask again for, once.
  const watchedAsks = useRef(new Set<AskId>());
  const links = AsyncResult.getOrElse(useAtomValue(roundLinksAtom(roundId)), () => undefined);
  const deckRef = useRef<SwipeDeckHandle>(null);
  const startSignIn = useAtomSet(startSignInAtom);
  const pathname = useLocation({ select: location => location.pathname });

  const remaining = round.cards.filter(card => verdicts[card.id] === undefined);
  const swipedCount = round.cards.length - remaining.length;
  const likedCount = Object.values(verdicts).filter(verdict => verdict === 'like').length;
  const isFinished = remaining.length === 0;
  const deck: DeckCard[] = [
    ...remaining.map(card => ({ kind: 'change' as const, id: card.id, card })),
    END_CARD,
  ];
  const symbols = round.context.map(snippet => snippet.symbol);
  const definitions = new Map(round.context.map(snippet => [snippet.symbol, snippet]));

  const record = (next: Verdicts) => {
    setVerdicts(next);
    save(next);
  };

  // Swipes take the cards in the round's order, so the last swiped is the last with a verdict.
  const lastSwiped = round.cards.findLast(card => verdicts[card.id] !== undefined);
  const undo = () => {
    if (lastSwiped === undefined) return;
    const verdict = verdicts[lastSwiped.id];
    if (verdict === undefined) return;
    if (!deckRef.current?.bringBack(verdict)) return;
    record(Object.fromEntries(Object.entries(verdicts).filter(([id]) => id !== lastSwiped.id)));
    setAnnouncement(`Undone. Card ${swipedCount} of ${round.cards.length}.`);
  };

  // Done replies with the verdicts it saved, so none may change until it has sent.
  const isSending = doneResult.waiting;
  const {
    label: doneLabel,
    canFinish,
    hasHeart,
  } = doneState({
    isSending,
    learn,
    isLearnUnreadable,
    isReady: swipedCount > 0 && links !== undefined,
  });
  const onDone = () => {
    if (links === undefined) return;
    finish({
      verdicts,
      projectId: details.projectId,
      mergeRequestIid: details.mergeRequestIid,
      mergeRequestUrl: links.mergeRequestUrl,
    });
  };

  const { projectId, mergeRequestIid } = details;
  useEffect(() => {
    if (learn === undefined) return;
    if (learn._tag === 'Learning') {
      watchedAsks.current.add(learn.askId);
      return;
    }
    const askId = askToRepeat({ learn, watched: watchedAsks.current });
    if (askId === undefined) return;
    watchedAsks.current.delete(askId);
    repeatAsk({ askId, projectId, mergeRequestIid });
  }, [learn, repeatAsk, projectId, mergeRequestIid]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const verdict = KEY_VERDICTS[event.key];
      if (verdict === undefined || event.repeat || event.altKey || event.metaKey) return;
      if (event.ctrlKey || event.shiftKey) return;
      const isInField =
        event.target instanceof Element &&
        event.target.closest('[role="dialog"], [data-popup-open], input, textarea');
      if (isInField) return;
      event.preventDefault();
      void deckRef.current?.swipe(verdict);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (AsyncResult.isSuccess(doneResult)) {
    return (
      <RoundSent
        projectId={details.projectId}
        projectName={links?.projectName}
        mergeRequestIid={details.mergeRequestIid}
        swipedCount={swipedCount}
        replyUrl={doneResult.value}
        learn={learn}
        learnAgain={{ label: doneLabel, canFinish, onPress: onDone }}
      />
    );
  }

  const isSignedOut =
    AsyncResult.builder(saveResult)
      .onErrorTag('SignedOut', () => true)
      .orElse(() => false) ||
    AsyncResult.builder(doneResult)
      .onErrorTag('SignedOut', () => true)
      .orElse(() => false);
  const failure = (() => {
    if (isSignedOut) return "GitLab signed you out, so that didn't save. Sign in and pick up here.";
    if (AsyncResult.isFailure(saveResult)) return "That swipe didn't save. Swipe on, or try again.";
    if (isLearnUnreadable) {
      return "Couldn't check how CodeTinder's learning is going; trying again. Done still works.";
    }
    return (
      AsyncResult.builder(doneResult)
        .onErrorTag(
          'RoundThreadNotFound',
          error => `${error.message}, so Done has nowhere to reply.`,
        )
        // Not failures: Done reads Learned ✓ or Learning….
        .onErrorTag('AlreadyLearned', () => null)
        .onErrorTag('AlreadyLearning', () => null)
        .onFailure(() => "Couldn't post on the merge request. Give Done another go.")
        .orNull()
    );
  })();
  const failureAction = (() => {
    if (isSignedOut) {
      return (
        <button
          type="button"
          className="cursor-pointer bg-transparent p-0 font-bold text-lipstick underline underline-offset-[0.2em]"
          onClick={() => startSignIn(pathname)}
        >
          Sign in again
        </button>
      );
    }
    if (!AsyncResult.isFailure(saveResult)) return null;
    return (
      <button
        type="button"
        className="cursor-pointer bg-transparent p-0 font-bold text-lipstick underline underline-offset-[0.2em]"
        onClick={() => save(verdicts)}
      >
        Try again
      </button>
    );
  })();

  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr] bg-page">
      <RoundBar
        mergeRequestIid={details.mergeRequestIid}
        symbol={round.target.symbol}
        links={links}
        swipedCount={swipedCount}
        total={round.cards.length}
        doneLabel={doneLabel}
        canFinish={canFinish}
        hasHeart={hasHeart}
        onDone={onDone}
      />
      {/* The deck owns the room: up to ~90 columns of code, as tall as the screen leaves it. Past its
          cap the deck and its buttons stay together, centred, the spare room above and below. A card's
          first code line ends short of its corner info button, so the button never covers code. */}
      <main className="flex flex-col items-center justify-center gap-[clamp(1.25rem,3dvh,2rem)] px-[clamp(1rem,3vw,2.5rem)] pt-[clamp(0.75rem,2dvh,1.5rem)] pb-[calc(clamp(1.25rem,3dvh,2.5rem)_+_env(safe-area-inset-bottom))]">
        <div className="grid min-h-[20.5rem] max-h-[42.5rem] w-[min(58rem,100%)] flex-1 grid-rows-[auto_minmax(0,1fr)] gap-2 text-[clamp(1rem,0.75rem_+_0.75vw,1.1rem)] [&_code>:first-child]:pr-12">
          {/* Its row is always there, so the deck doesn't jump as the button comes and goes. */}
          <div className="flex h-8 items-center">
            {lastSwiped !== undefined && (
              <button
                type="button"
                className="-ml-2.5 inline-flex h-8 cursor-pointer items-center gap-[0.35rem] rounded-full px-2.5 text-[0.95rem] font-semibold text-wine/70 hover:bg-white/60 hover:text-wine disabled:cursor-default disabled:opacity-50"
                onClick={undo}
                disabled={isSending}
              >
                <ArrowUUpLeftIcon className="size-5" weight="bold" aria-hidden="true" />
                Undo last swipe
              </button>
            )}
          </div>
          <SwipeDeck
            ref={deckRef}
            cards={deck}
            canSwipe={item => item.kind === 'change' && !isSending}
            onSwipe={(item, verdict) => {
              if (item.kind !== 'change') return;
              record({ ...verdicts, [item.card.id]: verdict });
              const swiped = verdict === 'like' ? 'Liked.' : 'Noped.';
              // The last swipe's end card announces itself.
              setAnnouncement(
                remaining.length > 1
                  ? `${swiped} Card ${swipedCount + 2} of ${round.cards.length}.`
                  : swiped,
              );
            }}
            renderCard={(item, isTop) => {
              if (item.kind === 'end') {
                return (
                  <RoundEnd
                    likedCount={likedCount}
                    total={round.cards.length}
                    learn={learn}
                    doneLabel={doneLabel}
                    canFinish={canFinish}
                    hasHeart={hasHeart}
                    isSending={isSending}
                    onDone={onDone}
                    onSwipeAgain={() => record({})}
                  />
                );
              }
              return (
                <>
                  <CodeDiff
                    before={round.target.text}
                    after={item.card.after}
                    symbols={symbols}
                    layout="wrap-on-touch"
                    renderSymbol={
                      isTop
                        ? symbol => {
                            const snippet = definitions.get(symbol);
                            return snippet ? (
                              <SymbolPeek
                                snippet={snippet}
                                fileUrl={links?.definitionUrls.get(symbol)}
                              />
                            ) : (
                              symbol
                            );
                          }
                        : undefined
                    }
                  />
                  {isTop && <CardInfo operation={item.card.operation} change={item.card.change} />}
                </>
              );
            }}
          />
        </div>
        <div className="text-[clamp(0.95rem,0.85rem_+_0.3vw,1.1rem)]">
          <SwipeButtons
            onSwipe={verdict => void deckRef.current?.swipe(verdict)}
            disabled={isFinished || isSending}
            withKeys
          />
        </div>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
        {failure && (
          <p
            className="flex max-w-[46rem] flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-[12px] bg-card px-[1.1rem] py-[0.6rem] text-center font-semibold text-wine shadow-card"
            role="alert"
          >
            {failure}
            {failureAction}
          </p>
        )}
      </main>
    </div>
  );
};
