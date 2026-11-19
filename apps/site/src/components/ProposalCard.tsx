import { cn } from '@codetinder/ui';
import { CodeHeart } from '@codetinder/ui/react';
import { FileTextIcon, GitCommitIcon } from '@phosphor-icons/react';

/** One line of a file's diff: removed, added or unchanged. */
type DiffLine = readonly ['-' | '+' | ' ', string];

/** The proposal commit: the principles firming up, and the MR's code rewritten to follow them. */
const FILES: readonly { readonly path: string; readonly lines: readonly DiffLine[] }[] = [
  {
    path: '.codetinder/principles.md',
    lines: [
      [' ', '## General'],
      ['-', '### descriptive-names · moderate'],
      ['+', '### descriptive-names · strong'],
      [' ', 'Name a variable for what it holds, even in a short scope.'],
    ],
  },
  {
    path: 'src/summary.ts',
    lines: [
      [' ', '  let left = 0;'],
      ['-', '  for (const t of todos) {'],
      ['-', '    if (!t.done) {'],
      ['+', '  for (const todo of todos) {'],
      ['+', '    if (!todo.done) {'],
      [' ', '      left++;'],
    ],
  },
];

const LINE_CLASS = {
  '-': 'bg-diff-removed text-diff-removed-ink',
  '+': 'bg-diff-added text-diff-added-ink',
  ' ': 'text-ink-soft',
} as const;

/** What Done leads to: one commit CodeTinder proposes, reviewed like any change. */
export const ProposalCard = ({ className }: { readonly className?: string }) => (
  <article
    // Drawn in its slot's unit, --u: 1/478 of the card's width, so the card scales as a piece.
    className={cn(
      'overflow-hidden rounded-[calc(16*var(--u))] bg-card text-ink shadow-card',
      className,
    )}
    aria-label="The commit CodeTinder proposes"
  >
    <header className="flex items-center gap-[calc(16*var(--u))] border-b border-rule px-[calc(24*var(--u))] py-[calc(22*var(--u))]">
      <span className="grid size-[calc(52*var(--u))] flex-none place-items-center rounded-full bg-petal-soft text-lipstick [&_svg]:size-[58%]">
        <CodeHeart />
      </span>
      <p className="grid gap-[calc(4*var(--u))] text-[calc(19*var(--u))]">
        <strong>Rewrite summarize your way</strong>
        <span className="flex items-center gap-[calc(8*var(--u))] text-[calc(15*var(--u))] text-ink-soft">
          <GitCommitIcon className="size-[calc(20*var(--u))] flex-none" aria-hidden="true" />
          CodeTinder <span className="rounded-pill bg-card-sunk px-[calc(8*var(--u))]">bot</span> ·{' '}
          {FILES.length} files changed
        </span>
      </p>
    </header>
    {FILES.map(({ path, lines }) => (
      <section key={path} className="[&+&]:border-t [&+&]:border-rule">
        <h4
          className={cn(
            'flex items-center gap-[calc(10*var(--u))] border-b border-rule bg-card-sunk',
            'px-[calc(24*var(--u))] py-[calc(12*var(--u))] font-mono text-[calc(15*var(--u))]',
            'font-medium text-ink-soft',
          )}
        >
          <FileTextIcon className="size-[calc(20*var(--u))] flex-none" aria-hidden="true" />
          {path}
        </h4>
        {/* Prose wraps; code keeps its lines and scrolls. */}
        <pre
          className={cn(
            'overflow-x-auto py-[calc(12*var(--u))] text-[calc(17*var(--u))] leading-[1.7]',
            '[font-variant-ligatures:none] [&>code>span]:grid',
            '[&>code>span]:grid-cols-[calc(40*var(--u))_max-content] [&>code>span]:pr-[calc(24*var(--u))]',
            path.endsWith('.md') &&
              '[&>code>span]:grid-cols-[calc(40*var(--u))_minmax(0,1fr)] [&>code>span]:whitespace-pre-wrap',
          )}
        >
          <code>
            {lines.map(([sign, text], index) => (
              <span key={`${index}${sign}`} className={LINE_CLASS[sign]}>
                <span className="text-center select-none" aria-hidden="true">
                  {sign}
                </span>
                <span>{text || ' '}</span>
              </span>
            ))}
          </code>
        </pre>
      </section>
    ))}
  </article>
);
