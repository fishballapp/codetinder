import * as DateTime from 'effect/DateTime';
import * as Schema from 'effect/Schema';
import { isNotCode } from './no-code';
import { isRewritable } from './rewrite';
import { CODETINDER_BRANCH_PREFIX } from './route';

/** How many functions one sweep rewrites, so its MR stays reviewable; the rest wait for the next. */
export const SWEEP_FUNCTION_LIMIT = 20;

/** Every sweep's branch starts so; an open MR from one holds the next sweep back. */
export const SWEEP_BRANCH_PREFIX = `${CODETINDER_BRANCH_PREFIX}sweep-`;

/** A sweep's branch, named by when it ran (UTC): `codetinder/sweep-2026-10-16-093012`. */
export const sweepBranch = (nowMs: number): string => {
  const iso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
  return `${SWEEP_BRANCH_PREFIX}${iso.slice(0, 10)}-${iso.slice(11, 19).replaceAll(':', '')}`;
};

/** A file a diff changes, and how many lines it adds there. */
export type FileAdditions = { readonly path: string; readonly addedLines: number };

/**
 * The lines a sweep counts towards its threshold: those added to code files. A rewritten line is
 * one added; a deleted one leaves nothing to sweep.
 */
export const sweepLineCount = (files: Iterable<FileAdditions>): number =>
  Iterator.from(files)
    .filter(({ path }) => !isNotCode(path))
    .reduce((total, { addedLines }) => total + addedLines, 0);

/**
 * The files of `git diff --numstat -z --no-renames`: NUL-terminated `added<TAB>deleted<TAB>path`
 * entries. A binary file's counts are `-`: it adds no lines of code.
 */
export const parseNumstat = (output: string): FileAdditions[] =>
  output.split('\0').flatMap(entry => {
    const [added, , path] = entry.split('\t');
    if (added === undefined || path === undefined) return [];
    return [{ path, addedLines: added === '-' ? 0 : Number(added) }];
  });

/** A commit's first parent (`null` for a root) and the files it adds lines to against it. */
export type CommitAdditions = {
  readonly firstParent: string | null;
  readonly files: readonly FileAdditions[];
};

/** How `FIRST_SWEEP_LOG_FORMAT` starts each commit's entry. */
const COMMIT_HEADER = 'commit ';

/** `git log --format` for `parseLogNumstat`: the marker and the commit's parents. */
export const FIRST_SWEEP_LOG_FORMAT = `${COMMIT_HEADER}%P`;

/**
 * The commits of `git log --numstat -z --format=FIRST_SWEEP_LOG_FORMAT`, newest first. Each
 * commit's header ends with a NUL; its numstat entries follow, the first after a newline.
 */
export const parseLogNumstat = (output: string): CommitAdditions[] => {
  const commits: { firstParent: string | null; files: FileAdditions[] }[] = [];
  for (const entry of output.split('\0')) {
    if (entry.startsWith(COMMIT_HEADER)) {
      const [firstParent = ''] = entry.slice(COMMIT_HEADER.length).split(' ');
      commits.push({ firstParent: firstParent === '' ? null : firstParent, files: [] });
      continue;
    }
    commits.at(-1)?.files.push(...parseNumstat(entry.replace(/^\n/, '')));
  }
  return commits;
};

/**
 * One page of the walk back from `HEAD` for a first sweep's base: the commit to start it from
 * (`null`: the start of history) and the lines of code the commits after it add, or the commit to
 * read the next page from and the lines counted so far.
 */
export type FirstSweepWalk =
  | { readonly _tag: 'Base'; readonly sha: string | null; readonly lines: number }
  | { readonly _tag: 'Earlier'; readonly from: string; readonly lines: number };

/**
 * Walks `commits` (a first-parent history, newest first) summing each one's lines of code until
 * the sum reaches `threshold`: the base is the first parent of the commit that reached it. A
 * history that ends short of it is swept whole. A line added then rewritten counts twice: it is the
 * latest N lines of work, not of the code as it is now.
 */
export const walkToFirstSweepBase = ({
  commits,
  threshold,
  lines = 0,
}: {
  readonly commits: readonly CommitAdditions[];
  readonly threshold: number;
  /** The lines the pages before `commits` counted. */
  readonly lines?: number;
}): FirstSweepWalk => {
  let total = lines;
  for (const { firstParent, files } of commits) {
    total += sweepLineCount(files);
    if (total >= threshold) return { _tag: 'Base', sha: firstParent, lines: total };
  }
  const oldestParent = commits.at(-1)?.firstParent ?? null;
  if (oldestParent === null) return { _tag: 'Base', sha: null, lines: total };
  return { _tag: 'Earlier', from: oldestParent, lines: total };
};

/** Lines `start` to `end` of a file, counted from 1, both included. */
export type LineRange = { readonly start: number; readonly end: number };

/** A code file a sweep reaches, and the lines added to it since the last sweep. */
export type ChangedCode = { readonly file: string; readonly lines: readonly LineRange[] };

const FILE_START = 'diff --git ';
const NEW_PATH = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * The code files of `git diff -U0 --no-renames` and the line ranges each adds, as the file is now.
 * A deleted file, and a hunk that only deletes, add nothing. Only a file's header names its path:
 * a changed line starts with `+`, `-` or a space, so one reading `+++ b/…` is code, never a header.
 */
export const parseChangedCode = (diff: string): ChangedCode[] => {
  const files: { file: string; lines: LineRange[] }[] = [];
  let current: { file: string; lines: LineRange[] } | undefined;
  let isInHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith(FILE_START)) {
      current = undefined;
      isInHeader = true;
      continue;
    }
    const path = isInHeader ? NEW_PATH.exec(line) : null;
    if (path !== null) {
      // git ends a path that has a space with a tab; a deleted file's is /dev/null.
      const file = path[1]?.replace(/\t$/, '');
      current = file === undefined || isNotCode(file) ? undefined : { file, lines: [] };
      if (current !== undefined) files.push(current);
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk === null) continue;
    isInHeader = false;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (current !== undefined && count > 0) current.lines.push({ start, end: start + count - 1 });
  }
  return files.filter(({ lines }) => lines.length > 0);
};

/** A function the sweep agent found breaking the project's principles. */
export const SweepFindingSchema = Schema.Struct({
  file: Schema.NonEmptyString.annotate({
    description: "The function's file, relative to the repository root",
  }),
  name: Schema.NonEmptyString.annotate({
    description:
      'The function as declared: a method as Class.method; a top-level function, or the const an arrow function is assigned to, by its bare name',
  }),
  principleIds: Schema.NonEmptyArray(Schema.NonEmptyString).annotate({
    description: 'The ids of the principles it breaks, the one it breaks worst first',
  }),
  why: Schema.NonEmptyString.annotate({
    description: 'One sentence: how it breaks them, for the merge request a person reviews',
  }),
});
export type SweepFinding = typeof SweepFindingSchema.Type;

export const SweepAnswerSchema = Schema.Struct({
  functions: Schema.Array(SweepFindingSchema).annotate({
    description:
      'Every function that breaks a principle, the worst first; [] when the code follows them all',
  }),
});
export type SweepAnswer = typeof SweepAnswerSchema.Type;

/**
 * A function a sweep reaches: one it rewrites now, or one it leaves for the next. A method is
 * named `Class.method`, so two classes' methods of one name in a file stay apart.
 */
export type SweptFunction = { readonly file: string; readonly name: string };

/** How many functions a sweep carries over at most: ten sweeps' worth, the worst first. */
export const SWEEP_CARRY_OVER_LIMIT = 10 * SWEEP_FUNCTION_LIMIT;

/** `identifier` in `text` as a whole identifier, not inside a longer one. */
const hasIdentifier = (text: string, identifier: string): boolean =>
  new RegExp(`(?<![\\w$])${RegExp.escape(identifier)}(?![\\w$])`).test(text);

/** Whether `text` has the function `name`: a bare name, or a method's class and name. */
const isNamedIn = (text: string, name: string): boolean =>
  name.split('.').every(segment => segment !== '' && hasIdentifier(text, segment));

/**
 * What the next sweep takes on: the functions this one picked and didn't rewrite, judged worse,
 * then those it had no room for, at most `SWEEP_CARRY_OVER_LIMIT`.
 */
export const nextCarryOver = (
  unswept: readonly SweptFunction[],
  left: readonly SweptFunction[],
): SweptFunction[] =>
  [...unswept, ...left].slice(0, SWEEP_CARRY_OVER_LIMIT).map(({ file, name }) => ({ file, name }));

/** A finding a sweep can't take on, and why, for the agent to correct. */
export type DroppedFinding = { readonly finding: SweepFinding; readonly why: string };

/** What a sweep makes of one finding: one to take on, a fault the agent made, or a repeat. */
type Judged =
  | { readonly _tag: 'Valid'; readonly finding: SweepFinding }
  | { readonly _tag: 'Dropped'; readonly dropped: DroppedFinding }
  | { readonly _tag: 'Repeat' };

const judgeFinding = ({
  finding,
  earlier,
  files,
  principleIds,
}: {
  readonly finding: SweepFinding;
  readonly earlier: readonly SweepFinding[];
  readonly files: ReadonlyMap<string, string>;
  readonly principleIds: ReadonlySet<string>;
}): Judged => {
  const { file, name } = finding;
  const drop = (why: string): Judged => ({ _tag: 'Dropped', dropped: { finding, why } });
  const text = files.get(file);
  if (text === undefined || !isRewritable(file, new Set(files.keys()))) {
    return drop(`\`${file}\` isn't a code file this sweep reaches and may rewrite`);
  }
  if (!isNamedIn(text, name)) return drop(`\`${file}\` has no function \`${name}\``);
  const isRepeat = earlier.some(other => other.file === file && other.name === name);
  if (isRepeat) return { _tag: 'Repeat' };
  const [first, ...rest] = finding.principleIds.filter(id => principleIds.has(id));
  if (first === undefined) {
    const ids = finding.principleIds.map(id => `\`${id}\``).join(', ');
    return drop(`none of its principles (${ids}) is in the principles doc`);
  }
  return { _tag: 'Valid', finding: { ...finding, principleIds: [first, ...rest] } };
};

/**
 * The functions a sweep rewrites, the first `SWEEP_FUNCTION_LIMIT` the agent found, and those it
 * leaves for the next. A finding counts only in a file the sweep reaches (`files`: the changed code
 * and the carry-over's files that still exist, with their text) that a rewrite may change, whose
 * name the file has (a method's class too), and with a principle the doc has; once per function,
 * by its full name. Each that doesn't count, but for a repeat, is `dropped` with why.
 */
export const pickSweep = ({
  findings,
  files,
  principleIds,
}: {
  readonly findings: readonly SweepFinding[];
  readonly files: ReadonlyMap<string, string>;
  readonly principleIds: ReadonlySet<string>;
}): {
  readonly kept: readonly SweepFinding[];
  readonly left: readonly SweptFunction[];
  readonly dropped: readonly DroppedFinding[];
} => {
  const judged = findings.map((finding, index) =>
    judgeFinding({ finding, earlier: findings.slice(0, index), files, principleIds }),
  );
  const valid = judged.flatMap(judgement =>
    judgement._tag === 'Valid' ? [judgement.finding] : [],
  );
  return {
    kept: valid.slice(0, SWEEP_FUNCTION_LIMIT),
    left: nextCarryOver([], valid.slice(SWEEP_FUNCTION_LIMIT)),
    dropped: judged.flatMap(judgement => (judgement._tag === 'Dropped' ? [judgement.dropped] : [])),
  };
};

/** The sweep agent's answers, saved in the repo beside `.codetinder/task.md`; never committed. */
export const SWEEP_RUN_FILES = {
  answer: '.codetinder/sweep-answer.json',
  // Duo's `create_file_with_contents` refuses a file that exists: the correction answers to its own.
  retryAnswer: '.codetinder/sweep-retry-answer.json',
} as const;

/** What `flow-steps` keeps of a sweep for its later steps, outside the agents' reach. */
export const SWEEP_STATE_FILES = {
  // The commit the sweep counts from and the last sweep's carry-over, as `route` read them.
  sweep: '/tmp/codetinder/sweep.json',
  // The functions `sweep pick` kept for the rewrite, and those it left for the next sweep.
  picks: '/tmp/codetinder/sweep-picks.json',
  // Why `sweep pick` couldn't use the agent's answer, when it couldn't, for `sweep propose`.
  stop: '/tmp/codetinder/sweep-stop.json',
} as const;
