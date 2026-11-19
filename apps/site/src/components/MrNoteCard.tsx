import { cn } from '@codetinder/ui';
import { CodeHeart, GitLabMark } from '@codetinder/ui/react';
import { DotsThreeIcon, SmileyIcon } from '@phosphor-icons/react';

/** The note CodeTinder leaves on a merge request, as it looks in GitLab. */
export const MrNoteCard = ({ className }: { readonly className?: string }) => (
  <article
    // Drawn in its slot's unit, --u: 1/500 of the card's width, so the card scales as a piece.
    className={cn(
      'overflow-hidden rounded-[calc(16*var(--u))] bg-card text-ink shadow-card',
      className,
    )}
    aria-label="CodeTinder's note on a merge request"
  >
    <header className="flex h-[calc(98*var(--u))] items-center gap-[calc(14*var(--u))] px-[calc(20*var(--u))]">
      <GitLabMark className="size-[calc(54*var(--u))] text-[#fc6d26]" />
      <p className="grid gap-[calc(4*var(--u))] text-[calc(19*var(--u))] leading-tight">
        <span className="font-semibold">
          todo-demo <span className="ml-[calc(14*var(--u))] font-medium">!12</span>
        </span>
        <span className="text-ink-soft">
          Merge request <span aria-hidden="true">·</span> summarize
        </span>
      </p>
    </header>
    <nav
      className={cn(
        'flex h-[calc(58*var(--u))] gap-[calc(44*var(--u))] border-b border-rule bg-card-sunk',
        'px-[calc(36*var(--u))] pt-[calc(18*var(--u))] text-[calc(17.5*var(--u))] text-ink-soft',
      )}
      aria-hidden="true"
    >
      <span
        className={cn(
          'relative font-semibold text-ink',
          'after:absolute after:bottom-0 after:left-[calc(-14*var(--u))] after:right-[calc(-14*var(--u))]',
          "after:h-[calc(4*var(--u))] after:rounded-pill after:bg-hot-pink after:content-['']",
        )}
      >
        Discussion
      </span>
      <span>Commits</span>
      <span>Changes</span>
    </nav>
    <div className="flex gap-[calc(20*var(--u))] px-[calc(22*var(--u))] pt-[calc(26*var(--u))]">
      <span className="grid size-[calc(58*var(--u))] flex-none place-items-center rounded-full bg-petal-soft text-lipstick [&_svg]:size-[55%]">
        <CodeHeart />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-[calc(10*var(--u))] text-[calc(17*var(--u))]">
          <strong>CodeTinder</strong>
          <span className="rounded-pill bg-card-sunk px-[calc(9*var(--u))] py-[calc(1*var(--u))] text-[calc(15*var(--u))] text-ink-soft">
            bot
          </span>
          <span className="text-[calc(15*var(--u))] text-ink-faint">1 minute ago</span>
          <DotsThreeIcon
            weight="bold"
            className="ml-auto size-[calc(22*var(--u))] text-ink-soft"
            aria-hidden="true"
          />
        </p>
        <p className="mt-[calc(14*var(--u))] text-[calc(21*var(--u))] leading-[1.6]">
          <span aria-hidden="true">💘 </span>summarize caught my eye...
          <br />
          Swipe on the round <span aria-hidden="true">→</span>
        </p>
      </div>
    </div>
    <span
      className="mt-[calc(20*var(--u))] mb-[calc(22*var(--u))] ml-[calc(27*var(--u))] grid size-[calc(44*var(--u))] place-items-center rounded-[calc(10*var(--u))] border border-rule text-ink-soft [&_svg]:size-[60%]"
      aria-hidden="true"
    >
      <SmileyIcon />
    </span>
  </article>
);
