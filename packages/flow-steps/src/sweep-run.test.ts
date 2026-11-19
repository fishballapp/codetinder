import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stdio from 'effect/Stdio';
import { afterAll, beforeAll } from 'vitest';
import { changedCodeFilesSince, firstSweepBase } from './sweep-run';

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join('\n');

/**
 * A repo whose default branch, newest first, is: more empty commits than a page of the walk, 40
 * lines of code, 500 lines of docs, a merge bringing 50 lines of code and a binary file, and the
 * root's 30 lines of code.
 */
const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'codetinder-sweep-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' },
    ).trim();
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    git('add', '--all');
    git('commit', '--quiet', '--message', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet', '--initial-branch=main');
  const root = commit({ 'a.ts': lines(30) }, 'root');
  git('switch', '--quiet', '--create', 'feature');
  commit({ 'f.ts': lines(50), 'logo.png': '\0binary\0' }, 'feature');
  git('switch', '--quiet', 'main');
  git('merge', '--quiet', '--no-ff', '--message', 'merge feature', 'feature');
  const docs = commit({ 'README.md': lines(500) }, 'docs');
  commit({ 'b.ts': lines(40) }, 'b');
  for (const index of Array.from({ length: 120 }, (_, i) => i)) {
    git('commit', '--quiet', '--allow-empty', '--message', `empty ${index}`);
  }
  return { dir, root, docs };
};

const repo = makeRepo();
const cwd = process.cwd();
beforeAll(() => process.chdir(repo.dir));
afterAll(() => {
  process.chdir(cwd);
  rmSync(repo.dir, { recursive: true, force: true });
});

const inRepo = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | Stdio.Stdio>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Stdio.layerTest({}))));

describe('firstSweepBase on a real repo', () => {
  it.effect.each<readonly [number, string | null, number]>([
    [40, repo.docs, 40],
    // The merge counts as its diff against its first parent; the feature's own commit isn't walked.
    [41, repo.root, 90],
    [90, repo.root, 90],
    [120, null, 120],
    [5000, null, 120],
  ])('walks back past a page of empty commits to the threshold %i', ([threshold, base, lines]) =>
    inRepo(
      Effect.gen(function* () {
        expect(yield* firstSweepBase(threshold)).toEqual({ base, lines });
      }),
    ),
  );

  it.effect('diffs the whole history from the empty tree', () =>
    inRepo(
      Effect.gen(function* () {
        expect((yield* changedCodeFilesSince(null)).toSorted()).toEqual(['a.ts', 'b.ts', 'f.ts']);
      }),
    ),
  );
});
