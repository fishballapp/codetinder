import { renderPrinciplesDoc } from '@codetinder/core';
import { GitLabFiles } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import { readLearnedPrinciples } from './atoms';

const principle = {
  id: 'no-else',
  section: 'General',
  strength: 'moderate',
  statement: 'Skip the else.',
} as const;

/** A repo whose default branch, `main`, holds `files` by path; each read lands in `reads`. */
const repo = (files: Readonly<Record<string, string>>, reads: string[] = []) =>
  Layer.succeed(
    GitLabFiles,
    GitLabFiles.of({
      readRevision: () => Effect.die('not used by this test'),
      readText: ({ projectId, path, ref }) =>
        Effect.sync(() => {
          reads.push(`${projectId}:${ref}:${path}`);
          return Option.fromNullishOr(files[path]);
        }),
    }),
  );

const read = readLearnedPrinciples({ token: Redacted.make('t'), projectId: 7, ref: 'main' });

describe('readLearnedPrinciples', () => {
  it.effect('reads the doc, and only the doc', () => {
    const reads: string[] = [];
    return Effect.gen(function* () {
      expect(yield* read).toEqual({ _tag: 'Learned', principles: [principle] });
      expect(reads).toEqual(['7:main:.codetinder/principles.md']);
    }).pipe(
      Effect.provide(
        repo({ '.codetinder/principles.md': renderPrinciplesDoc([principle]) }, reads),
      ),
    );
  });

  it.effect('says when the doc is missing', () =>
    Effect.gen(function* () {
      expect(yield* read).toEqual({ _tag: 'Missing' });
    }).pipe(Effect.provide(repo({}))),
  );
});
