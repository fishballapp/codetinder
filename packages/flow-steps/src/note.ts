import { oneLine } from '@codetinder/core';
import { GitLabMergeRequests } from '@codetinder/gitlab';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import { messageOf } from './user-error';

/**
 * Posts one of a round's notes on its MR as the flow's service account (the note answers who
 * that is). When the account is one of the MR's reviewers yet to review, the note is its review,
 * so it marks the review done: "re-request review" then asks for a new round on the latest code.
 * A failure to mark goes to stderr and never fails the note.
 */
export const postNote = Effect.fn('note.post')(function* ({
  projectId,
  mergeRequestIid,
  body,
}: {
  readonly projectId: string;
  readonly mergeRequestIid: number;
  readonly body: string;
}) {
  const gitlab = yield* GitLabMergeRequests;
  const { authorUsername } = yield* gitlab.createNote({ projectId, mergeRequestIid, body });
  // On stderr: stdout's last line is the step's verdict, which the flow's router reads.
  const unmarked = (failure: unknown) =>
    Console.error(`couldn't mark the review done: ${oneLine(messageOf(failure))}`);
  yield* gitlab
    .finishReview({ projectId, mergeRequestIid, reviewer: authorUsername })
    .pipe(Effect.asVoid, Effect.catch(unmarked), Effect.catchDefect(unmarked));
});
