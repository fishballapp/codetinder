import type { LearnState } from '@codetinder/api';
import { cn, pillVariants } from '@codetinder/ui';
import { CodeHeart } from '@codetinder/ui/react';
import { ArrowLeftIcon, HeartIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { ASKED_AGAIN_LINE, learnLine } from './doneState';

const quietLinkClass =
  'px-2 py-1 text-[0.95em] font-semibold text-ink-faint underline underline-offset-[0.2em] hover:text-ink';

/**
 * After Done: the reply is on the MR, the learn run has its cue, and the way back. It follows the
 * run: learned, or, when the run didn't finish, Learn again.
 */
export const RoundSent = ({
  projectId,
  projectName,
  mergeRequestIid,
  swipedCount,
  replyUrl,
  learn,
  learnAgain,
}: {
  readonly projectId: string;
  /** None until GitLab has said. */
  readonly projectName: string | undefined;
  readonly mergeRequestIid: number;
  readonly swipedCount: number;
  readonly replyUrl: string;
  /** Where learning the swipes stands; none until it loads. */
  readonly learn: LearnState | undefined;
  readonly learnAgain: {
    readonly label: string;
    readonly canFinish: boolean;
    readonly onPress: () => void;
  };
}) => {
  const swipes = `${swipedCount} ${swipedCount === 1 ? 'swipe' : 'swipes'}`;
  const isUnfinished = learn?._tag === 'Unfinished';
  const line = (() => {
    if (learn?._tag === 'Learned') {
      return `CodeTinder learned from your ${swipes}. Its reply is on the merge request.`;
    }
    if (learn?._tag === 'Unfinished') return learnLine(learn);
    const learning = `CodeTinder is learning from your ${swipes}. It'll reply on the merge request with what it learned, and the MR rewritten your way. Don't keep it waiting.`;
    return learn?._tag === 'Learning' && learn.isRetry
      ? `${ASKED_AGAIN_LINE} ${learning}`
      : learning;
  })();
  const projectLabel = projectName ?? 'the project';
  const projectLink = (
    <Link className={quietLinkClass} to="/projects/$id" params={{ id: projectId }}>
      See {projectLabel} on CodeTinder
    </Link>
  );
  return (
    <main className="grid min-h-dvh place-items-center bg-page px-4 pt-8 pb-[calc(2rem_+_env(safe-area-inset-bottom))]">
      <section
        className="grid w-[min(34rem,100%)] justify-items-center gap-4 rounded-[2rem] bg-card px-[clamp(1.5rem,4vw,2.75rem)] py-[clamp(2rem,5vw,3.25rem)] text-center text-ink shadow-lift animate-arrive motion-reduce:animate-none"
        aria-live="polite"
      >
        <CodeHeart className="size-20 text-lipstick animate-beat-once motion-reduce:animate-none" />
        <h1 className="font-display text-[clamp(2rem,1.5rem_+_1.5vw,2.75rem)] font-bold leading-[1.05] text-candy-red text-shadow-emboss">
          Sent to !{mergeRequestIid}
        </h1>
        <p className="max-w-[38ch] text-[1.1rem] text-pretty text-ink-soft">{line}</p>
        {isUnfinished ? (
          <>
            <button
              type="button"
              className={cn(pillVariants(), 'mt-3 px-8 py-[0.95rem] text-[1.1rem]')}
              disabled={!learnAgain.canFinish}
              onClick={learnAgain.onPress}
            >
              {learnAgain.label}
              <HeartIcon weight="fill" aria-hidden="true" />
            </button>
            <div className="flex flex-wrap justify-center gap-x-4">
              <a className={quietLinkClass} href={replyUrl}>
                Back to the merge request
              </a>
              {projectLink}
            </div>
          </>
        ) : (
          <>
            <a
              className={cn(pillVariants(), 'mt-3 px-8 py-[0.95rem] text-[1.1rem]')}
              href={replyUrl}
            >
              <ArrowLeftIcon aria-hidden="true" />
              Back to the merge request
            </a>
            {projectLink}
          </>
        )}
      </section>
    </main>
  );
};
