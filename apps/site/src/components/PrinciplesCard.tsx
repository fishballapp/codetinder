import { groupBySection, type Principle } from '@codetinder/core';
import { cn } from '@codetinder/ui';
import { DotsThreeIcon, FileTextIcon } from '@phosphor-icons/react';
import { type Ref, type RefObject, useImperativeHandle, useRef } from 'react';

export type PrinciplesCardHandle = {
  /**
   * Where hearts for a principle land: its strength chip, or the doc's last line while the doc has
   * no line for it yet. Null while the card is hidden.
   */
  readonly landingSpot: (principleId: string) => Element | null;
};

type Line = { readonly key: string; readonly content: React.ReactNode };

/** A principle's lines: a gap, its heading with the strength chip, then its statement. */
const principleLines = (
  { id, strength, statement }: Principle,
  heartbeats: Readonly<Record<string, number>>,
  chips: RefObject<Map<string, HTMLElement>>,
): Line[] => [
  { key: `${id}-gap`, content: '' },
  {
    key: `${id}-heading`,
    content: (
      <span className="font-semibold text-lipstick">
        ### {id} ·{' '}
        <span
          key={`${strength} ${heartbeats[id] ?? 0}`}
          ref={chip => {
            if (!chip) return;
            chips.current.set(id, chip);
            return () => {
              chips.current.delete(id);
            };
          }}
          // A strength that changes (keyed by its value) pops, so the visitor sees their swipe land.
          className={cn(
            'inline-block animate-strength-pop rounded-[calc(8*var(--u))] border border-petal',
            'bg-petal-wash px-[calc(10*var(--u))] font-sans text-[calc(18*var(--u))] font-semibold',
            'leading-[calc(34*var(--u))] motion-reduce:animate-none',
          )}
        >
          {strength}
        </span>
      </span>
    ),
  },
  { key: `${id}-statement`, content: statement },
];

/**
 * The doc's lines as CodeTinder writes them: a heading per section, then a heading per principle
 * and its statement.
 */
const docLines = (
  principles: readonly Principle[],
  heartbeats: Readonly<Record<string, number>>,
  chips: RefObject<Map<string, HTMLElement>>,
): Line[] => {
  if (principles.length === 0) {
    return [
      {
        key: 'empty',
        content: <span className="text-ink-faint">{'<!-- swipe to fill me in -->'}</span>,
      },
    ];
  }
  return groupBySection(principles).flatMap(({ section, principles }, sectionIndex) => [
    ...(sectionIndex > 0 ? [{ key: `${section}-gap`, content: '' }] : []),
    {
      key: `${section}-heading`,
      content: <span className="font-bold text-lipstick">## {section}</span>,
    },
    ...principles.flatMap(principle => principleLines(principle, heartbeats, chips)),
  ]);
};

/**
 * The principles doc in the repo, rewritten by the demo round's swipes as they happen. A strength
 * chip pops when its strength changes, and with each of `heartbeats`: the bursts of hearts it has
 * caught.
 */
export const PrinciplesCard = ({
  className,
  principles,
  heartbeats,
  ref,
}: {
  readonly className?: string;
  readonly principles: readonly Principle[];
  readonly heartbeats: Readonly<Record<string, number>>;
  readonly ref?: Ref<PrinciplesCardHandle>;
}) => {
  const docRef = useRef<HTMLOListElement>(null);
  const chips = useRef(new Map<string, HTMLElement>());

  useImperativeHandle(ref, () => ({
    landingSpot: principleId => {
      const doc = docRef.current;
      if (!doc?.checkVisibility()) return null;
      return chips.current.get(principleId) ?? doc.lastElementChild;
    },
  }));

  return (
    <article
      // Drawn in its slot's unit, --u: 1/478 of the card's width, so the card scales as a piece.
      className={cn(
        'overflow-hidden rounded-[calc(16*var(--u))] bg-card text-ink shadow-card',
        className,
      )}
      aria-label="The principles doc it writes"
    >
      <header
        className={cn(
          'flex h-[calc(80*var(--u))] items-center gap-[calc(14*var(--u))] border-b border-rule',
          'px-[calc(24*var(--u))] text-[calc(19.5*var(--u))]',
        )}
      >
        <FileTextIcon className="size-[calc(26*var(--u))] text-ink-soft" aria-hidden="true" />
        <span className="font-medium">.codetinder/principles.md</span>
        <DotsThreeIcon
          weight="bold"
          className="ml-auto size-[calc(26*var(--u))] text-ink-soft"
          aria-hidden="true"
        />
      </header>
      <ol
        ref={docRef}
        className={cn(
          'list-none pt-[calc(16*var(--u))] pr-[calc(24*var(--u))] pb-[calc(20*var(--u))]',
          'font-mono text-[calc(19*var(--u))] leading-[calc(34*var(--u))] [font-variant-ligatures:none]',
          '[counter-reset:line]',
        )}
        aria-live="polite"
      >
        {docLines(principles, heartbeats, chips).map(({ key, content }) => (
          <li
            key={key}
            // Numbered like an editor: the number sits in a ruled gutter, wrapped text stays beside it.
            className={cn(
              'grid min-h-[calc(34*var(--u))] grid-cols-[calc(72*var(--u))_1fr] [counter-increment:line]',
              'before:mr-[calc(20*var(--u))] before:border-r before:border-rule before:pr-[calc(22*var(--u))]',
              'before:text-right before:text-ink-faint before:content-[counter(line)]',
            )}
          >
            {content}
          </li>
        ))}
      </ol>
    </article>
  );
};
