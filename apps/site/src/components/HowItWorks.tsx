import { SwipeCardStill } from '@codetinder/ui/react';
import type { ReactNode } from 'react';
import { DEMO_ROUND, STILL_CARD } from './demoRound';
import { MrNoteCard } from './MrNoteCard';
import { ProposalCard } from './ProposalCard';

type Stage = { readonly title: string; readonly body: ReactNode; readonly visual: ReactNode };

const STAGES: readonly Stage[] = [
  {
    title: 'Same code, new moves',
    body: 'No need to read every line. On each merge request, CodeTinder tries small changes on a sample of your code, one at a time. Each one is meant to behave the same, and passes your tests before you see it.',
    visual: <MrNoteCard />,
  },
  {
    title: 'Swipe',
    body: "Each card is one change, shown as a diff. Swipe right on the ones you'd keep, left on the ones you wouldn't. Everyone on the team gets a swipe.",
    visual: (
      // Drawn at the demo phone's scale.
      <div className="p-[1em] pr-[2.5em] text-[calc(19_*_var(--u))]">
        <SwipeCardStill
          before={DEMO_ROUND.target.text}
          after={STILL_CARD.after}
          symbols={DEMO_ROUND.symbols}
        />
      </div>
    ),
  },
  {
    title: 'Your taste, learned and applied',
    body: (
      <>
        Press Done and your swipes become <code>.codetinder/principles.md</code>, with the MR
        rewritten to match, in one commit you review. Every round tells your agents a little more
        about your type.
      </>
    ),
    visual: <ProposalCard />,
  },
];

/** The loop, one stage per row: the MR note, the swipe, the commit it proposes. */
export const HowItWorks = () => (
  <section
    id="how-it-works"
    className="mx-auto max-w-[76rem] scroll-mt-4 px-[clamp(1rem,3vw,3rem)] pt-[clamp(4rem,8vw,7rem)]"
    aria-labelledby="how-it-works-title"
  >
    <h2
      id="how-it-works-title"
      className="text-center font-display text-[clamp(2.25rem,1.5rem_+_2.5vw,3.75rem)] font-bold leading-[1.05] text-candy-red"
    >
      How it works
    </h2>
    {/* The loop is a sequence, so its stages are numbered. */}
    <ol className="mt-[clamp(2.5rem,5vw,4.5rem)] grid list-none gap-[clamp(3.5rem,7vw,6rem)] [counter-reset:stage]">
      {STAGES.map(({ title, body, visual }) => (
        // Text beside its visual, sides alternating down the page.
        <li
          key={title}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,29rem)] items-center gap-[clamp(2rem,6vw,6rem)] [counter-increment:stage] max-[56rem]:grid-cols-[minmax(0,30rem)] max-[56rem]:justify-center"
        >
          <div className="min-[56rem]:[li:nth-child(even)_&]:order-1 before:mb-5 before:grid before:size-13 before:place-items-center before:rounded-full before:bg-lipstick before:font-display before:text-[1.6rem] before:font-bold before:text-white before:shadow-button before:content-[counter(stage)]">
            <h3 className="text-balance font-display text-[clamp(1.75rem,1.3rem_+_1.2vw,2.5rem)] font-bold leading-[1.1] text-candy-red">
              {title}
            </h3>
            <p className="mt-[0.9rem] max-w-[44ch] text-[1.15rem] leading-[1.6] text-wine [&_code]:text-[0.9em] [&_code]:[overflow-wrap:anywhere]">
              {body}
            </p>
          </div>
          {/* Each visual is drawn as one piece in this container's unit, like the hero's cards. */}
          <div className="@container [--u:calc(100cqw_/_478)]">{visual}</div>
        </li>
      ))}
    </ol>
  </section>
);
