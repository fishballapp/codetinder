import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';

/**
 * The trigger events that start a round, by GitLab's names (`AiFlowTriggerEventType`); a
 * `mention` is a developer's `round` command.
 */
export const RoundEventSchema = Schema.Literals([
  'merge_request',
  'merge_request_ready',
  'assign_reviewer',
  'pipeline_hooks',
  'mention',
]);
export type RoundEvent = typeof RoundEventSchema.Type;

/** Which branch of the flow a run takes, read from the trigger's goal and context. */
export type Route =
  | {
      readonly _tag: 'generate';
      readonly mergeRequestIid: number;
      readonly event: Exclude<RoundEvent, 'pipeline_hooks' | 'mention'>;
    }
  | {
      readonly _tag: 'generate';
      readonly mergeRequestIid: number;
      readonly event: 'mention';
      // The mention's note: every session of this one mention names it.
      readonly noteId: number;
    }
  | {
      readonly _tag: 'generate';
      readonly mergeRequestIid: number;
      readonly event: 'pipeline_hooks';
      /** The branch the pipeline ran for: the merge request must be from it. */
      readonly branch: string;
    }
  /**
   * A pipeline on a branch with no open merge request: there is nothing to start a round on. On the
   * default branch it is the sweep's.
   */
  | { readonly _tag: 'nomergerequest'; readonly pipeline: BranchPipeline }
  | {
      readonly _tag: 'learn';
      readonly mergeRequestIid: number;
      readonly roundId: string;
      // The mention's note: the learn run answers in its thread.
      readonly noteId: number;
    };

/** A pipeline the run's context names, on a branch with no open merge request. */
export type BranchPipeline = {
  readonly branch: string;
  /** How it started: `api` for one started through the API, as the site's "Sweep now" does. */
  readonly source: string;
  /** The project's default branch, when the context names it. */
  readonly defaultBranch: string | undefined;
};

export type GenerateRoute = Extract<Route, { readonly _tag: 'generate' }>;

export class GoalError extends Schema.TaggedError<GoalError>()('GoalError', {
  message: Schema.String,
}) {}

/** What GitLab's escaping of a mention's goal (Ruby's `CGI.escapeHTML`) produces. */
const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

export const unescapeGoal = (goal: string): string =>
  goal.replace(/&(?:amp|quot|#39|lt|gt);/g, entity => HTML_ENTITIES[entity] ?? entity);

// A message body is escaped, so `</message>` inside one can only be the tag.
const MESSAGE = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
const MESSAGE_ID = /\bid="(\d+)"/;
const MERGE_REQUEST_CONTEXT = /Context: \{MergeRequest IID: (\d+)\}\s*$/;
const ISSUE_CONTEXT = /Context: \{Issue IID: \d+\}\s*$/;
// The command is the word after the handle, any case: `learn <round id>` or `round`.
const COMMAND = /@ai-codetinder-[\w.-]+\s+(?:learn\s+([\w-]+)|(round)\b)/gi;

const withoutQuotedLines = (text: string): string =>
  text
    .split('\n')
    .filter(line => !/^\s*>/.test(line))
    .join('\n');

/**
 * A message as its author wrote it, without what it only cites: fenced code, `>>>` quotes (an
 * unclosed one runs to the message's end, as GitLab renders it), `>` quoted lines and inline code.
 * Quoting a note that names a command must not run it. Indented code blocks are left in: telling
 * them from a nested list item's lines isn't worth it for a command.
 */
const ownWords = (message: string): string =>
  withoutQuotedLines(
    message.replaceAll(/^ {0,3}(```|~~~|>>>)[\s\S]*?(?:^ {0,3}\1|$(?![\s\S]))/gm, ''),
  ).replaceAll(/(`+)[\s\S]*?\1/g, '');

/**
 * What fired the run, from `DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT`: a JSON list of items, each
 * a category and its content, itself JSON.
 */
const AdditionalContextSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ Category: Schema.String, Content: Schema.String })),
);
const TriggerContextSchema = Schema.fromJsonString(Schema.Struct({ event_type: Schema.String }));
const PipelineContextSchema = Schema.fromJsonString(
  Schema.Struct({ source_branch: Schema.String, source: Schema.String }),
);
const StandardContextSchema = Schema.fromJsonString(
  Schema.Struct({ primary_branch: Schema.optional(Schema.String) }),
);
// `url` is "" when the branch has no merge request yet.
const MergeRequestContextSchema = Schema.fromJsonString(Schema.Struct({ url: Schema.String }));
const MERGE_REQUEST_URL = /\/-\/merge_requests\/(\d+)$/;

/** The content of the context's item in `category`, decoded; none when there is no such item. */
const contextItem = <S extends Schema.ConstraintDecoder<unknown>>(
  items: readonly { readonly Category: string; readonly Content: string }[],
  category: string,
  schema: S,
): Result.Result<Option.Option<S['Type']>, GoalError> => {
  const item = items.find(({ Category }) => Category === category);
  if (item === undefined) return Result.succeed(Option.none());
  return Schema.decodeUnknownResult(schema)(item.Content).pipe(
    Result.map(Option.some),
    Result.mapError(
      () => new GoalError({ message: `the run's ${category} context doesn't parse` }),
    ),
  );
};

/** A round's route, from the event the run's context names. */
const parseRoundTrigger = (
  goal: string,
  context: string | undefined,
): Result.Result<Route, GoalError> =>
  Result.gen(function* () {
    if (context === undefined) {
      return yield* Result.fail(new GoalError({ message: "the run doesn't say what started it" }));
    }
    const items = yield* Schema.decodeUnknownResult(AdditionalContextSchema)(context).pipe(
      Result.mapError(() => new GoalError({ message: "the run's context doesn't parse" })),
    );
    const trigger = yield* contextItem(
      items,
      'agent_platform_trigger_context',
      TriggerContextSchema,
    );
    const eventType = Option.getOrUndefined(trigger)?.event_type;
    const event = Schema.decodeUnknownOption(RoundEventSchema)(eventType);
    if (Option.isNone(event)) {
      return yield* Result.fail(
        new GoalError({
          message: `CodeTinder doesn't start a round on a ${eventType ?? 'nameless'} event`,
        }),
      );
    }

    // A mention on a merge request is told by its goal, so this one is on none.
    if (event.value === 'mention') {
      return yield* Result.fail(new GoalError({ message: 'the mention is on no merge request' }));
    }
    if (event.value !== 'pipeline_hooks') {
      if (!/^\d+$/.test(goal)) {
        return yield* Result.fail(
          new GoalError({ message: `a ${event.value} event's goal is not a merge request IID` }),
        );
      }
      return { _tag: 'generate', mergeRequestIid: Number(goal), event: event.value } as const;
    }

    const pipeline = yield* contextItem(items, 'pipeline', PipelineContextSchema);
    if (Option.isNone(pipeline)) {
      return yield* Result.fail(
        new GoalError({ message: "the pipeline run doesn't name its branch" }),
      );
    }
    const mergeRequest = yield* contextItem(items, 'merge_request', MergeRequestContextSchema);
    const iid = MERGE_REQUEST_URL.exec(Option.getOrUndefined(mergeRequest)?.url ?? '')?.[1];
    if (iid === undefined) {
      const standard = yield* contextItem(
        items,
        'agent_platform_standard_context',
        StandardContextSchema,
      );
      return {
        _tag: 'nomergerequest',
        pipeline: {
          branch: pipeline.value.source_branch,
          source: pipeline.value.source,
          defaultBranch: Option.getOrUndefined(standard)?.primary_branch,
        },
      } as const;
    }
    return {
      _tag: 'generate',
      mergeRequestIid: Number(iid),
      event: 'pipeline_hooks',
      branch: pipeline.value.source_branch,
    } as const;
  });

/**
 * A mention's goal is its discussion thread, escaped; the run follows the command in the thread's
 * last message, the one that mentioned the flow: `learn <round id>` learns, `round` starts a
 * round. Every other run starts a round, on the event its
 * context names: a merge request event's goal is the MR's IID, and a pipeline's MR is the one the
 * context links. A mention is told by its goal alone, so learning never depends on the context.
 */
export const parseGoal = ({
  goal,
  context,
}: {
  readonly goal: string;
  /** `DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT`, when the run has it. */
  readonly context: string | undefined;
}): Result.Result<Route, GoalError> => {
  const trimmed = goal.trim();
  if (ISSUE_CONTEXT.test(trimmed)) {
    return Result.fail(new GoalError({ message: 'CodeTinder runs on merge requests, not issues' }));
  }
  const mergeRequestIid = MERGE_REQUEST_CONTEXT.exec(trimmed)?.[1];
  if (mergeRequestIid === undefined) return parseRoundTrigger(trimmed, context);

  const [, attributes, lastMessage] = Array.from(trimmed.matchAll(MESSAGE)).at(-1) ?? [];
  const noteId = MESSAGE_ID.exec(attributes ?? '')?.[1];
  if (lastMessage === undefined || noteId === undefined) {
    return Result.fail(new GoalError({ message: "the mention's goal has no message" }));
  }

  // The last command the author wrote: an earlier one in the message is what they moved past.
  const [, roundId, round] =
    Array.from(ownWords(unescapeGoal(lastMessage)).matchAll(COMMAND)).at(-1) ?? [];
  if (round !== undefined) {
    return Result.succeed({
      _tag: 'generate',
      mergeRequestIid: Number(mergeRequestIid),
      event: 'mention',
      noteId: Number(noteId),
    });
  }
  if (roundId === undefined) {
    return Result.fail(
      new GoalError({
        message: 'the mention has no command: expected "learn <round id>" or "round"',
      }),
    );
  }
  return Result.succeed({
    _tag: 'learn',
    mergeRequestIid: Number(mergeRequestIid),
    roundId,
    noteId: Number(noteId),
  });
};

/** Every branch CodeTinder makes (setup, learn proposals, sandbox fixes, removal) starts so. */
export const CODETINDER_BRANCH_PREFIX = 'codetinder/';

/** What the route knows of a round's merge request. */
export type RoundMergeRequest = {
  readonly sourceBranch: string;
  readonly isDraft: boolean;
  readonly isOpen: boolean;
};

/**
 * Why a round's run ends at once, posting nothing, or undefined when it goes on. The word is what
 * the route prints, and matches no branch of the flow. An MR opened as a draft waits for its
 * ready event; a reviewer request or a push runs on a draft too.
 */
export const silentSkip = (
  route: GenerateRoute,
  mergeRequest: RoundMergeRequest,
): 'closed' | 'otherbranch' | 'codetinder' | 'draft' | undefined => {
  if (!mergeRequest.isOpen) return 'closed';
  if (route.event === 'pipeline_hooks' && route.branch !== mergeRequest.sourceBranch) {
    return 'otherbranch';
  }
  if (mergeRequest.sourceBranch.startsWith(CODETINDER_BRANCH_PREFIX)) return 'codetinder';
  if (route.event === 'merge_request' && mergeRequest.isDraft) return 'draft';
  return undefined;
};
