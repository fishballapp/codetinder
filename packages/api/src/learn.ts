import * as Schema from 'effect/Schema';

/**
 * One Done's ask to learn a round's swipes, named by the server (a random UUID): the page names it
 * to tie the ask to the reply it posted, or to ask again.
 */
export const AskIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
  Schema.brand('AskId'),
);
export type AskId = typeof AskIdSchema.Type;

/**
 * Why an ask's learn run didn't finish: GitLab never started it, it started and went quiet past
 * its time, or it said it failed.
 */
export const UnfinishedReasonSchema = Schema.Literals(['NotStarted', 'Stalled', 'Failed']);
export type UnfinishedReason = typeof UnfinishedReasonSchema.Type;

/**
 * Where learning the round's swipes, as they are now, stands. `NotLearned`: no Done asked for these
 * swipes (none yet, or a swipe changed since). `Learning`: a Done asked and its run hasn't finished.
 * `Learned`: its run finished. `Unfinished`: its run didn't, so Done offers to learn again; it is
 * `isSettled` once no report can change it (the run failed, or the latest a run could still
 * report has passed). `isRetry` marks an ask a page posted again by itself, which no page posts
 * again.
 */
export const LearnStateSchema = Schema.TaggedUnion({
  NotLearned: {},
  Learning: { askId: AskIdSchema, isRetry: Schema.Boolean },
  Learned: {},
  Unfinished: {
    askId: AskIdSchema,
    isRetry: Schema.Boolean,
    reason: UnfinishedReasonSchema,
    isSettled: Schema.Boolean,
  },
});
export type LearnState = typeof LearnStateSchema.Type;

/** A Done recorded: its ask, which the page ties to the reply it posts. */
export const AskSuccessSchema = Schema.Struct({ askId: AskIdSchema });
export type AskSuccess = typeof AskSuccessSchema.Type;

/** Asking again, by itself, for an ask whose run GitLab never started. */
export const RetryLearnPayloadSchema = Schema.Struct({ askId: AskIdSchema });
export type RetryLearnPayload = typeof RetryLearnPayloadSchema.Type;

/** The reply an ask posted: its learn run names this note in its reports. */
export const AskNotePayloadSchema = Schema.Struct({ askId: AskIdSchema, noteId: Schema.Int });
export type AskNotePayload = typeof AskNotePayloadSchema.Type;

/** How a learn run is going, from the run itself. */
export const LearnReportSchema = Schema.Literals(['Started', 'Finished', 'Failed']);
export type LearnReport = typeof LearnReportSchema.Type;

/** A learn run's report, naming the reply that started it: only that ask's run applies. */
export const LearnReportPayloadSchema = Schema.Struct({
  noteId: Schema.Int,
  report: LearnReportSchema,
});
export type LearnReportPayload = typeof LearnReportPayloadSchema.Type;
