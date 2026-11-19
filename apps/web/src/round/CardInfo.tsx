import { cn } from '@codetinder/ui';
import { InfoIcon } from '@phosphor-icons/react';
import { Peek } from './Peek';

/** A sentence as written, its backticked spans in monospace as markdown shows them. */
export const InlineCode = ({ markdown }: { readonly markdown: string }) =>
  // Split at a captured span, the odd pieces are the code.
  markdown.split(/`([^`]+)`/).map((piece, index) =>
    index % 2 === 1 ? (
      <code
        key={index}
        className="rounded-[6px] bg-card-sunk px-[0.3em] font-mono text-[0.88em] text-ink"
      >
        {piece}
      </code>
    ) : (
      piece
    ),
  );

/** The heading and one-sentence summary of what a change card did to the function. */
export const cardInfoContent = ({
  operation,
  change,
}: {
  readonly operation: string;
  readonly change: string;
}) => ({
  head: <h2 className="mb-1.5 text-[1rem] leading-[1.35] font-bold text-ink">{operation}</h2>,
  body: (
    <p className="max-w-[38ch] text-[0.95rem] leading-[1.55] text-pretty text-ink-soft">
      <InlineCode markdown={change} />
    </p>
  ),
});

/**
 * The info button in a change card's top-right corner: hovering or clicking it on desktop (or
 * tapping it on a phone) says what operation the card applies and what it changed, never naming
 * the principle it tests.
 */
export const CardInfo = ({
  operation,
  change,
}: {
  readonly operation: string;
  readonly change: string;
}) => {
  const { head, body } = cardInfoContent({ operation, change });
  return (
    <Peek
      align="end"
      alignOffset={-6}
      sideOffset={4}
      trigger={
        <button
          type="button"
          aria-label="What this card changes"
          // Pressing or dragging on the button must not start a swipe on the card underneath.
          onPointerDown={event => event.stopPropagation()}
          className="group absolute top-0.5 right-0.5 grid size-11 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 outline-none"
        >
          <span
            className={cn(
              'grid size-8 place-items-center rounded-full bg-card-sunk text-ink-soft',
              'transition-[background-color,color] duration-150 ease-out group-hover:bg-petal-wash group-hover:text-wine group-data-[popup-open]:bg-petal-wash group-data-[popup-open]:text-lipstick',
              'group-focus-visible:outline-3 group-focus-visible:outline-offset-2 group-focus-visible:outline-hot-pink',
            )}
          >
            <InfoIcon className="size-5" aria-hidden="true" />
          </span>
        </button>
      }
      label={operation}
      head={head}
    >
      {body}
    </Peek>
  );
};
