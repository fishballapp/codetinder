import { Wordmark } from '@codetinder/ui/react';

const HACKATHON_RESULTS_URL = 'https://devpost.com/software/codetinder-swipe-for-the-love-of-code';
const SOURCE_URL =
  'https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/1855115/codetinder';

export const SiteFooter = () => (
  <footer className="mt-[clamp(5rem,10vw,8rem)] grid justify-items-center gap-3 border-t border-wine/12 px-[clamp(1rem,3vw,3rem)] pt-10 pb-[calc(3rem_+_env(safe-area-inset-bottom))] text-center text-[1rem] text-wine">
    <Wordmark className="text-[1.6rem]" />
    <p className="text-balance">
      Made with love by Fishball Ltd for the GitLab Transcend hackathon.
    </p>
    <p className="flex flex-wrap justify-center gap-x-5 gap-y-2 font-semibold [&_a]:underline">
      <a href={HACKATHON_RESULTS_URL}>Hackathon entry</a>
      <a href={SOURCE_URL}>Source code</a>
      <a href="/privacy">Privacy</a>
    </p>
  </footer>
);
