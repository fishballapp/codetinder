import { diff } from '@codetinder/core';
import { describe, expect, it } from 'vitest';
import { changedWords, foldUnchanged } from './diff';

describe('foldUnchanged', () => {
  const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`);
  const shape = (before: string[], after: string[], kept?: ReadonlySet<number>) =>
    foldUnchanged(diff(before, after), {
      context: 2,
      minFolded: 3,
      maxWhole: 7,
      ...(kept ? { kept } : {}),
    }).map(({ isFolded, lines }) => `${isFolded ? 'folded' : 'shown'} ${lines.length}`);

  it('folds what is far from a change on either side', () => {
    const before = numbered(20);
    const after = before.with(10, 'changed');

    expect(shape(before, after)).toEqual(['folded 8', 'shown 6', 'folded 7']);
  });

  it('shows a run too short to fold', () => {
    const before = numbered(8);
    const after = before.with(5, 'changed');

    expect(shape(before, after)).toEqual(['folded 3', 'shown 6']);
    expect(shape(numbered(7), numbered(7).with(4, 'changed'))).toEqual(['shown 8']);
  });

  it('folds between two changes far apart', () => {
    const before = numbered(20);
    const after = before.with(2, 'first').with(17, 'second');

    expect(shape(before, after)).toEqual(['shown 6', 'folded 10', 'shown 6']);
  });

  it('never folds a kept line, folding either side of it', () => {
    const before = numbered(20);
    const after = before.with(10, 'changed');

    expect(shape(before, after, new Set([0]))).toEqual([
      'shown 1',
      'folded 7',
      'shown 6',
      'folded 7',
    ]);
    expect(shape(before, after, new Set([0, 4]))).toEqual([
      'shown 1',
      'folded 3',
      'shown 1',
      'folded 3',
      'shown 6',
      'folded 7',
    ]);
  });

  it('shows a short diff whole', () => {
    expect(shape(numbered(6), numbered(6).with(5, 'changed'))).toEqual(['shown 7']);
  });

  it('shows a diff without a change whole', () => {
    expect(shape(numbered(20), numbered(20))).toEqual(['shown 20']);
  });
});

describe('changedWords', () => {
  const marked = (text: string, ranges: readonly (readonly [number, number])[]) =>
    ranges.map(([start, end]) => text.slice(start, end));

  it('marks the words that changed on each side', () => {
    const before = '  const [rawId, ...words] = rest;';
    const after = '  const [idArgument, ...words] = rest;';
    const words = changedWords(before, after);

    expect(words && marked(before, words.before)).toEqual(['rawId']);
    expect(words && marked(after, words.after)).toEqual(['idArgument']);
  });

  it('joins changed words with the space between them', () => {
    const before = 'export function summarize(todos: Todo[]) {';
    const after = 'export const summarize = (todos: Todo[]) => {';
    const words = changedWords(before, after);

    expect(words && marked(before, words.before)).toEqual(['function']);
    expect(words && marked(after, words.after)).toEqual(['const', '=', '=>']);
  });

  it("doesn't mark a line indented anew", () => {
    expect(changedWords('    return b;', '  return b;')).toEqual({ before: [], after: [] });
  });

  it('marks nothing on lines with too little in common', () => {
    expect(changedWords('  let open = 0;', '  return todos.filter(isOpen).length;')).toBe(
      undefined,
    );
  });
});
