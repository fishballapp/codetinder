import { CodeHeart } from '@codetinder/ui/react';
import { WaitlistLink } from './WaitlistLink';

/** Where CodeTinder is headed, a card in the page's gutters, and the way onto the waitlist again. */
export const ComingSoon = () => (
  <div className="mt-[clamp(5rem,10vw,8rem)] px-[clamp(1rem,3vw,3rem)]">
    <section
      className="mx-auto grid max-w-[36rem] justify-items-center rounded-[2rem] bg-card px-[clamp(1.25rem,4vw,3rem)] py-[clamp(2rem,4vw,2.75rem)] text-center shadow-lift"
      aria-labelledby="coming-soon-title"
    >
      <CodeHeart className="size-12 text-lipstick" />
      <h2
        id="coming-soon-title"
        className="mt-3 text-balance font-display text-[clamp(2rem,1.4rem_+_2vw,3rem)] font-bold leading-[1.1] text-candy-red"
      >
        Coming soon to GitHub and GitLab
      </h2>
      <WaitlistLink
        placement="closing"
        className="mt-6 gap-[0.6rem] px-9 py-[0.95rem] text-[1.3rem]"
      />
    </section>
  </div>
);
