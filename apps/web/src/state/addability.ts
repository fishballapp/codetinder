import type { GitLabProjectSetup } from '@codetinder/gitlab';

/** Why a project can't take CodeTinder, the first that applies. */
export type AddBlock = 'ScheduledForDeletion' | 'NoAgentPlatform' | 'EmptyRepository';

/** Whether a project can take CodeTinder now: `Addable` carries the branch the setup MR targets. */
export type Addability =
  | { readonly _tag: 'Addable'; readonly defaultBranch: string }
  | { readonly _tag: 'Blocked'; readonly reason: AddBlock };

/** The facts `addability` judges, from GitLab's project and the developer's rights in it. */
export type AddabilityFacts = Pick<GitLabProjectSetup, 'isMarkedForDeletion' | 'canEnableFlow'> & {
  /** The flow is already on, so whether the user could turn it on no longer matters. */
  readonly hasFlow: boolean;
  readonly defaultBranch: string | null;
};

export const addability = ({
  isMarkedForDeletion,
  canEnableFlow,
  hasFlow,
  defaultBranch,
}: AddabilityFacts): Addability => {
  if (isMarkedForDeletion) return { _tag: 'Blocked', reason: 'ScheduledForDeletion' };
  if (!canEnableFlow && !hasFlow) return { _tag: 'Blocked', reason: 'NoAgentPlatform' };
  if (defaultBranch === null) return { _tag: 'Blocked', reason: 'EmptyRepository' };
  return { _tag: 'Addable', defaultBranch };
};
