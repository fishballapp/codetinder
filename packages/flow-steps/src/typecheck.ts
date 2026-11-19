import {
  errorsIn,
  firstErrorIn,
  hasSourceErrors,
  isTypeScriptFile,
  type RoundAnswer,
  typecheckFiles,
  typecheckTsconfig,
} from '@codetinder/core';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import { runCollectingOutput } from './shell';

const TSC_PATH = 'node_modules/.bin/tsc';
const TYPECHECK_TSCONFIG = '.codetinder-typecheck.tsconfig.json';

/** `tsc -p <config> --showConfig` prints the config with its comments gone; only references matter. */
const ResolvedConfigSchema = Schema.Struct({
  references: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
});

/** A card with its place in the answer, 1-based: the number its typecheck file is named for. */
export type NumberedCard = { readonly number: number; readonly card: RoundAnswer['cards'][number] };

/** The cards as the answer gave them, numbered. */
export const numberCards = (cards: RoundAnswer['cards']): NumberedCard[] =>
  cards.map((card, index) => ({ number: index + 1, card }));

/** A card named in a log line by its number and its operation. */
export const cardLabel = ({ number, card }: NumberedCard) => `card ${number} (${card.operation})`;

/** A card that failed the typecheck, with tsc's errors in it. */
export type FailedCard = { readonly numbered: NumberedCard; readonly errors: readonly string[] };

/**
 * How the typecheck went: not run, unable to check the sources (`Skipped`), failing on the
 * function as written (`Rejected`: its context is incomplete or wrong), or `Checked`, each card
 * passing or failing.
 */
type Typecheck =
  | { readonly _tag: 'Unchecked'; readonly reason: string }
  | { readonly _tag: 'Skipped'; readonly reason: string }
  | { readonly _tag: 'Rejected'; readonly reason: string; readonly errors: readonly string[] }
  | {
      readonly _tag: 'Checked';
      readonly cards: readonly NumberedCard[];
      readonly failed: readonly FailedCard[];
    };

const nearestTsconfig = (
  dir: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const candidate = path.join(dir, 'tsconfig.json');
    if (yield* fs.exists(candidate).pipe(Effect.orDie)) return Option.some(candidate);
    const parent = path.dirname(dir);
    return parent === dir ? Option.none() : yield* nearestTsconfig(parent);
  });

/** The config's references. One tsc can't read has none here: the typecheck then reports it. */
const referencesOf = Effect.fn('typecheck.referencesOf')(function* (tsconfig: string) {
  const { output } = yield* runCollectingOutput(TSC_PATH, ['-p', tsconfig, '--showConfig']);
  const resolved = Schema.decodeUnknownOption(Schema.fromJsonString(ResolvedConfigSchema))(output);
  return Option.match(resolved, {
    onNone: () => [],
    onSome: ({ references }) => references ?? [],
  });
});

/**
 * The files `tsc` lists for a config. It doesn't fail a listing: a config it can't read fails the
 * typecheck itself, which reports why.
 */
const listProject = Effect.fn('typecheck.listProject')(function* (tsconfig: string) {
  const path = yield* Path.Path;
  const { output } = yield* runCollectingOutput(TSC_PATH, ['-p', tsconfig, '--listFilesOnly']);
  const files = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => path.resolve(line))
    .filter(file => !file.includes('/node_modules/'));
  return { tsconfig, files };
});

/**
 * The project the function belongs to. A solution-style root (`files: []`, `references`) inherits
 * no compiler options, so the reference that includes the function is the one to extend; without
 * one, the nearest tsconfig.
 */
const owningProject = Effect.fn('typecheck.owningProject')(function* (
  nearest: string,
  file: string,
) {
  const path = yield* Path.Path;
  const references = yield* referencesOf(nearest);
  const candidates = yield* Effect.forEach(
    references.map(({ path: referencePath }) => path.resolve(path.dirname(nearest), referencePath)),
    listProject,
    { concurrency: 'unbounded' },
  );
  const owner = candidates.find(({ files }) => files.includes(path.resolve(file)));
  if (owner !== undefined) return owner;
  return yield* listProject(nearest);
});

const unchecked = (reason: string): Typecheck => ({ _tag: 'Unchecked', reason });

/** The first line of tsc's output, which says why it couldn't check the sources. */
const firstLine = (output: string, exitCode: number): string =>
  output
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '') ?? `tsc exited with code ${exitCode}`;

/**
 * Typechecks the function as written and each card's after with the project's own compiler, from
 * files beside the function's, so its imports resolve as they do there.
 */
export const typecheck = Effect.fn('typecheck.run')(function* (answer: RoundAnswer) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!isTypeScriptFile(answer.target.file)) return unchecked('the function is not TypeScript');
  if (!(yield* fs.exists(TSC_PATH).pipe(Effect.orDie))) return unchecked(`${TSC_PATH} is missing`);
  const dir = path.dirname(answer.target.file);
  const nearest = yield* nearestTsconfig(dir);
  if (Option.isNone(nearest)) return unchecked('no tsconfig.json above the function');

  const project = yield* owningProject(nearest.value, answer.target.file);
  const ambient = project.files
    .filter(file => file.endsWith('.d.ts'))
    .map(file => path.relative(dir, file));

  const files = typecheckFiles(answer);
  const checkedFiles = [files.original, ...files.cards];
  const tsconfigPath = path.join(dir, TYPECHECK_TSCONFIG);
  const writes = [
    ...checkedFiles.map(({ name, text }) => ({ path: path.join(dir, name), text })),
    {
      path: tsconfigPath,
      text: typecheckTsconfig({
        extendsPath: path.resolve(project.tsconfig),
        files: [...checkedFiles.map(({ name }) => name), ...ambient],
      }),
    },
  ];
  const { output, exitCode } = yield* Effect.acquireUseRelease(
    Effect.forEach(writes, ({ path, text }) => fs.writeFileString(path, text).pipe(Effect.orDie), {
      concurrency: 'unbounded',
      discard: true,
    }),
    () => runCollectingOutput(TSC_PATH, ['-p', tsconfigPath]),
    () =>
      Effect.forEach(writes, ({ path }) => fs.remove(path, { force: true }).pipe(Effect.orDie), {
        concurrency: 'unbounded',
        discard: true,
      }),
  );

  const originalError = firstErrorIn(output, files.original.name);
  if (originalError !== undefined) {
    return {
      _tag: 'Rejected',
      reason: `the picked function doesn't typecheck with its context: ${originalError}`,
      errors: errorsIn(output, files.original),
    } satisfies Typecheck;
  }
  if (exitCode !== 0 && !hasSourceErrors(output)) {
    return {
      _tag: 'Skipped',
      reason: `TypeScript couldn't check the picked function: ${firstLine(output, exitCode)}`,
    } satisfies Typecheck;
  }

  const checked = files.cards.map((file, index) => ({
    numbered: { number: index + 1, card: file.card },
    errors: errorsIn(output, file),
  }));
  const failed = checked.filter(({ errors }) => errors.length > 0);
  yield* Effect.forEach(
    failed,
    ({ numbered }) => Console.error(`${cardLabel(numbered)}: typecheck failed`),
    { discard: true },
  );
  return {
    _tag: 'Checked',
    cards: checked.filter(({ errors }) => errors.length === 0).map(({ numbered }) => numbered),
    failed,
  } satisfies Typecheck;
});
