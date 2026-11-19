import * as JsonSchema from 'effect/JsonSchema';
import * as Schema from 'effect/Schema';
import { fence } from './fence';
import { languagesOf } from './languages';
import { groupBySection, type Principle, principlesFor } from './principles';

/** The flow's LLM steps; `flow-steps task <step>` prints each one's task. */
export const TaskStepSchema = Schema.Literals([
  'generate',
  'generate-retry',
  'learn',
  'rewrite',
  'rewrite-retry',
  'sweep',
  'sweep-retry',
  'sweep-rewrite',
  'sweep-rewrite-retry',
]);
export type TaskStep = typeof TaskStepSchema.Type;

/** What the agent is asked, and the schema its answer is decoded with. */
export type Task<S extends Schema.Top> = { instructions: string; answerSchema: S };

/** The JSON Schema of a task's answer, as the agent reads it. */
export const answerJsonSchema = (answerSchema: Schema.Top) => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(answerSchema);
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    ...schema,
    ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
  };
};

/** The instructions, then the answer's JSON Schema, which the agent reads as part of them. */
export const renderTask = ({ instructions, answerSchema }: Task<Schema.Top>): string =>
  `${instructions}\n\n## Answer\n\nOne JSON document matching this JSON Schema:\n\n${JSON.stringify(answerJsonSchema(answerSchema), null, 2)}\n`;

export const renderPrinciples = (principles: readonly Principle[]) =>
  principles.length === 0
    ? '(none yet)'
    : groupBySection(principles)
        .map(
          ({ section, principles }) =>
            `### ${section}\n\n${principles
              .flatMap(({ id, strength, statement, exception }) => [
                `- ${id} (${strength}): ${statement}`,
                ...(exception === undefined
                  ? []
                  : [
                      `  - except, ${exception.id} (${exception.strength}): ${exception.statement}`,
                    ]),
              ])
              .join('\n')}`,
        )
        .join('\n\n');

export const RewriteAnswerSchema = Schema.Struct({
  summary: Schema.NonEmptyString.annotate({
    description:
      'What the code changes are and why, in one or two sentences, for the merge request note. Never whether tests or checks ran or passed: CodeTinder runs them after you and reports them itself',
  }),
  appliedPrincipleIds: Schema.Array(Schema.NonEmptyString).annotate({
    description: 'The ids of the principles the rewrite applied',
  }),
});
export type RewriteAnswer = typeof RewriteAnswerSchema.Type;

/**
 * What every rewrite must hold to, whatever it rewrites: change only what the principles call for,
 * keep the project compiling, and find every use of a symbol by reading before removing it. The
 * tests can't be the only check: a runner that strips types passes over a broken build, and a diff
 * or a grep's ranked snippets don't show every use of a name.
 */
export const REWRITE_SAFETY_RULES = `- Change only what the principles call for. No unrelated tidying: don't remove an import,
  variable or function you think is unused, and don't rename, reorder or reformat what no principle
  covers.
- Every edit must leave the project compiling and its behaviour exactly as it was. The project's
  tests are run on the result and a failure discards it, but they can miss a type or build error.
- Before you remove, rename or change the signature of anything (an import, a variable, a function,
  a type), find every use yourself: read the whole file with \`read_file\`, and the other files
  that use it. \`grep\` results are ranked snippets that leave matches out: they can show a use,
  never prove there is none. A diff shows only what changed, not what still uses a name. If you
  can't confirm every use, leave it as it is.
- When you are done, read each file you edited again and check that every name it uses is still
  imported or defined.
- Your summary describes only the code changes you made and why. Never say whether tests, the
  typecheck or any other check ran or passed: you can't run them, and CodeTinder runs them itself
  and reports the result in the merge request note.`;

/** The retry's closing line: what to do with a rewrite whose check failed. */
export const REWRITE_RETRY_FIX =
  'Fix the rewrite so the tests pass, or undo the part of it that broke the build or changed behaviour, keeping to the principles everywhere else.';

/**
 * The rewrite task. With `previousFailure`, the tail of the tests' output on the previous rewrite,
 * it is the retry: fix that rewrite, still in the working tree, rather than start over. It is shown
 * only the general principles and those for the languages of `mergeRequestFiles`.
 */
export const rewriteTask = ({
  mergeRequestIid,
  diff,
  mergeRequestFiles,
  principles,
  previousFailure,
}: {
  mergeRequestIid: number;
  diff: string;
  mergeRequestFiles: readonly string[];
  principles: readonly Principle[];
  previousFailure?: string;
}): Task<typeof RewriteAnswerSchema> => ({
  instructions: `# Rewrite merge request !${mergeRequestIid} in the project's style

The merge request's source branch is checked out. Rewrite the code it adds or changes (the diff is
below) to follow the project's coding principles.

## The diff

${fence(diff)}

## The principles

${renderPrinciples(principlesFor(principles, languagesOf(mergeRequestFiles)))}
${
  previousFailure === undefined
    ? ''
    : `
## The previous rewrite failed the tests

The previous rewrite is still in the working tree, as it was left, and the project's tests failed
on it. The end of their output:

${fence(previousFailure)}

${REWRITE_RETRY_FIX}
`
}
## How to rewrite

- Edit the files in place with your tools. Touch only code the merge request adds or changes,
  and never tests, test or build config, manifests or lockfiles: those edits are undone.
${REWRITE_SAFETY_RULES}
- Apply a "General" principle to every file, a language's only to that language's files.
- Apply a "strong" principle wherever it fits, a "tentative" one only where it clearly helps.`,
  answerSchema: RewriteAnswerSchema,
});
