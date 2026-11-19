import { groupBySection, PRINCIPLES_PATH, type Principle, type Strength } from '@codetinder/core';
import { fileUrl } from '@codetinder/gitlab';
import { cn } from '@codetinder/ui';
import heartNameMe from '@codetinder/ui/plates/heart-name-me.webp';
import { CodeHeart } from '@codetinder/ui/react';
import { useAtomValue } from '@effect/atom-react';
import { ArrowSquareOutIcon, FileTextIcon, HeartIcon } from '@phosphor-icons/react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import type { ReactNode } from 'react';
import { learnedPrinciplesAtom, type ProjectWithState } from '../state/atoms';
import type { LearnedPrinciples } from '../state/learnedPrinciples';
import { leadClass } from './ProjectsLayout';

/** How many of the chip's three hearts each strength fills. */
const STRENGTH_HEARTS: Record<Strength, number> = { tentative: 1, moderate: 2, strong: 3 };

const noticeTitleClass =
  'font-display text-[1.6rem] leading-[1.1] font-bold text-balance text-candy-red text-shadow-emboss';
const noticeTextClass = 'max-w-[38ch] text-[1.05rem] text-pretty text-ink-soft';
const pathClass = 'font-mono text-[0.9em] [overflow-wrap:anywhere]';

/** A statement as written, its backticked spans in monospace as the markdown shows them. */
const Statement = ({ text }: { readonly text: string }) => (
  <p className="text-[1.15rem] leading-[1.5] text-pretty text-ink">
    {text.split(/(`[^`]+`)/).map((part, index) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
        <code key={index} className="rounded-[6px] bg-card-sunk px-[0.3em] font-mono text-[0.88em]">
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      ),
    )}
  </p>
);

/** A principle's strength as a love meter: one heart for tentative, three for strong. */
const StrengthChip = ({ strength }: { readonly strength: Strength }) => (
  <span className="inline-flex items-center gap-[0.45rem] rounded-[8px] border border-petal bg-petal-wash px-[0.55rem] py-[0.15rem] text-[0.9rem] font-semibold text-lipstick">
    <span className="flex gap-[0.1rem]" aria-hidden="true">
      {[1, 2, 3].map(heart => (
        <HeartIcon
          key={heart}
          weight={heart <= STRENGTH_HEARTS[strength] ? 'fill' : 'regular'}
          className={cn(
            'size-[0.95em]',
            heart <= STRENGTH_HEARTS[strength] ? 'text-hot-pink' : 'text-petal',
          )}
        />
      ))}
    </span>
    {strength}
  </span>
);

/** A principle's strength and id, under its statement. */
const PrincipleMeta = ({ id, strength }: { readonly id: string; readonly strength: Strength }) => (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <StrengthChip strength={strength} />
    <code className="font-mono text-[0.85rem] text-ink-faint">{id}</code>
  </div>
);

/** The doc's sections in its order, General first: each a Card Sunk strip, then its principles. */
const PrincipleSections = ({ principles }: { readonly principles: readonly Principle[] }) =>
  groupBySection(principles).map(({ section, principles }) => (
    <div key={section} className="not-first:border-t not-first:border-rule">
      <h3 className="border-b border-rule bg-card-sunk px-6 py-2 text-[0.95rem] font-semibold text-ink-soft max-sm:px-5">
        {section}
      </h3>
      <ol>
        {principles.map(({ id, strength, statement, exception }) => (
          <li
            key={id}
            className="grid gap-[0.6rem] px-6 py-5 not-first:border-t not-first:border-rule max-sm:px-5"
          >
            <Statement text={statement} />
            <PrincipleMeta id={id} strength={strength} />
            {exception && (
              <div className="mt-1 grid gap-[0.6rem] border-l-2 border-petal pl-4">
                <p className="text-[0.9rem] font-semibold text-ink-soft">Except</p>
                <Statement text={exception.statement} />
                <PrincipleMeta id={exception.id} strength={exception.strength} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  ));

/** The card's body when it has no principles to list: a fact first, centred. */
const Notice = ({
  title,
  isWaiting = false,
  children,
}: {
  readonly title: string;
  readonly isWaiting?: boolean;
  readonly children?: ReactNode;
}) => (
  <div
    className="grid justify-items-center gap-3 px-6 py-[clamp(1.75rem,5vw,2.75rem)] text-center"
    aria-busy={isWaiting}
  >
    {isWaiting && (
      <CodeHeart className="size-12 animate-beat text-lipstick motion-reduce:animate-none" />
    )}
    <h3 className={noticeTitleClass}>{title}</h3>
    {children && <p className={noticeTextClass}>{children}</p>}
  </div>
);

/** No taste yet: the "name me" candy waits to be told. */
const NothingLearned = ({ children }: { readonly children: ReactNode }) => (
  <div className="grid justify-items-center gap-3 px-6 py-[clamp(1.75rem,5vw,2.75rem)] text-center">
    <img
      className="w-[clamp(6.5rem,16vw,8.5rem)] animate-float motion-reduce:animate-none"
      src={heartNameMe}
      width={480}
      height={480}
      alt=""
    />
    <h3 className={noticeTitleClass}>Nothing learned yet</h3>
    <p className={noticeTextClass}>{children}</p>
  </div>
);

const LearnedBody = ({
  learned,
  defaultBranch,
}: {
  readonly learned: LearnedPrinciples;
  readonly defaultBranch: string | null;
}) => {
  const path = <code className={pathClass}>{PRINCIPLES_PATH}</code>;
  switch (learned._tag) {
    case 'Learned':
      if (learned.principles.length > 0) {
        return <PrincipleSections principles={learned.principles} />;
      }
      return (
        <NothingLearned>
          The doc has no principles yet. Swipe a round on your next merge request and what you like
          lands here. Your type, in writing 💘
        </NothingLearned>
      );
    case 'Missing':
      return (
        <NothingLearned>
          There's no {path}
          {defaultBranch && ` on ${defaultBranch}`} yet. It arrives with the setup MR; once that's
          merged, every round you swipe adds to it.
        </NothingLearned>
      );
    case 'Unreadable':
      return learned.reason === 'other-format' ? (
        <Notice title="In a format of its own">
          The doc isn't in the format CodeTinder writes, so it can't be listed here. The next learn
          run rewrites it in that format. Until then, it's all there on GitLab.
        </Notice>
      ) : (
        <Notice title="Written by a newer CodeTinder">
          The doc is in a newer format than this page reads. It's all there on GitLab.
        </Notice>
      );
  }
};

/** The doc's strip under the card: its path, and the file on GitLab once there is one. */
const DocFooter = ({
  project,
  learned,
}: {
  readonly project: ProjectWithState;
  readonly learned: LearnedPrinciples;
}) => (
  <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule bg-card-sunk px-6 py-3 text-[0.95rem] text-ink-soft max-sm:px-5">
    <span className="flex min-w-0 items-center gap-2">
      <FileTextIcon className="size-[1.1em] flex-none" aria-hidden="true" />
      <code className={pathClass}>{PRINCIPLES_PATH}</code>
    </span>
    {learned._tag !== 'Missing' && project.defaultBranch !== null && (
      <a
        className="ml-auto inline-flex items-center gap-[0.35rem] font-semibold text-wine hover:text-lipstick hover:underline hover:underline-offset-[0.2em]"
        href={fileUrl({
          projectFullPath: project.fullPath,
          ref: project.defaultBranch,
          path: PRINCIPLES_PATH,
        })}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${PRINCIPLES_PATH} on GitLab`}
      >
        Open on GitLab
        <ArrowSquareOutIcon className="flex-none" aria-hidden="true" />
      </a>
    )}
  </footer>
);

/** What CodeTinder has learned in a project: its principles doc, read off the default branch. */
export const LearnedPrinciplesSection = ({ project }: { readonly project: ProjectWithState }) => (
  <section className="mt-[clamp(2.5rem,7vw,4rem)]" aria-labelledby="taste-title">
    <h2
      id="taste-title"
      className="font-display text-[clamp(1.75rem,1.3rem_+_1.2vw,2.5rem)] leading-[1.1] font-bold text-balance text-candy-red text-shadow-emboss"
    >
      Your taste so far
    </h2>
    <p className={leadClass}>
      Learned from your swipes and kept in the repo, where every coding agent reads it.
    </p>
    <article className="overflow-hidden rounded-[16px] bg-card shadow-lift">
      {AsyncResult.builder(useAtomValue(learnedPrinciplesAtom(project.id)))
        .onInitial(() => <Notice title="Reading your principles…" isWaiting />)
        .onSuccess(learned => (
          <>
            <LearnedBody learned={learned} defaultBranch={project.defaultBranch} />
            <DocFooter project={project} learned={learned} />
          </>
        ))
        .onFailure(() => (
          <Notice title="Couldn't read your principles">
            GitLab didn't answer this time. Reload to try again.
          </Notice>
        ))
        .render()}
    </article>
  </section>
);
