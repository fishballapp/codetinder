import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as PlatformError from 'effect/PlatformError';

/** For tests: a file system of the given files, with a reader to check what was written. */
export const memoryFileSystem = (initial: Record<string, string> = {}) => {
  const files = new Map(Object.entries(initial));
  return {
    read: (path: string) => files.get(path),
    paths: () => [...files.keys()].toSorted(),
    layer: FileSystem.layerNoop({
      exists: path => Effect.succeed(files.has(path)),
      readFileString: path => {
        const content = files.get(path);
        if (content !== undefined) return Effect.succeed(content);
        return Effect.fail(
          PlatformError.systemError({
            _tag: 'NotFound',
            module: 'FileSystem',
            method: 'readFileString',
            pathOrDescriptor: path,
          }),
        );
      },
      writeFileString: (path, data, options) =>
        Effect.sync(
          () => void files.set(path, options?.flag === 'a' ? (files.get(path) ?? '') + data : data),
        ),
      makeDirectory: () => Effect.void,
      readDirectory: () => Effect.succeed([...files.keys()].filter(path => !path.includes('/'))),
      remove: (path, options) =>
        Effect.gen(function* () {
          if (files.delete(path)) return;
          if (options?.force === true) return;
          return yield* PlatformError.systemError({
            _tag: 'NotFound',
            module: 'FileSystem',
            method: 'remove',
            pathOrDescriptor: path,
          });
        }),
    }),
  };
};
