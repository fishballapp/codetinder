#!/usr/bin/env node
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Console from 'effect/Console';
import * as CliConfig from 'effect/cli/CliConfig';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as GlobalFlag from 'effect/cli/GlobalFlag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import { type Dataset, DatasetJsonSchema, fetchDataset } from './dataset';
import { LearnerSchema } from './learners';
import { Model } from './model';
import { DeveloperSchema, type RunRecord, RunRecordJsonSchema } from './record';
import { replay } from './replay';
import { renderReport } from './report';
import { SimulatedVerdictsJsonSchema, simulateVerdicts } from './simulated';

/** This repo's project on GitLab, whose rounds are the bench's data by default. */
const CODETINDER_PROJECT_ID = '87426993';

/** Replays at once: each runs its rounds in order, so they are what runs side by side. */
const REPLAY_CONCURRENCY = 4;

const projectFlag = Flag.String('project').pipe(
  Flag.withDefault(CODETINDER_PROJECT_ID),
  Flag.withDescription('The GitLab project id whose rounds to use'),
);

/** The repo's gitignored `tmp/`, wherever the command runs from. */
const benchDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, '../../../tmp/learn-bench');
});

const datasetPath = (projectId: string) =>
  Effect.map(benchDir, dir => `${dir}/dataset-${projectId}.json`);

const fetchCommand = Command.make('fetch', { project: projectFlag }, ({ project }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataset = yield* fetchDataset(project);
    const file = yield* datasetPath(project);
    yield* fs.makeDirectory(yield* benchDir, { recursive: true });
    yield* fs.writeFileString(file, yield* Schema.encodeEffect(DatasetJsonSchema)(dataset));
    yield* Console.log(`wrote ${dataset.rounds.length} judged rounds to ${file}`);
  }).pipe(Effect.orDie, Effect.provide(FetchHttpClient.layer)),
).pipe(
  Command.withDescription(
    "Read a project's judged rounds from codetinder.dev's Firestore, with GOOGLE_ACCESS_TOKEN",
  ),
);

/** The simulated developer's swipes, asked of the oracle once and kept for every later run. */
const loadSimulated = Effect.fn('main.loadSimulated')(function* (
  projectId: string,
  dataset: Dataset,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${yield* benchDir}/simulated-${projectId}.json`;
  if (yield* fs.exists(file)) {
    return yield* Schema.decodeEffect(SimulatedVerdictsJsonSchema)(yield* fs.readFileString(file));
  }
  const simulated = yield* simulateVerdicts(dataset);
  yield* fs.writeFileString(
    file,
    yield* Schema.encodeEffect(SimulatedVerdictsJsonSchema)(simulated),
  );
  return simulated;
});

const readRecords = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${yield* benchDir}/results`;
  if (!(yield* fs.exists(dir))) return [];
  const files = (yield* fs.readDirectory(dir)).filter(file => file.endsWith('.json')).toSorted();
  return yield* Effect.forEach(
    files,
    file =>
      fs
        .readFileString(`${dir}/${file}`)
        .pipe(Effect.flatMap(Schema.decodeEffect(RunRecordJsonSchema))),
    { concurrency: 1 },
  );
});

const runCommand = Command.make(
  'run',
  {
    project: projectFlag,
    learners: Flag.Literals('learner', LearnerSchema.literals).pipe(
      Flag.atLeast(1),
      Flag.withDescription('A learner to replay: current, or the refine-freely control'),
    ),
    developer: Flag.Literals('developer', DeveloperSchema.literals).pipe(
      Flag.withDefault('real'),
      Flag.withDescription(
        'Whose swipes: the real developer, or one who also holds a scoped rule (simulated)',
      ),
    ),
    noise: Flag.Finite('noise').pipe(
      Flag.withDefault(0),
      Flag.withDescription('The share of swipes learn sees flipped, from 0 to 1'),
    ),
    runs: Flag.Int('runs').pipe(
      Flag.withDefault(1),
      Flag.withDescription('Replays per learner, each with its own seed'),
    ),
    seed: Flag.Int('seed').pipe(Flag.withDefault(1), Flag.withDescription('The first seed')),
    label: Flag.String('label').pipe(
      Flag.withDefault('local'),
      Flag.withDescription('Names this checkout in the report, e.g. its branch'),
    ),
  },
  ({ project, learners, developer, noise, runs, seed, label }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataset = yield* Schema.decodeEffect(DatasetJsonSchema)(
        yield* fs.readFileString(yield* datasetPath(project)),
      );
      const simulated = developer === 'simulated' ? yield* loadSimulated(project, dataset) : {};
      const resultsDir = `${yield* benchDir}/results`;
      yield* fs.makeDirectory(resultsDir, { recursive: true });

      const plans = learners.flatMap(learner =>
        Array.from({ length: runs }, (_slot, run) => ({ learner, seed: seed + run })),
      );
      const records: RunRecord[] = yield* Effect.forEach(
        plans,
        ({ learner, seed }) =>
          replay({ dataset, label, learner, developer, noise, seed, simulated }).pipe(
            Effect.tap(record =>
              Effect.gen(function* () {
                const file = `${resultsDir}/${label}-${learner}-${developer}-noise${noise}-seed${seed}.json`;
                yield* fs.writeFileString(
                  file,
                  yield* Schema.encodeEffect(RunRecordJsonSchema)(record),
                );
              }),
            ),
          ),
        { concurrency: REPLAY_CONCURRENCY },
      );
      yield* Console.log(renderReport(records));
    }).pipe(Effect.orDie, Effect.provide(Model.claudeCli)),
).pipe(
  Command.withDescription(
    'Replay the fetched rounds through learners, judge each doc on the next round, and report',
  ),
);

const reportCommand = Command.make('report', {}, () =>
  readRecords.pipe(
    Effect.flatMap(records => Console.log(renderReport(records))),
    Effect.orDie,
  ),
).pipe(Command.withDescription('Report every saved run, its runs averaged per row'));

const learnBench = Command.make('learn-bench').pipe(
  Command.withDescription(
    "Benchmarks CodeTinder's learn step: how well the doc it learns predicts the next swipes.",
  ),
  Command.withSubcommands([fetchCommand, runCommand, reportCommand]),
);

learnBench.pipe(
  Command.run({ version: '0.0.0' }),
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
    ),
  ),
  NodeRuntime.runMain,
);
