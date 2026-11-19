import {
  GitLabCommits,
  GitLabFiles,
  type GitLabMergeRequests,
  GitLabSetup,
} from '@codetinder/gitlab';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

/** For tests: a project with no sandbox fix MRs, open or closed. */
export const noSandboxFixMergeRequests: Pick<
  GitLabMergeRequests['Service'],
  'list' | 'updateDescription'
> = {
  list: () => Effect.succeed([]),
  updateDescription: () => Effect.die('not used by this test'),
};

/** For tests: GitLab's repository API, which a test that proposes no sandbox fix never reaches. */
export const repositoryUnused = Layer.mergeAll(
  Layer.succeed(
    GitLabSetup,
    GitLabSetup.of({
      defaultBranch: () => Effect.die('not used by this test'),
      branchHead: () => Effect.die('not used by this test'),
      rootFileNames: () => Effect.die('not used by this test'),
      openSetupMergeRequest: () => Effect.die('not used by this test'),
    }),
  ),
  Layer.succeed(
    GitLabFiles,
    GitLabFiles.of({
      readText: () => Effect.die('not used by this test'),
      readRevision: () => Effect.die('not used by this test'),
    }),
  ),
);

/** For tests: commits, which a test that delivers nothing never makes. */
export const commitsUnused = Layer.succeed(
  GitLabCommits,
  GitLabCommits.of({ commit: () => Effect.die('not used by this test') }),
);
