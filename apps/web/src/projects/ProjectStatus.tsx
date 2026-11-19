import { cn, pillVariants } from '@codetinder/ui';
import { ArrowSquareOutIcon, HeartBreakIcon, HeartIcon } from '@phosphor-icons/react';
import type { ProjectWithState } from '../state/atoms';
import type { ProjectState } from '../state/projectState';

const actionClass = cn(
  pillVariants(),
  'px-5 py-[0.65rem] text-[0.95rem] whitespace-nowrap max-sm:justify-self-start',
);

/** What a project asks of the developer: its call to action, or Remove from its page's menu. */
export type ProjectAction =
  | { readonly kind: 'finish'; readonly project: ProjectWithState }
  | { readonly kind: 'remove'; readonly project: ProjectWithState }
  | {
      readonly kind: 'update';
      readonly project: ProjectWithState;
      readonly consumerId: string;
      readonly version: string | null;
      readonly updateTo: string;
    };

/** Whether a project still has CodeTinder to take off: Removing is finished by its MR, not by Remove. */
export const isRemovable = (state: ProjectState) =>
  state._tag === 'Live' || state._tag === 'SetupOpen' || state._tag === 'Unfinished';

const unfinishedText = ({
  needsFlow,
  needsSetupMergeRequest,
}: Extract<ProjectState, { _tag: 'Unfinished' }>) => {
  if (needsFlow && needsSetupMergeRequest) return "Setup didn't finish.";
  if (needsFlow) return 'The codetinder flow is off, so nothing swipes.';
  return 'Its setup MR closed before anyone merged it.';
};

// The tone colours the status's heart mark (its direct svg child); a stuck line reads in wine.
const statusOf = (state: ProjectState) => {
  switch (state._tag) {
    case 'Live':
      return {
        tone: '[&>svg]:text-hot-pink',
        text: 'Swiping on your merge requests',
        detail: state.version === null ? null : `version ${state.version}`,
      };
    case 'SetupOpen':
      return {
        tone: '[&>svg]:text-petal',
        text: 'Waiting on its setup MR. Merge it and the swiping starts.',
        detail: null,
      };
    case 'Removing':
      return {
        tone: '[&>svg]:text-petal',
        text: `Removing. Merge !${state.removalMergeRequest.iid} to finish.`,
        detail: null,
      };
    case 'Unfinished':
      return {
        tone: 'font-semibold text-wine [&>svg]:text-lipstick',
        text: unfinishedText(state),
        detail: null,
      };
    case 'NotAdded':
      return {
        tone: 'font-semibold text-wine [&>svg]:text-lipstick',
        text: 'Not added yet',
        detail: null,
      };
  }
};

/** Where CodeTinder stands in a project, led by a heart: whole when live, broken when stuck. */
export const ProjectStatus = ({
  state,
  className,
}: {
  readonly state: ProjectState;
  readonly className?: string;
}) => {
  const status = statusOf(state);
  return (
    <p
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] items-start gap-[0.45rem] text-[1rem] text-ink-soft',
        status.tone,
        className,
      )}
    >
      {state._tag === 'Unfinished' ? (
        <HeartBreakIcon className="h-[1lh] w-4" aria-hidden="true" />
      ) : (
        <HeartIcon className="h-[1lh] w-4" weight="fill" aria-hidden="true" />
      )}
      <span>
        {status.text}
        {status.detail && (
          <span className="ml-[0.45rem] whitespace-nowrap text-[0.9rem] tabular-nums text-ink-faint before:mr-[0.45rem] before:content-['·']">
            {status.detail}
          </span>
        )}
      </span>
    </p>
  );
};

/** The one thing a project needs next, as a pill; nothing when it needs nothing. */
export const ProjectCallToAction = ({
  project,
  onAction,
}: {
  readonly project: ProjectWithState;
  readonly onAction: (action: ProjectAction) => void;
}) => {
  const { state } = project;
  if (state._tag === 'Live' && state.updateTo !== null) {
    const { consumerId, version, updateTo } = state;
    return (
      <button
        type="button"
        className={actionClass}
        onClick={() => onAction({ kind: 'update', project, consumerId, version, updateTo })}
      >
        Update to {updateTo}
      </button>
    );
  }
  if (state._tag === 'SetupOpen') {
    return (
      <a className={actionClass} href={state.setupMergeRequestUrl} target="_blank" rel="noreferrer">
        Review setup MR
        <ArrowSquareOutIcon aria-hidden="true" />
      </a>
    );
  }
  if (state._tag === 'Removing') {
    return (
      <a
        className={actionClass}
        href={state.removalMergeRequest.url}
        target="_blank"
        rel="noreferrer"
      >
        Review removal MR
        <ArrowSquareOutIcon aria-hidden="true" />
      </a>
    );
  }
  if (state._tag === 'Unfinished') {
    return (
      <button
        type="button"
        className={actionClass}
        onClick={() => onAction({ kind: 'finish', project })}
      >
        Finish setup
      </button>
    );
  }
  return null;
};
