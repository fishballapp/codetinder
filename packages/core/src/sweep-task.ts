import { fence } from './fence';
import { languagesOf } from './languages';
import { PRINCIPLES_PATH, type Principle, principlesFor } from './principles';
import {
  type ChangedCode,
  type LineRange,
  SWEEP_FUNCTION_LIMIT,
  SweepAnswerSchema,
  type SweepFinding,
  type SweptFunction,
} from './sweep';
import {
  REWRITE_RETRY_FIX,
  REWRITE_SAFETY_RULES,
  RewriteAnswerSchema,
  renderPrinciples,
  type Task,
} from './tasks';

const renderRange = ({ start, end }: LineRange) => (start === end ? `${start}` : `${start}-${end}`);

const renderChangedCode = (changedCode: readonly ChangedCode[]) =>
  changedCode.length === 0
    ? '(none)'
    : changedCode
        .map(({ file, lines }) => `- \`${file}\`: lines ${lines.map(renderRange).join(', ')}`)
        .join('\n');

const renderFunctions = (functions: readonly SweptFunction[]) =>
  functions.length === 0
    ? '(none)'
    : functions.map(({ file, name }) => `- \`${name}\` in \`${file}\``).join('\n');

/**
 * The sweep task: list every function in the code changed since the last sweep, and in the
 * functions the last sweep left, that breaks the project's principles. It is shown the general
 * principles and those for the languages of the files it reaches.
 */
export const sweepTask = ({
  principles,
  changedCode,
  carryOver,
}: {
  readonly principles: readonly Principle[];
  readonly changedCode: readonly ChangedCode[];
  readonly carryOver: readonly SweptFunction[];
}): Task<typeof SweepAnswerSchema> => {
  const files = [...changedCode.map(({ file }) => file), ...carryOver.map(({ file }) => file)];
  return {
    instructions: `# Sweep the changed code for functions that break the project's principles

CodeTinder keeps this project's code in line with its coding principles, learned from its
developers' swipes. The default branch is checked out. Since the last sweep, the code below has
changed; find every function in it that breaks a principle, so the worst can be rewritten.

## The principles

${renderPrinciples(principlesFor(principles, languagesOf(files)))}

## The changed code

Each code file changed since the last sweep, with the lines added or changed in it as it is now.
Read each with \`read_file\`.

${renderChangedCode(changedCode)}

## Left by the last sweep

Functions the last sweep found breaking a principle and had no room for. Check each again, even
if it hasn't changed since.

${renderFunctions(carryOver)}

## How to judge

- A function is in scope when any of its lines is a changed line above, or it is listed as left
  by the last sweep. Judge the whole function, not just the changed lines.
- A function is a top-level function, a method, or an arrow function assigned to a const. Not a
  class, a module, or a few lines inside a function. Name a method as \`Class.method\`, so two
  classes' methods of one name stay apart; a function or a const stays bare.
- It breaks a principle when the principle clearly applies to it and it doesn't follow it. Weigh a
  "strong" principle over a "tentative" one, and a General principle applies in every language, a
  language's only in that language's files.
- Leave out tests, generated code, and config: they aren't rewritten.
- List every function that breaks a principle, the worst first: the one a reviewer would most
  want fixed. Only the first ${SWEEP_FUNCTION_LIMIT} are rewritten now; the rest wait for the next
  sweep.
- Don't change any file.`,
    answerSchema: SweepAnswerSchema,
  };
};

const renderFinding = ({ file, name, principleIds, why }: SweepFinding) =>
  `- \`${name}\` in \`${file}\`: breaks ${principleIds.map(id => `\`${id}\``).join(', ')}. ${why}`;

/**
 * The sweep's rewrite task: bring exactly `functions` in line with the principles. With
 * `previousFailure`, the tail of the tests' output on the previous rewrite, it is the retry: fix
 * that rewrite, still in the working tree, rather than start over.
 */
export const sweepRewriteTask = ({
  functions,
  principles,
  previousFailure,
}: {
  readonly functions: readonly SweepFinding[];
  readonly principles: readonly Principle[];
  readonly previousFailure?: string;
}): Task<typeof RewriteAnswerSchema> => ({
  instructions: `# Rewrite ${functions.length} function(s) to follow the project's principles

The default branch is checked out. Each function below breaks the project's coding principles
(\`${PRINCIPLES_PATH}\`). Rewrite exactly these functions to follow them; a method is named as
\`Class.method\`.

## The functions

${functions.map(renderFinding).join('\n')}

## The principles

${renderPrinciples(principlesFor(principles, languagesOf(functions.map(({ file }) => file))))}
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

- Edit the files in place with your tools. Change only the functions above: no other function,
  no other file, and never tests, test or build config, manifests or lockfiles: those edits are
  undone. A helper a function extracts goes directly above it, in its file.
- Keep each function's name and signature, so its callers still work.
${REWRITE_SAFETY_RULES}
- Apply a "General" principle to every file, a language's only to that language's files.`,
  answerSchema: RewriteAnswerSchema,
});
