import type { AskId, LearnState } from '@codetinder/api';

/** What Done reads in each learn state, and whether it asks for a learn. */
const DONE_BY_LEARN: Record<
  LearnState['_tag'],
  { readonly label: string; readonly canAsk: boolean }
> = {
  NotLearned: { label: 'Done', canAsk: true },
  Learning: { label: 'Learning…', canAsk: false },
  Learned: { label: 'Learned ✓', canAsk: false },
  Unfinished: { label: 'Learn again', canAsk: true },
};

/**
 * What the Done button reads, whether it can be pressed, and whether it wears its heart. It asks
 * for swipes no learn run has learned or is learning, and again for one that didn't finish; a
 * swipe change turns it back on. Until the round's learn state loads, it waits; when it can't be
 * read, Done can be pressed, and the server decides.
 */
export const doneState = ({
  isSending,
  learn,
  isLearnUnreadable,
  isReady,
}: {
  readonly isSending: boolean;
  readonly learn: LearnState | undefined;
  /** The last read of the learn state failed. */
  readonly isLearnUnreadable: boolean;
  /** The round has a swipe and GitLab has said where its MR is, so Done has somewhere to reply. */
  readonly isReady: boolean;
}): { readonly label: string; readonly canFinish: boolean; readonly hasHeart: boolean } => {
  if (isSending) return { label: 'Sending…', canFinish: false, hasHeart: true };
  if (isLearnUnreadable) return { label: 'Done', canFinish: isReady, hasHeart: true };
  if (learn === undefined) return { label: 'Done', canFinish: false, hasHeart: true };
  const { label, canAsk } = DONE_BY_LEARN[learn._tag];
  return { label, canFinish: canAsk && isReady, hasHeart: canAsk };
};

/** The line the page asked again by itself shows while that ask is learning. */
export const ASKED_AGAIN_LINE = "GitLab didn't pick that up, so we asked again.";

/**
 * What the page says of a learn under way, done or stuck: none when no Done asked for these
 * swipes, which the page words itself.
 */
export const learnLine = (learn: LearnState): string | null => {
  if (learn._tag === 'NotLearned') return null;
  if (learn._tag === 'Learned') {
    return 'CodeTinder has learned these swipes. Change one to teach it more.';
  }
  if (learn._tag === 'Learning') {
    const learning = 'CodeTinder is learning these swipes. Its reply lands on the merge request.';
    return learn.isRetry ? `${ASKED_AGAIN_LINE} ${learning}` : learning;
  }
  if (learn.reason === 'Failed') {
    return "CodeTinder couldn't learn from these swipes; its reply on the merge request says why. Learn again to give it another go.";
  }
  if (learn.reason === 'Stalled') {
    return 'CodeTinder went quiet before it finished learning. Learn again to give it another go.';
  }
  if (learn.isRetry) {
    return "GitLab didn't pick up your Done, even when we asked twice. Learn again once it's feeling better.";
  }
  return "GitLab never picked up your Done. Learn again and we'll ask louder.";
};

/**
 * The ask the page should post again by itself, if any: one GitLab never started, that this page
 * watched while it waited (a page opened later offers Learn again instead), and that wasn't itself
 * asked again.
 */
export const askToRepeat = ({
  learn,
  watched,
}: {
  readonly learn: LearnState;
  /** The asks this page saw learning. */
  readonly watched: ReadonlySet<AskId>;
}): AskId | undefined => {
  if (learn._tag !== 'Unfinished' || learn.reason !== 'NotStarted' || learn.isRetry) return;
  return watched.has(learn.askId) ? learn.askId : undefined;
};
