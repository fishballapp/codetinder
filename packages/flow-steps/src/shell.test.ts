import type * as NodeServices from '@effect/platform-node/NodeServices';
import * as NodeServicesLayer from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Sink from 'effect/Sink';
import * as Stdio from 'effect/Stdio';
import { afterEach, vi } from 'vitest';
import { OUTPUT_TAIL, runCollectingOutput, runShell } from './shell';

const MIB = 1024 * 1024;

/** Stands in for our stderr: what the step forwards to it, in order. */
const capturedStderr = () => {
  const chunks: (string | Uint8Array)[] = [];
  const record = (chunk: string | Uint8Array) =>
    Effect.sync(() => {
      chunks.push(chunk);
    });
  return { chunks, layer: Stdio.layerTest({ stderr: () => Sink.forEach(record) }) };
};

const forwardedText = (chunks: readonly (string | Uint8Array)[]) =>
  chunks
    .map(chunk => (typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)))
    .join('');

const forwardedSize = (chunks: readonly (string | Uint8Array)[]) =>
  chunks.reduce((total, chunk) => total + chunk.length, 0);

/** The real services, with our stderr captured in place of the process's. */
const withServices = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
  stderr: Layer.Layer<Stdio.Stdio>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(Layer.mergeAll(NodeServicesLayer.layer, stderr)));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runShell', () => {
  it.effect(
    'completes when the command prints over 1 MiB to each stream, and forwards both',
    () => {
      const stderr = capturedStderr();
      return withServices(
        Effect.gen(function* () {
          const { exitCode } = yield* runShell(
            `head -c ${MIB} /dev/zero; head -c ${MIB} /dev/zero >&2`,
          );
          expect(exitCode).toBe(0);
          expect(forwardedSize(stderr.chunks)).toBe(2 * MIB);
        }),
        stderr.layer,
      );
    },
  );

  it.effect('returns the last lines of stdout and stderr together', () => {
    const stderr = capturedStderr();
    return withServices(
      Effect.gen(function* () {
        const { exitCode, outputTail } = yield* runShell('seq 1 1000; echo boom >&2; exit 3');
        expect(exitCode).toBe(3);
        const lines = outputTail.split('\n');
        expect(lines).toHaveLength(OUTPUT_TAIL.lines);
        expect(lines.at(0)).toBe('802');
        expect(lines.at(-1)).toBe('boom');
      }),
      stderr.layer,
    );
  });

  it.effect('caps the tail in bytes, from the first whole line', () => {
    const stderr = capturedStderr();
    return withServices(
      Effect.gen(function* () {
        // 100 lines of 1 KiB, each starting with its number.
        const { outputTail } = yield* runShell(
          `for i in $(seq 1 100); do printf "%-1023s\\n" "$i"; done`,
        );
        expect(new TextEncoder().encode(outputTail).length).toBeLessThanOrEqual(OUTPUT_TAIL.bytes);
        expect(outputTail).toMatch(/^\d+ /);
        expect(outputTail.trimEnd().endsWith('100')).toBe(true);
      }),
      stderr.layer,
    );
  });

  it.effect('runs without the flow tokens and with the rest of the environment', () => {
    vi.stubEnv('GITLAB_TOKEN', 'stub-gitlab-token');
    vi.stubEnv('GITLAB_OAUTH_TOKEN', 'stub-oauth-token');
    vi.stubEnv('CODETINDER_ID_TOKEN', 'stub-id-token');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.test:3128');
    const stderr = capturedStderr();
    return withServices(
      Effect.gen(function* () {
        yield* runShell(
          'echo "[$GITLAB_TOKEN][$GITLAB_OAUTH_TOKEN][$CODETINDER_ID_TOKEN][$HTTPS_PROXY]" >&2',
        );
        expect(forwardedText(stderr.chunks)).toBe('[][][][http://proxy.test:3128]\n');
      }),
      stderr.layer,
    );
  });

  it.effect(
    'points the git hooks at /tmp, the only place besides the checkout a command may write',
    () => {
      const stderr = capturedStderr();
      return withServices(
        Effect.gen(function* () {
          const { outputTail } = yield* runShell('git config core.hooksPath');
          expect(outputTail).toBe('/tmp/.git-hooks');
        }),
        stderr.layer,
      );
    },
  );

  it.effect('gives the command a home and XDG directories under /tmp, made for it', () => {
    const stderr = capturedStderr();
    return withServices(
      Effect.gen(function* () {
        const { outputTail } = yield* runShell(
          'echo "$HOME $XDG_CACHE_HOME $XDG_CONFIG_HOME $XDG_DATA_HOME $XDG_STATE_HOME"; mkdir -p ~/.cache/x && cd ~ && pwd',
        );
        const home = '/tmp/.codetinder-home';
        expect(outputTail).toBe(
          `${home} ${home}/.cache ${home}/.config ${home}/.local/share ${home}/.local/state\n${home}`,
        );
      }),
      stderr.layer,
    );
  });

  it.effect('keeps the git config the environment already carries', () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'user.name');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'runner');
    const stderr = capturedStderr();
    return withServices(
      Effect.gen(function* () {
        const { outputTail } = yield* runShell('git config user.name; git config core.hooksPath');
        expect(outputTail).toBe('runner\n/tmp/.git-hooks');
      }).pipe(
        // The default provider reads the environment once, before the stubs above.
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
      stderr.layer,
    );
  });
});

describe('runCollectingOutput', () => {
  it.effect('runs without the flow tokens too', () => {
    vi.stubEnv('GITLAB_TOKEN', 'stub-gitlab-token');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.test:3128');
    const stderr = capturedStderr();
    return withServices(
      Effect.gen(function* () {
        const { output, exitCode } = yield* runCollectingOutput('sh', [
          '-c',
          'echo "[$GITLAB_TOKEN][$HTTPS_PROXY]"',
        ]);
        expect(exitCode).toBe(0);
        expect(output).toBe('[][http://proxy.test:3128]\n');
      }),
      stderr.layer,
    );
  });
});
