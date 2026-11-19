import { PROJECT_CONFIG_PATH, type ProjectConfig, ProjectConfigSchema } from '@codetinder/core';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { userError } from './user-error';

export type ReadProjectConfigResult =
  | { readonly _tag: 'Ok'; readonly config: ProjectConfig }
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'Invalid'; readonly message: string };

/** Decode `.codetinder/config.json`, distinguishing missing from invalid. */
export const readProjectConfig = Effect.fn('projectConfigFile.read')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(PROJECT_CONFIG_PATH).pipe(Effect.option);
  if (Option.isNone(text)) return { _tag: 'Missing' as const };

  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(ProjectConfigSchema))(
    text.value,
  ).pipe(Effect.result);
  if (Result.isFailure(decoded)) {
    return { _tag: 'Invalid' as const, message: decoded.failure.message };
  }
  return { _tag: 'Ok' as const, config: decoded.success };
});

/** The config, for a command that can't run without it. */
export const requireProjectConfig = Effect.fn('projectConfigFile.require')(function* () {
  const read = yield* readProjectConfig();
  if (read._tag === 'Missing') {
    return yield* userError({ message: `missing ${PROJECT_CONFIG_PATH}` });
  }
  if (read._tag === 'Invalid') {
    return yield* userError({ message: `invalid ${PROJECT_CONFIG_PATH}: ${read.message}` });
  }
  return read.config;
});
