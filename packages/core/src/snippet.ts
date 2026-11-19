import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';

export const SnippetSchema = Schema.Struct({
  file: Schema.NonEmptyString.annotate({
    description: 'The file it is in, relative to the repo root',
  }),
  text: Schema.NonEmptyString.annotate({
    description:
      'Its exact text, copied verbatim from the file: whitespace and line endings included',
  }),
});
export type Snippet = typeof SnippetSchema.Type;

export const TargetSchema = Schema.Struct({
  ...SnippetSchema.fields,
  symbol: Schema.NonEmptyString.annotate({ description: "The function's name" }),
});
export type Target = typeof TargetSchema.Type;

export const ContextSnippetSchema = Schema.Struct({
  ...SnippetSchema.fields,
  symbol: Schema.NonEmptyString.annotate({ description: 'The name it defines' }),
});
export type ContextSnippet = typeof ContextSnippetSchema.Type;

export class SnippetNotFoundError extends Schema.TaggedError<SnippetNotFoundError>()(
  'SnippetNotFoundError',
  { file: Schema.String, message: Schema.String },
) {}

export class SnippetAmbiguousError extends Schema.TaggedError<SnippetAmbiguousError>()(
  'SnippetAmbiguousError',
  { file: Schema.String, message: Schema.String },
) {}

/** Where `snippet` starts in `fileText`, which must contain it exactly once. */
export const locateSnippet = (
  fileText: string,
  snippet: Snippet,
): Result.Result<number, SnippetNotFoundError | SnippetAmbiguousError> => {
  const start = fileText.indexOf(snippet.text);
  if (start === -1) {
    return Result.fail(
      new SnippetNotFoundError({ file: snippet.file, message: `not found in ${snippet.file}` }),
    );
  }
  if (fileText.indexOf(snippet.text, start + 1) !== -1) {
    return Result.fail(
      new SnippetAmbiguousError({
        file: snippet.file,
        message: `found more than once in ${snippet.file}`,
      }),
    );
  }
  return Result.succeed(start);
};

/** `fileText` with its one occurrence of `target` replaced by `replacement`, taken literally. */
export const swapSnippet = (
  fileText: string,
  target: Snippet,
  replacement: string,
): Result.Result<string, SnippetNotFoundError | SnippetAmbiguousError> =>
  Result.map(
    locateSnippet(fileText, target),
    start =>
      `${fileText.slice(0, start)}${replacement}${fileText.slice(start + target.text.length)}`,
  );
