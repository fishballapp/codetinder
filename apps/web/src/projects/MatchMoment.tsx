import { pillVariants } from '@codetinder/ui';
import heartMatch from '@codetinder/ui/plates/heart-match.webp';
import { FlyingHearts, type FlyingHeartsHandle } from '@codetinder/ui/react';
import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';

/** How long the candy heart takes to spring in before the hearts burst out of it. */
const BURST_DELAY_MS = 240;

/** A project just added: the "it's a match!" candy springs in, hearts burst out, on to the MR. */
export const MatchMoment = ({
  projectName,
  setupMergeRequestUrl,
  onDone,
}: {
  readonly projectName: string;
  readonly setupMergeRequestUrl: string | null;
  readonly onDone: () => void;
}) => {
  const plateRef = useRef<HTMLImageElement>(null);
  const heartsRef = useRef<FlyingHeartsHandle>(null);
  const reviewRef = useRef<HTMLAnchorElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The button that had focus just left; the way on takes it.
    (reviewRef.current ?? doneRef.current)?.focus();
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const plate = plateRef.current;
      if (plate) void heartsRef.current?.fly(plate.getBoundingClientRect(), [], controller.signal);
    }, BURST_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  return (
    <div className="relative grid justify-items-center gap-4 px-[clamp(1.5rem,4vw,2.5rem)] pb-[clamp(1.75rem,4vw,2.5rem)] text-center">
      <FlyingHearts ref={heartsRef} />
      <h2 className="-mt-6">
        <img
          ref={plateRef}
          className="h-auto w-[min(17rem,70vw)] animate-spring-in motion-reduce:animate-none"
          src={heartMatch}
          width={560}
          height={420}
          alt="It's a match!"
        />
      </h2>
      <p className="max-w-[36ch] text-[1.1rem] text-pretty text-ink-soft">
        {setupMergeRequestUrl
          ? `${projectName} and CodeTinder are official. Merge the setup MR and the swiping starts on the next merge request.`
          : `CodeTinder's back on in ${projectName}, swiping on your merge requests.`}
      </p>
      <div className="mt-1 grid justify-items-center gap-2">
        {setupMergeRequestUrl && (
          <a
            className={pillVariants({ size: 'md' })}
            href={setupMergeRequestUrl}
            target="_blank"
            rel="noreferrer"
            ref={reviewRef}
          >
            Review the setup MR
            <ArrowSquareOutIcon aria-hidden="true" />
          </a>
        )}
        <button
          type="button"
          className="cursor-pointer rounded-pill px-4 py-[0.6rem] font-semibold text-wine hover:underline hover:underline-offset-[0.2em]"
          ref={doneRef}
          onClick={onDone}
        >
          Back to your projects
        </button>
      </div>
    </div>
  );
};
