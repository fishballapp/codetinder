import type { GitLabDiscussion } from '@codetinder/gitlab';

/** CodeTinder's flow posts as its service account, `ai-codetinder-<group>`. */
const SERVICE_ACCOUNT = /^ai-codetinder-[\w.-]+$/;

/**
 * The thread CodeTinder's note about a round started on its MR, and the service account that
 * posted it: the oldest discussion whose first note is the flow's and links the round.
 */
export const findRoundThread = (
  discussions: readonly GitLabDiscussion[],
  roundId: string,
): { readonly discussionId: string; readonly serviceAccount: string } | undefined => {
  const thread = discussions.find(({ notes: [first] }) => {
    if (first === undefined || first.isSystem) return false;
    return SERVICE_ACCOUNT.test(first.authorUsername) && first.body.includes(`/rounds/${roundId}`);
  });
  const first = thread?.notes[0];
  if (thread === undefined || first === undefined) return undefined;
  return { discussionId: thread.id, serviceAccount: first.authorUsername };
};
