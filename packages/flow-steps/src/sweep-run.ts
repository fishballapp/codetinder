import { CommitShaSchema, SweepFunctionSchema, SweepStopCauseSchema } from '@codetinder/api';
import {
  FIRST_SWEEP_LOG_FORMAT,
  type FirstSweepWalk,
  isNotCode,
  parseLogNumstat,
  SWEEP_STATE_FILES,
  SweepFindingSchema,
  walkToFirstSweepBase,
} from '@codetinder/core';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import { git } from './shell';
import { userError } from './user-error';

/**
 * What `route` hands a sweep's later steps: the commit it counts from (`null`: the start of
 * history), and the last carry-over.
 */
const SweepRunSchema = Schema.Struct({
  base: Schema.NullOr(CommitShaSchema),
  carryOver: Schema.Array(SweepFunctionSchema),
});
export type SweepRun = typeof SweepRunSchema.Type;

/** The functions `sweep pick` kept for the rewrite, and those it left for the next sweep. */
const SweepPicksSchema = Schema.Struct({
  kept: Schema.Array(SweepFindingSchema),
  left: Schema.Array(SweepFunctionSchema),
});
export type SweepPicks = typeof SweepPicksSchema.Type;

/** Why a sweep stops short, for codetinder.dev, and in a line, for the log. */
const SweepStopSchema = Schema.Struct({ cause: SweepStopCauseSchema, reason: Schema.String });
export type SweepStop = typeof SweepStopSchema.Type;

const writeState = <S extends Schema.Codec<unknown, unknown>>(file: string, schema: S) =>
  Effect.fn('sweepRun.write')(function* (value: S['Type']) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.orDie,
    );
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.orDie);
    yield* fs.writeFileString(file, text).pipe(Effect.orDie);
  });

const readState = <S extends Schema.Codec<unknown, unknown>>(
  file: string,
  schema: S,
  what: string,
) =>
  Effect.fn('sweepRun.read')(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(error => userError(error, `the run has no ${what}: ${error.message}`)));
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(error =>
        userError(error, `the run's ${what} doesn't parse: ${error.message}`),
      ),
    );
  });

export const writeSweepRun = writeState(SWEEP_STATE_FILES.sweep, SweepRunSchema);
export const readSweepRun = readState(SWEEP_STATE_FILES.sweep, SweepRunSchema, 'sweep');
export const writeSweepPicks = writeState(SWEEP_STATE_FILES.picks, SweepPicksSchema);
export const readSweepPicks = readState(SWEEP_STATE_FILES.picks, SweepPicksSchema, 'sweep picks');
export const writeSweepStop = writeState(SWEEP_STATE_FILES.stop, SweepStopSchema);
export const readSweepStop = readState(SWEEP_STATE_FILES.stop, SweepStopSchema, 'sweep stop');

/** The empty tree, in the repo's hash: what a diff from the start of history starts from. */
const emptyTree = Effect.map(git(['hash-object', '-t', 'tree', '/dev/null']), sha => sha.trim());

/**
 * `git diff <flags> <base> HEAD` (from the empty tree when `base` is `null`), whatever the runner's
 * git config: paths unquoted, renames as a deletion and an addition, so every changed file is named
 * as it is now.
 */
export const diffSince = (base: string | null, flags: readonly string[]) =>
  Effect.flatMap(base === null ? emptyTree : Effect.succeed(base), diffBase =>
    git([
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-renames',
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      ...flags,
      diffBase,
      'HEAD',
    ]),
  );

/** The code files changed since `base` (`null`: the start of history). */
export const changedCodeFilesSince = Effect.fn('sweepRun.changedCodeFilesSince')(function* (
  base: string | null,
) {
  const names = yield* diffSince(base, ['--name-only', '-z']);
  return names.split('\0').filter(file => file !== '' && !isNotCode(file));
});

/** How many commits the walk back for a first sweep's base reads at a time. */
const WALK_PAGE_COMMITS = 100;

/**
 * Where the first sweep starts: walking back from `HEAD` along the default branch's first parents,
 * a page of commits at a time, until the lines of code they add reach the threshold (`null`: the
 * whole history, short of it).
 */
export const firstSweepBase = Effect.fn('sweepRun.firstSweepBase')(function* (threshold: number) {
  let walk: FirstSweepWalk = { _tag: 'Earlier', from: 'HEAD', lines: 0 };
  while (walk._tag === 'Earlier') {
    const log = yield* git([
      'log',
      '--first-parent',
      '--diff-merges=first-parent',
      '--no-renames',
      '--numstat',
      '-z',
      `--format=${FIRST_SWEEP_LOG_FORMAT}`,
      `--max-count=${WALK_PAGE_COMMITS}`,
      walk.from,
    ]);
    walk = walkToFirstSweepBase({ commits: parseLogNumstat(log), threshold, lines: walk.lines });
  }
  return { base: walk.sha, lines: walk.lines };
});
