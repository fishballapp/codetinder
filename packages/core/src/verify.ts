import { buildTypecheckFile, type RoundAnswer } from './round';

/** A message as one line, for a verdict, a note, or a userError. */
export const oneLine = (message: string): string => message.replaceAll(/\s+/g, ' ').trim();

/** How `flow-steps verify` ended; both kinds of ending are expected, so the flow reads which. */
export type VerifyOutcome =
  | { readonly _tag: 'Verified' }
  | { readonly _tag: 'Skipped'; readonly reason: string }
  | { readonly _tag: 'Failed'; readonly reason: string };

export const verified: VerifyOutcome = { _tag: 'Verified' };
export const skipped = (reason: string): VerifyOutcome => ({ _tag: 'Skipped', reason });
export const failed = (reason: string): VerifyOutcome => ({ _tag: 'Failed', reason });

/** The last stdout line, which the flow matches: a step's exit code is invisible to it. */
export const formatVerdict = (outcome: VerifyOutcome): string => {
  if (outcome._tag === 'Verified') return 'verified';
  if (outcome._tag === 'Skipped') return `skipped: ${oneLine(outcome.reason)}`;
  return `failed: ${oneLine(outcome.reason)}`;
};

/** A path the working tree changes, and whether git tracks it. */
export type WorkingTreeChange = { readonly path: string; readonly isUntracked: boolean };

/**
 * The changes `git status --porcelain=v1 -z` reports: NUL-terminated `XY path` entries, where a
 * rename or copy is followed by its source path, itself a change. `-z` leaves paths unquoted.
 */
export const parsePorcelainStatus = (output: string): WorkingTreeChange[] => {
  const fields = output.split('\0');
  const changes: WorkingTreeChange[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry === undefined || entry === '') continue;
    const status = entry.slice(0, 2);
    changes.push({ path: entry.slice(3), isUntracked: status === '??' });
    if (!/[RC]/.test(status)) continue;
    index += 1;
    const source = fields[index];
    if (source !== undefined && source !== '') changes.push({ path: source, isUntracked: false });
  }
  return changes;
};

export const isTypeScriptFile = (file: string): boolean => /\.(ts|tsx|mts|cts)$/.test(file);

export type TypecheckFile = { readonly name: string; readonly text: string };

/**
 * The files `verify` typechecks beside the picked function's file: the function as written, and
 * each card's after in its place, each with the round's imports and context.
 */
export const typecheckFiles = ({ target, imports, context, cards }: RoundAnswer) => {
  const extension = target.file.endsWith('.tsx') ? '.tsx' : '.ts';
  const file = (name: string, functionText: string): TypecheckFile => ({
    name: `.codetinder-typecheck-${name}${extension}`,
    text: buildTypecheckFile({ imports, context, functionText }),
  });
  return {
    original: file('original', target.text),
    cards: cards.map((card, index) => ({
      card,
      ...file(`card-${index + 1}`, card.after),
    })),
  };
};

/**
 * A tsconfig that checks only `files` under the project's own settings. Each file stands alone:
 * `moduleDetection: force` keeps files that declare the same function apart, and the function is
 * unused there, so the unused checks are off. Nothing is emitted, so the emit and build options the
 * project inherits are reset: `tsc` refuses a config that sets one of them without its partners.
 */
export const typecheckTsconfig = ({
  extendsPath,
  files,
}: {
  extendsPath: string;
  files: readonly string[];
}): string =>
  JSON.stringify({
    extends: extendsPath,
    compilerOptions: {
      noEmit: true,
      composite: false,
      declaration: false,
      declarationDir: null,
      declarationMap: false,
      emitDeclarationOnly: false,
      incremental: false,
      isolatedDeclarations: false,
      // Nothing is emitted, so no source file can fall outside the root: imports from anywhere in
      // the repo are fine.
      rootDir: '/',
      moduleDetection: 'force',
      noUnusedLocals: false,
      noUnusedParameters: false,
    },
    files,
    include: [],
  });

/** An error tsc reports in a source file, as `path(line,col): error …`; `message` is after it. */
const SOURCE_ERROR = /^(.+\.[cm]?[jt]sx?)\((\d+),\d+\): (error .*)$/;

type SourceError = {
  readonly file: string;
  readonly line: number;
  readonly message: string;
  /** The indented lines under it, which say what in a type didn't match. */
  readonly details: readonly string[];
};

/** tsc's output in diagnostics: each line that starts one, with the indented lines continuing it. */
const diagnostics = (tscOutput: string): string[][] =>
  tscOutput.split('\n').reduce<string[][]>((blocks, outputLine) => {
    const current = blocks.at(-1);
    if (current === undefined || !/^\s+\S/.test(outputLine)) return [...blocks, [outputLine]];
    current.push(outputLine);
    return blocks;
  }, []);

const sourceErrors = (tscOutput: string): SourceError[] =>
  diagnostics(tscOutput).flatMap(([head = '', ...details]) => {
    const [, file, line, message] = SOURCE_ERROR.exec(head) ?? [];
    return file === undefined || line === undefined || message === undefined
      ? []
      : [{ file, line: Number(line), message, details }];
  });

/**
 * Whether tsc reported an error in a source file. Without one, tsc didn't check the sources: a
 * config it can't read is reported in the tsconfig, not in a source file.
 */
export const hasSourceErrors = (tscOutput: string): boolean => sourceErrors(tscOutput).length > 0;

const isNamedFile = (file: string, name: string) => file === name || file.endsWith(`/${name}`);

/** The first error tsc reported in the file `name`, without its location. */
export const firstErrorIn = (tscOutput: string, name: string): string | undefined =>
  sourceErrors(tscOutput).find(({ file }) => isNamedFile(file, name))?.message;

/**
 * Every error tsc reported in `file`, whole, each with the line it is on: the agent never sees the
 * file CodeTinder checks, only what it gave to build it.
 */
export const errorsIn = (tscOutput: string, { name, text }: TypecheckFile): string[] => {
  const lines = text.split('\n');
  return sourceErrors(tscOutput)
    .filter(({ file }) => isNamedFile(file, name))
    .map(({ line, message, details }) =>
      [message, ...details, `  at: ${lines[line - 1]?.trim() ?? ''}`].join('\n'),
    );
};
