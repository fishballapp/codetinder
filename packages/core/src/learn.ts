import type { WrittenRuleUpdate } from './agent-instructions';
import type { SkippedOperation } from './learn-operations';
import { type Principle, type Rule, rulesOf, type Strength, StrengthSchema } from './principles';
import type { EnvironmentFailure } from './sandbox-diagnosis';
import type { SandboxFixMergeRequest } from './sandbox-fix';

/**
 * The learn agent's answer, saved in the repo beside `.codetinder/task.md`: Duo's file tools only
 * write there. It is never committed.
 */
export const LEARN_RUN_FILES = {
  principlesAnswer: '.codetinder/principles-answer.json',
} as const;

/**
 * What `flow-steps` keeps for learn's later steps, outside the repo, where the rewrite agent's file
 * tools can't reach it.
 */
export const LEARN_STATE_FILES = {
  // What `render` learned from the answer (`LearnedSchema`), which `propose` commits.
  principles: '/tmp/codetinder/principles.json',
  // The cards the learn task showed, with their swipes (`CitationsSchema`): what a narrow may cite.
  citations: '/tmp/codetinder/learn-citations.json',
} as const;

/**
 * How one principle or exception moved between the doc as it was and the doc the learn step wrote.
 * A new exception is its principle narrowed.
 */
export type PrincipleChange =
  | { readonly _tag: 'Added'; readonly principle: Rule }
  | { readonly _tag: 'Narrowed'; readonly principle: Rule; readonly exception: Rule }
  | { readonly _tag: 'Strengthened'; readonly principle: Rule }
  | { readonly _tag: 'Weakened'; readonly principle: Rule }
  | { readonly _tag: 'Moved'; readonly principle: Rule }
  | { readonly _tag: 'Reworded'; readonly principle: Rule }
  | { readonly _tag: 'Dropped'; readonly principle: Rule };

const rank = (strength: Strength) => StrengthSchema.literals.indexOf(strength);

/** The changes from `before` to `after`, in `after`'s order, then the dropped ones. */
export const diffPrinciples = (
  before: readonly Principle[],
  after: readonly Principle[],
): PrincipleChange[] => {
  const beforeRules = rulesOf(before);
  const afterRules = rulesOf(after);
  const changed = afterRules.flatMap((rule): PrincipleChange[] => {
    const old = beforeRules.find(({ id }) => id === rule.id);
    if (old === undefined) {
      const parent = afterRules.find(({ id }) => id === rule.parentId);
      return [
        parent === undefined
          ? { _tag: 'Added', principle: rule }
          : { _tag: 'Narrowed', principle: parent, exception: rule },
      ];
    }
    // A new strength outranks a rewording; a move is named beside either.
    const change = (() => {
      if (rank(rule.strength) > rank(old.strength)) return 'Strengthened' as const;
      if (rank(rule.strength) < rank(old.strength)) return 'Weakened' as const;
      if (rule.statement !== old.statement) return 'Reworded' as const;
      return undefined;
    })();
    // An exception moves with its principle, which names the move.
    const isMoved = rule.parentId === undefined && rule.section !== old.section;
    return [
      ...(change === undefined ? [] : [{ _tag: change, principle: rule }]),
      ...(isMoved ? [{ _tag: 'Moved' as const, principle: rule }] : []),
    ];
  });
  const dropped = beforeRules
    .filter(({ id }) => !afterRules.some(rule => rule.id === id))
    .map((principle): PrincipleChange => ({ _tag: 'Dropped', principle }));
  return [...changed, ...dropped];
};

/** What the learn run did to the principles doc. */
export type PrinciplesUpdate =
  | { readonly _tag: 'Learned'; readonly changes: readonly PrincipleChange[] }
  // The doc was ours but not as render writes it (an older format, or edited by hand), so the run
  // rewrote it in the current one too.
  | { readonly _tag: 'Reformatted'; readonly changes: readonly PrincipleChange[] }
  // The doc was edited out of CodeTinder's format, so the agent converted it back as it learned.
  | { readonly _tag: 'Converted'; readonly principles: readonly Principle[] };

/** What happened to the rewrite of the merge request's code. */
export type RewriteOutcome =
  | {
      readonly _tag: 'Applied';
      readonly summary: string;
      readonly files: readonly string[];
      /** The project's test command, which passed on the rewrite. */
      readonly testCommand: string;
    }
  // The code already follows the principles, or the agent changed nothing.
  | { readonly _tag: 'Unchanged' }
  // Failed the tests twice, or never came: the principles are proposed without it. When the
  // install or the tests failed before any change too, the sandbox is to blame, and says why.
  | {
      readonly _tag: 'Dropped';
      readonly reason: string;
      readonly environment?: EnvironmentFailure;
      /** The MR fixing the sandbox for `environment`'s failure, when CodeTinder proposed one. */
      readonly sandboxFix?: SandboxFixMergeRequest;
    };

/** Where the proposal landed. */
export type Delivery =
  | { readonly _tag: 'MergeRequest'; readonly iid: number }
  | { readonly _tag: 'Pushed'; readonly commitUrl: string }
  // `push` was configured, but GitLab refused it: a file changed since the run read it, say.
  | { readonly _tag: 'MergeRequestInsteadOfPush'; readonly iid: number };

/** How a learn run ended; its note says so. */
export type LearnOutcome =
  | {
      readonly _tag: 'Proposed';
      readonly principles: PrinciplesUpdate;
      readonly skipped: readonly SkippedOperation[];
      readonly writtenRules: readonly WrittenRuleUpdate[];
      readonly rewrite: RewriteOutcome;
      readonly delivery: Delivery;
    }
  // The swipes confirmed the principles as they are, and the code already follows them.
  // Either way, the note names any written rule an edit couldn't change.
  // The swipes confirmed the principles, and the rewrite changed nothing: the code already follows
  // them, or the rewrite was dropped (a sandbox failure's fix MR included).
  | {
      readonly _tag: 'NothingToPropose';
      readonly skipped: readonly SkippedOperation[];
      readonly writtenRules: readonly WrittenRuleUpdate[];
      readonly rewrite: Exclude<RewriteOutcome, { readonly _tag: 'Applied' }>;
    }
  | {
      readonly _tag: 'Failed';
      readonly reason: string;
      readonly writtenRules: readonly WrittenRuleUpdate[];
    };
