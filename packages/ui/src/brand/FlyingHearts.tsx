import { HeartIcon } from '@phosphor-icons/react';
import { type Ref, useImperativeHandle, useRef } from 'react';

export type FlyingHeartsHandle = {
  /**
   * Turns a liked card, dissolving at `card`, into hearts that burst out of it and arc onto the
   * `to` spots, shared out between them; with no spot to reach, they float up and fade. Resolves
   * once the last heart lands, at once when motion is reduced. Aborting `signal` clears them.
   */
  readonly fly: (card: DOMRect, to: readonly Element[], signal: AbortSignal) => Promise<void>;
};

type Point = { readonly x: number; readonly y: number };

const HEARTS_PER_LIKE = 9;
const HEART_STAGGER_MS = 25;
const HEART_TONES = ['var(--candy-red)', 'var(--hot-pink)', 'var(--bubblegum)', 'var(--lipstick)'];
/** The share of a flight spent popping out of the card before the arc begins. */
const BURST_SHARE = 0.2;
const ARC_STEPS = 12;

const between = (min: number, max: number) => min + Math.random() * (max - min);

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** The point `t` of the way along a quadratic curve from `start`, pulled toward `control`. */
const alongCurve = (start: Point, control: Point, end: Point, t: number): Point => {
  const u = 1 - t;
  return {
    x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
    y: u * u * start.y + 2 * u * t * control.y + t * t * end.y,
  };
};

const placed = ({ x, y }: Point, scale: number, rotate: number) =>
  `translate(${x}px, ${y}px) translate(-50%, -50%) rotate(${rotate}deg) scale(${scale})`;

/** A heart's flight: it pops out to `burst`, then arcs high over the gap and sinks into `end`. */
const arcKeyframes = (start: Point, burst: Point, end: Point, rem: number): Keyframe[] => {
  const lift = Math.max(6 * rem, Math.hypot(end.x - burst.x, end.y - burst.y) * 0.6);
  const control = { x: (burst.x + end.x) / 2, y: Math.min(burst.y, end.y) - lift };
  const tilt = between(-24, 24);
  const arc = Array.from({ length: ARC_STEPS }, (_, index) => {
    const share = (index + 1) / ARC_STEPS;
    return {
      offset: BURST_SHARE + (1 - BURST_SHARE) * share,
      transform: placed(
        alongCurve(burst, control, end, easeInOut(share)),
        1.1 - 0.6 * share,
        tilt * (1 - share),
      ),
      opacity: share === 1 ? 0 : 1,
    };
  });
  return [
    { offset: 0, transform: placed(start, 0.3, tilt), opacity: 0, easing: 'ease-out' },
    { offset: BURST_SHARE, transform: placed(burst, 1.1, tilt), opacity: 1 },
    ...arc,
  ];
};

/** With nowhere to land, a heart pops out to `burst` and floats up out of sight. */
const floatKeyframes = (start: Point, burst: Point, rem: number): Keyframe[] => {
  const tilt = between(-24, 24);
  const end = { x: burst.x + between(-2, 2) * rem, y: burst.y - between(6, 9) * rem };
  return [
    { offset: 0, transform: placed(start, 0.3, tilt), opacity: 0, easing: 'ease-out' },
    { offset: BURST_SHARE, transform: placed(burst, 1.1, tilt), opacity: 1 },
    { offset: 1, transform: placed(end, 0.7, -tilt), opacity: 0 },
  ];
};

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A layer for hearts to fly in, laid over its container. On the landing a like sends hearts from
 * the demo phone into the principles doc; on a new match they burst out of the candy heart.
 */
export const FlyingHearts = ({ ref }: { readonly ref?: Ref<FlyingHeartsHandle> }) => {
  const layerRef = useRef<HTMLDivElement>(null);
  const heartRef = useRef<SVGSVGElement>(null);

  /** Puts a copy of `template` in the layer, sized in rem, for one animation; it leaves after. */
  const launch = (
    template: SVGSVGElement,
    { color, size }: { readonly color: string; readonly size: number },
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
    signal: AbortSignal,
  ) => {
    const sprite = template.cloneNode(true);
    if (!(sprite instanceof SVGSVGElement)) throw new Error('A heart template clones as an svg.');
    sprite.style.color = color;
    sprite.style.width = `${size}rem`;
    sprite.style.height = `${size}rem`;
    layerRef.current?.append(sprite);
    const flight = sprite.animate(keyframes, { fill: 'backwards', ...options });
    const cancel = () => flight.cancel();
    const land = () => {
      sprite.remove();
      signal.removeEventListener('abort', cancel);
    };
    flight.addEventListener('finish', land);
    flight.addEventListener('cancel', land);
    signal.addEventListener('abort', cancel, { once: true });
    return flight;
  };

  /** Where `rect` sits in the layer, as a point at `share` of its width and height. */
  const inLayer = (rect: DOMRect, share: Point): Point => {
    const layer = layerRef.current?.getBoundingClientRect() ?? new DOMRect();
    return {
      x: rect.left + rect.width * share.x - layer.left,
      y: rect.top + rect.height * share.y - layer.top,
    };
  };

  useImperativeHandle(ref, () => ({
    fly: async (card, to, signal) => {
      const template = heartRef.current;
      if (!template || signal.aborted || prefersReducedMotion()) return;
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const centre = inLayer(card, { x: 0.5, y: 0.5 });
      const flights = Array.from({ length: HEARTS_PER_LIKE }, (_, index) => {
        // Each heart rises out of a part of the card and bursts away from its middle.
        const start = inLayer(card, { x: between(0.2, 0.8), y: between(0.2, 0.8) });
        const away = Math.atan2(start.y - centre.y, start.x - centre.x);
        const push = between(1, 2) * rem;
        const burst = {
          x: start.x + Math.cos(away) * push,
          y: start.y + Math.sin(away) * push,
        };
        const spot = to[index % Math.max(1, to.length)];
        const keyframes = spot
          ? arcKeyframes(
              start,
              burst,
              inLayer(spot.getBoundingClientRect(), { x: 0.5, y: 0.5 }),
              rem,
            )
          : floatKeyframes(start, burst, rem);
        return launch(
          template,
          {
            color: HEART_TONES[index % HEART_TONES.length] ?? 'var(--hot-pink)',
            size: between(1.3, 2.1),
          },
          keyframes,
          { duration: between(950, 1050), delay: index * HEART_STAGGER_MS },
          signal,
        );
      });
      // A cancelled flight rejects: the burst was cleared, so there is nothing left to wait for.
      await Promise.all(flights.map(flight => flight.finished)).catch(() => undefined);
    },
  }));

  return (
    // Laid over its container, above its pieces, so hearts cross between them; it never takes a click.
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-2" aria-hidden="true">
      <div hidden>
        <HeartIcon
          ref={heartRef}
          className="absolute top-0 left-0 drop-shadow-[0_0.15rem_0.2rem_rgb(164_9_44/0.3)] will-change-[transform,opacity]"
          weight="fill"
        />
      </div>
    </div>
  );
};
