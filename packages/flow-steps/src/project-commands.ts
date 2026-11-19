import { type ProjectConfig, pinnedCommand, readPins } from '@codetinder/core';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';

const readIfPresent = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(Effect.option, Effect.map(Option.getOrUndefined));

/**
 * The project's install and test commands, run on the Node and package manager its root pins.
 * Read from the checkout on each call, so upgrading `package.json` needs no config change.
 */
export const projectCommands = Effect.fn('projectCommands')(function* (config: ProjectConfig) {
  const fs = yield* FileSystem.FileSystem;
  const fileNames = yield* fs.readDirectory('.').pipe(Effect.orDie);
  const nodeVersionFile = ['.nvmrc', '.node-version'].find(file => fileNames.includes(file));
  const pins = readPins({
    fileNames,
    packageJson: yield* readIfPresent(fs, 'package.json'),
    nodeVersionFile:
      nodeVersionFile === undefined ? undefined : yield* readIfPresent(fs, nodeVersionFile),
  });
  const commands = {
    install: pinnedCommand(config.install, pins),
    test: pinnedCommand(config.test, pins),
  };
  yield* Console.error(`install: ${commands.install}`);
  yield* Console.error(`test: ${commands.test}`);
  return commands;
});
