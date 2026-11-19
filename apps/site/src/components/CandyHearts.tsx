import doodleLeft from '@codetinder/ui/plates/doodle-left.webp';
import heartBeMine from '@codetinder/ui/plates/heart-be-mine.webp';
import heartEarlyReturn from '@codetinder/ui/plates/heart-early-return.webp';
import heartNoElse from '@codetinder/ui/plates/heart-no-else.webp';
import heartPure from '@codetinder/ui/plates/heart-pure.webp';

/**
 * Conversation-heart candies stamped with principles (and a come-on), around the promise. The two
 * by the principles doc are drawn with it, in Landing.
 */
export const CandyHearts = () => (
  // Candies sit in the hero's margins, sized with the viewport but never under the promise.
  <div className="pointer-events-none absolute inset-0" aria-hidden="true">
    {/* A candy bobs gently in place. Each sets its own pace and a negative delay, so they drift out
    of step from the first frame. The doc's candies compose this too. */}
    {/* Sized by the hero, which keeps room above the promise for them. */}
    <img
      className="absolute h-auto animate-candy-float motion-reduce:animate-none [--float-duration:5.2s] [--float-delay:-1.1s] top-4 left-[clamp(-1rem,-2vw,0rem)] w-[clamp(8rem,4.5rem_+_7.5vw,14.5rem)] rotate-[-8deg] max-[75rem]:top-0 max-[75rem]:w-[var(--corner-candy)]"
      src={heartEarlyReturn.src}
      alt=""
    />
    <img
      className="absolute h-auto animate-candy-float motion-reduce:animate-none [--float-duration:6s] [--float-delay:-3.4s] top-[clamp(9rem,12vw,14rem)] left-[clamp(3rem,6vw,7rem)] w-[clamp(7.5rem,4rem_+_6.5vw,13rem)] rotate-[6deg] max-[75rem]:hidden"
      src={heartNoElse.src}
      alt=""
    />
    <img
      className="absolute h-auto top-[clamp(13rem,17vw,19rem)] left-[clamp(0.5rem,1.5vw,1.5rem)] w-[clamp(3.5rem,2.25rem_+_2.5vw,6rem)] max-[75rem]:hidden"
      src={doodleLeft.src}
      alt=""
    />
    <img
      className="absolute h-auto animate-candy-float motion-reduce:animate-none [--float-duration:5.6s] [--float-delay:-2.2s] top-10 right-[clamp(-1rem,-1vw,0rem)] w-[clamp(7rem,-6rem_+_18.5vw,13rem)] rotate-[8deg] max-[75rem]:top-0 max-[75rem]:w-[var(--corner-candy)]"
      src={heartBeMine.src}
      alt=""
    />
    <img
      className="absolute h-auto animate-candy-float motion-reduce:animate-none [--float-duration:4.8s] [--float-delay:-0.6s] top-[clamp(8.5rem,11vw,12rem)] right-[clamp(4rem,12vw_-_4rem,10rem)] w-[clamp(7rem,-6rem_+_18.5vw,13rem)] rotate-[-6deg] max-[75rem]:hidden"
      src={heartPure.src}
      alt=""
    />
  </div>
);
