import * as Schema from 'effect/Schema';

/** Where a project's CodeTinder config lives, relative to the repo root. */
export const PROJECT_CONFIG_PATH = '.codetinder/config.json';

/** `.codetinder/config.json`: the setup MR writes every field, so no default hides in the code. */
export const ProjectConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  install: Schema.NonEmptyString.annotate({
    description: "Shell command that installs the project's dependencies, run from the repo root",
  }),
  test: Schema.NonEmptyString.annotate({
    description: "Shell command that runs the project's tests, run from the repo root",
  }),
  proposal: Schema.Literals(['merge-request', 'push']).annotate({
    description:
      "How learn delivers its change: an MR into the MR's branch, or a commit pushed onto it",
  }),
  tone: Schema.Literals(['mischievous', 'plain']).annotate({
    description: "The voice of the flow's MR notes",
  }),
});
export type ProjectConfig = typeof ProjectConfigSchema.Type;
