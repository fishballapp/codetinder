import { answerJsonSchema, renderTask, type Task } from '@codetinder/core';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';

/**
 * Learn on GitLab runs on a model GitLab picks; Sonnet is the one seen in its sessions. The judge
 * is fixed, so a score moves only with the learn prompt.
 */
export const MODELS = { learn: 'claude-sonnet-5-5', judge: 'claude-sonnet-5-5' } as const;

export class ModelAnswerInvalid extends Schema.TaggedError<ModelAnswerInvalid>()(
  'ModelAnswerInvalid',
  { message: Schema.String },
) {}

export class Model extends Context.Service<
  Model,
  {
    /** The model's answer to `prompt`, shaped by `jsonSchema` but not yet decoded. */
    readonly answer: (input: {
      readonly model: string;
      readonly prompt: string;
      readonly jsonSchema: object;
    }) => Effect.Effect<unknown, ModelAnswerInvalid>;
  }
>()('@codetinder/learn-bench/Model') {
  /**
   * The `claude` CLI, signed in as the developer running the bench. No tools, settings or memory:
   * the model sees the task and nothing of this machine.
   */
  static readonly claudeCli = Layer.effect(
    Model,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const answer = Effect.fn('Model.answer')(function* ({
        model,
        prompt,
        jsonSchema,
      }: {
        readonly model: string;
        readonly prompt: string;
        readonly jsonSchema: object;
      }) {
        const command = ChildProcess.make(
          'claude',
          [
            '--print',
            '--model',
            model,
            '--effort',
            'medium',
            '--output-format',
            'json',
            '--no-session-persistence',
            '--setting-sources',
            '',
            '--tools',
            '',
            '--system-prompt',
            'Do the task you are given. Answer only with the structured output it asks for.',
            '--json-schema',
            JSON.stringify(jsonSchema),
          ],
          { stdin: { stream: Stream.make(new TextEncoder().encode(prompt)) } },
        );
        const output = yield* spawner.string(command).pipe(Effect.orDie);
        const result = yield* Schema.decodeEffect(Schema.fromJsonString(CliResultSchema))(
          output,
        ).pipe(
          Effect.mapError(
            () =>
              new ModelAnswerInvalid({ message: `unreadable CLI output: ${output.slice(0, 500)}` }),
          ),
        );
        if (result.is_error || result.structured_output === undefined) {
          return yield* new ModelAnswerInvalid({
            message: `no structured answer: ${result.result ?? 'none'}`,
          });
        }
        return result.structured_output;
      });
      return { answer };
    }),
  );
}

const CliResultSchema = Schema.Struct({
  is_error: Schema.Boolean,
  result: Schema.optional(Schema.String),
  structured_output: Schema.optional(Schema.Unknown),
});

/** A model call fails now and then, and an answer can break a check JSON Schema can't express. */
const ATTEMPTS = 3;

/**
 * Asks a task the way the flow does, its rendered text with the answer's JSON Schema, and decodes
 * the answer with the task's own schema.
 */
export const ask = Effect.fn('model.ask')(function* <A>(
  model: string,
  task: Task<Schema.Codec<A, unknown>>,
) {
  const models = yield* Model;
  // The CLI's validator knows no draft 2020-12 meta-schema; the schema itself is plain enough.
  const { $schema: _metaSchema, ...jsonSchema } = answerJsonSchema(task.answerSchema);
  return yield* models.answer({ model, prompt: renderTask(task), jsonSchema }).pipe(
    Effect.flatMap(answer =>
      Schema.decodeUnknownEffect(task.answerSchema)(answer).pipe(
        Effect.mapError(cause => new ModelAnswerInvalid({ message: cause.message })),
      ),
    ),
    Effect.retry({ schedule: Schedule.recurs(ATTEMPTS - 1) }),
  );
});
