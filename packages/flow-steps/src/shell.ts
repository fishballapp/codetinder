import { parsePorcelainStatus } from '@codetinder/core';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Schema from 'effect/Schema';
import * as Stdio from 'effect/Stdio';
import * as Stream from 'effect/Stream';

/**
 * The flow's own tokens. Install scripts and tests run the project's code, which must not get them.
 */
const FLOW_TOKENS = ['GITLAB_TOKEN', 'GITLAB_OAUTH_TOKEN', 'CODETINDER_ID_TOKEN'];

// An `undefined` drops the inherited variable and keeps the rest of the environment, proxy included.
const childOptions = {
  extendEnv: true,
  env: Object.fromEntries(FLOW_TOKENS.map(name => [name, undefined])),
};

/**
 * The sandbox keeps every write to the checkout and `/tmp`, and protects git hooks itself. A
 * project's commands get a home under `/tmp`, so a tool that caches or configures under `$HOME`
 * (browsers, pip, cargo, go, …) works, and so does a package manager's store or cache
 * (`XDG_DATA_HOME` for pnpm, `XDG_CACHE_HOME` for Yarn, Bun and Go), so a project's `install` and
 * `test` need no environment prefix or cache flag of their own. Only the variables a tool derives its home from are set:
 * what the runner already points into `/tmp`, such as `NPM_CONFIG_CACHE`, is left as it is.
 */
const PROJECT_HOME = '/tmp/.codetinder-home';
const PROJECT_HOME_ENV = {
  HOME: PROJECT_HOME,
  XDG_CACHE_HOME: `${PROJECT_HOME}/.cache`,
  XDG_CONFIG_HOME: `${PROJECT_HOME}/.config`,
  XDG_DATA_HOME: `${PROJECT_HOME}/.local/share`,
  XDG_STATE_HOME: `${PROJECT_HOME}/.local/state`,
};

const makeProjectHome = Effect.fn('shell.makeProjectHome')(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.forEach(
    Object.values(PROJECT_HOME_ENV),
    dir => fs.makeDirectory(dir, { recursive: true }),
    { discard: true },
  ).pipe(Effect.orDie);
  return PROJECT_HOME_ENV;
});

/**
 * Git config for a project's commands, appended to the entries the environment already carries
 * (`GIT_CONFIG_COUNT` and its numbered keys, which the flow's runner uses). An install whose
 * `prepare` script installs git hooks (lefthook, husky) fails in the sandbox, which never lets a
 * command write `.git/hooks`. Pointing the hooks at `/tmp` lets it through, and nothing in a
 * sandboxed run wants the project's hooks. It goes in the environment because lefthook refuses a
 * hooks path set in the repo's own config.
 */
const projectGitConfigEnv = Effect.fn('shell.projectGitConfigEnv')(function* () {
  const count = yield* Config.Int('GIT_CONFIG_COUNT').pipe(Config.withDefault(0), Effect.orDie);
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${count}`]: '/tmp/.git-hooks',
  };
});

/**
 * How much of a command's output `runShell` keeps: its end, where a test runner reports, small
 * enough to hand an agent.
 */
export const OUTPUT_TAIL = { lines: 200, bytes: 20 * 1024 } as const;

/** The last `OUTPUT_TAIL` of a byte stream, kept as it passes, never holding more. */
const outputTail = () => {
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  let seenBytes = 0;
  return {
    push: (chunk: Uint8Array) => {
      chunks.push(chunk);
      keptBytes += chunk.length;
      seenBytes += chunk.length;
      // Drop the oldest chunks while the rest still cover the tail.
      for (;;) {
        const [first] = chunks;
        if (first === undefined || keptBytes - first.length < OUTPUT_TAIL.bytes) return;
        chunks.shift();
        keptBytes -= first.length;
      }
    },
    text: () => {
      const kept = new Uint8Array(keptBytes);
      chunks.reduce((offset, chunk) => {
        kept.set(chunk, offset);
        return offset + chunk.length;
      }, 0);
      const text = new TextDecoder().decode(kept.subarray(-OUTPUT_TAIL.bytes));
      // A cut lands mid-line, maybe mid-character: start at the next whole line.
      const whole = seenBytes > OUTPUT_TAIL.bytes ? text.slice(text.indexOf('\n') + 1) : text;
      return whole.trimEnd().split('\n').slice(-OUTPUT_TAIL.lines).join('\n');
    },
  };
};

/**
 * Run a command and forward its stdout and stderr to our stderr, which keeps our stdout for the
 * verdict, keeping the tail of both. Both streams are drained, or a command that prints a lot
 * blocks on a full pipe.
 */
const spawnForwarding = Effect.fn('shell.spawnForwarding')(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdio = yield* Stdio.Stdio;
  const tail = outputTail();
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      yield* Stream.run(
        handle.all.pipe(Stream.tap(chunk => Effect.sync(() => tail.push(chunk)))),
        stdio.stderr({ endOnDone: false }),
      );
      const exitCode = yield* handle.exitCode;
      return { exitCode, outputTail: tail.text() };
    }),
  ).pipe(Effect.orDie);
});

/**
 * Run a project's command via `sh -c` from the repo root, its home and git hooks pointed where the
 * sandbox lets it write; return its exit code and the last `OUTPUT_TAIL` of its combined output.
 */
export const runShell = Effect.fn('shell.run')(function* (command: string) {
  const env = {
    ...childOptions.env,
    ...(yield* makeProjectHome()),
    ...(yield* projectGitConfigEnv()),
  };
  return yield* spawnForwarding(ChildProcess.make('sh', ['-c', command], { ...childOptions, env }));
});

/** Run a command (no shell) and collect its stdout; its stderr goes to ours. */
/** Run a command and collect its stdout as bytes, exactly as it wrote them, plus the exit code. */
export const runCapturingStdoutBytes = Effect.fn('shell.runCapturingStdoutBytes')(function* (
  command: string,
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdio = yield* Stdio.Stdio;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, childOptions));
      const [chunks] = yield* Effect.all(
        [
          Stream.runCollect(handle.stdout),
          Stream.run(handle.stderr, stdio.stderr({ endOnDone: false })),
        ],
        { concurrency: 'unbounded' },
      );
      const exitCode = yield* handle.exitCode;
      return { stdout: new Uint8Array(chunks.flatMap(chunk => [...chunk])), exitCode };
    }).pipe(Effect.orDie),
  );
});

export const runCapturingStdout = Effect.fn('shell.runCapturingStdout')(function* (
  command: string,
  args: readonly string[],
) {
  const { stdout, exitCode } = yield* runCapturingStdoutBytes(command, args);
  return { stdout: new TextDecoder().decode(stdout), exitCode };
});

/** Run a command and collect stdout+stderr plus the exit code (for `tsc`). */
export const runCollectingOutput = Effect.fn('shell.runCollectingOutput')(function* (
  command: string,
  args: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, childOptions));
      const output = yield* Stream.mkString(Stream.decodeText(handle.all));
      const exitCode = yield* handle.exitCode;
      return { output, exitCode };
    }).pipe(Effect.orDie),
  );
});

export class GitFailed extends Schema.TaggedError<GitFailed>()('GitFailed', {
  message: Schema.String,
}) {}

/** Run git (an argument list, never a shell: paths are the agent's text) and return its stdout. */
export const git = Effect.fn('shell.git')(function* (args: readonly string[]) {
  const { stdout, exitCode } = yield* runCapturingStdout('git', args);
  if (exitCode !== 0) {
    return yield* new GitFailed({ message: `git ${args.join(' ')} exited ${exitCode}` });
  }
  return stdout;
});

/** What the working tree changes against the commit, untracked files included. */
export const listWorkingTreeChanges = Effect.fn('shell.listWorkingTreeChanges')(function* () {
  return parsePorcelainStatus(
    yield* git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  );
});
