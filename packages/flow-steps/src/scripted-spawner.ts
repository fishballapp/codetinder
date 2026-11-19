import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Sink from 'effect/Sink';
import * as Stream from 'effect/Stream';

export type ScriptedCommandResult = {
  readonly exitCode: number;
  /** Text, or bytes exactly as the command writes them. */
  readonly stdout?: string | Uint8Array;
  /** Never exits, as a command still running at a deadline. */
  readonly hangs?: boolean;
};

const byteStream = (output: string | Uint8Array) => {
  const bytes = typeof output === 'string' ? new TextEncoder().encode(output) : output;
  return bytes.length === 0 ? Stream.empty : Stream.fromIterable([bytes]);
};

export const commandKey = (command: ChildProcess.Command): string => {
  if (command._tag === 'PipedCommand') {
    return `${commandKey(command.left)} | ${commandKey(command.right)}`;
  }
  return [command.command, ...command.args].join(' ');
};

export const shellKey = (command: string) => `sh -c ${command}`;

export const tscKey = (tscPath: string, tsconfigPath: string, ...flags: string[]) =>
  [tscPath, '-p', tsconfigPath, ...flags].join(' ');

/**
 * A `ChildProcessSpawner` that returns scripted exit codes and stdout per
 * command line (`command args…`). The script may be a map or a function.
 */
export const scriptedSpawner = (
  script:
    | ReadonlyMap<string, ScriptedCommandResult>
    | Record<string, ScriptedCommandResult>
    | ((key: string) => ScriptedCommandResult | undefined),
) => {
  const table = (() => {
    if (typeof script === 'function') return undefined;
    if (script instanceof Map) return script;
    return new Map(Object.entries(script));
  })();
  const lookup = (key: string): ScriptedCommandResult | undefined =>
    typeof script === 'function' ? script(key) : table?.get(key);

  const spawn = (command: ChildProcess.Command) => {
    const result = lookup(commandKey(command)) ?? { exitCode: 1, stdout: '' };
    const bytes = byteStream(result.stdout ?? '');
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: result.hangs
          ? Effect.never
          : Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: bytes,
        stderr: Stream.empty,
        all: bytes,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  };
  return {
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
  };
};
