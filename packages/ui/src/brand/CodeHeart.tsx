/**
 * The lines of code that draw the heart, top to bottom: each line's indent and length trace its
 * outline, split into tokens. `[y, x, width, tone]` in a 32-unit box.
 */
const TOKENS = [
  [3.6, 4.13, 9.75, 'ink'],
  [3.6, 18.12, 9.75, 'blush'],
  [7.88, 1.92, 11.65, 'ink'],
  [7.88, 15.61, 14.47, 'blush'],
  [12.16, 2.81, 6.89, 'ink'],
  [12.16, 11.74, 7.19, 'blush'],
  [12.16, 20.98, 8.21, 'ink'],
  [16.44, 6.24, 9.72, 'ink'],
  [16.44, 18, 7.76, 'blush'],
  [20.72, 11.13, 9.75, 'ink'],
  [25, 14.3, 3.4, 'ink'],
] as const;

/** CodeTinder's mark: a heart drawn by lines of code. The darker tokens take `color`. */
export const CodeHeart = ({ className }: { readonly className?: string }) => (
  <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    {TOKENS.map(([y, x, width, tone]) => (
      <rect
        key={`${y},${x}`}
        x={x}
        y={y}
        width={width}
        height="3.4"
        rx="1.7"
        fill={tone === 'ink' ? 'currentColor' : '#ff7aa8'}
      />
    ))}
  </svg>
);
