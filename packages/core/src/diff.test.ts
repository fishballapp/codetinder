import { describe, expect, it } from 'vitest';
import { diff, type Edit, unifiedDiff } from './diff';

/** A diff as a unified diff's lines: ` a`, `-b`, `+c`. */
const unified = (before: readonly string[], after: readonly string[]) =>
  diff(before, after).map(edit => {
    if (edit.kind === 'removed') return `-${before[edit.before]}`;
    if (edit.kind === 'added') return `+${after[edit.after]}`;
    return ` ${before[edit.before]}`;
  });

describe('diff', () => {
  it('keeps every item of equal sequences', () => {
    expect(unified(['a', 'b'], ['a', 'b'])).toEqual([' a', ' b']);
  });

  it('marks what was removed and added around what stayed', () => {
    expect(unified(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toEqual([
      ' a',
      '-b',
      '+x',
      ' c',
      ' d',
      '+e',
    ]);
  });

  it('removes before it adds within a change', () => {
    expect(unified(['a', 'b', 'c', 'z'], ['a', 'x', 'y', 'z'])).toEqual([
      ' a',
      '-b',
      '-c',
      '+x',
      '+y',
      ' z',
    ]);
  });

  it('keeps the lines a guard clause leaves alone', () => {
    const before = ['if (ok) {', '  return a;', '} else {', '  return b;', '}'];
    const after = ['if (ok) {', '  return a;', '}', 'return b;'];

    expect(unified(before, after)).toEqual([
      ' if (ok) {',
      ' ' + '  return a;',
      '-} else {',
      '-  return b;',
      ' }',
      '+return b;',
    ]);
  });

  it('indexes both sides', () => {
    expect(diff(['a', 'b'], ['x', 'a'])).toEqual<Edit[]>([
      { kind: 'added', after: 0 },
      { kind: 'unchanged', before: 0, after: 1 },
      { kind: 'removed', before: 1 },
    ]);
  });

  it('diffs from or to nothing', () => {
    expect(unified([], ['a'])).toEqual(['+a']);
    expect(unified(['a'], [])).toEqual(['-a']);
  });
});

describe('unifiedDiff', () => {
  const numbered = (count: number) =>
    Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
  const changeLine = (text: string, line: number, to: string) =>
    text.replace(`line ${line}\n`, `${to}\n`);

  it('shows a change with its context under a hunk header', () => {
    expect(unifiedDiff(numbered(10), changeLine(numbered(10), 5, 'five'), { context: 2 })).toBe(
      ['@@ -3,5 +3,5 @@', ' line 3', ' line 4', '-line 5', '+five', ' line 6', ' line 7'].join(
        '\n',
      ),
    );
  });

  it('starts a separate hunk only where the context of two changes would not meet', () => {
    const apart = changeLine(changeLine(numbered(12), 2, 'two'), 10, 'ten');
    expect(unifiedDiff(numbered(12), apart, { context: 1 })).toBe(
      [
        '@@ -1,3 +1,3 @@',
        ' line 1',
        '-line 2',
        '+two',
        ' line 3',
        '@@ -9,3 +9,3 @@',
        ' line 9',
        '-line 10',
        '+ten',
        ' line 11',
      ].join('\n'),
    );
    const near = changeLine(changeLine(numbered(12), 2, 'two'), 5, 'five');
    expect(unifiedDiff(numbered(12), near, { context: 1 })).toMatch(/^@@ -1,6 \+1,6 @@\n/);
    expect(unifiedDiff(numbered(12), near, { context: 1 }).match(/@@/g)).toHaveLength(2);
  });

  it('counts each side apart when lines are added or removed', () => {
    const added = numbered(4).replace('line 2\n', 'line 2\nnew\n');
    expect(unifiedDiff(numbered(4), added, { context: 1 })).toBe(
      ['@@ -2,2 +2,3 @@', ' line 2', '+new', ' line 3'].join('\n'),
    );
  });

  it('starts an empty side at the line before, as a unified diff does', () => {
    expect(unifiedDiff('a\nb', 'b', { context: 0 })).toBe(['@@ -1,1 +0,0 @@', '-a'].join('\n'));
  });

  it('ignores a final newline, and is empty for equal texts', () => {
    expect(unifiedDiff('a\nb\n', 'a\nc\n', { context: 3 })).toBe(
      ['@@ -1,2 +1,2 @@', ' a', '-b', '+c'].join('\n'),
    );
    expect(unifiedDiff('a\nb', 'a\nb', { context: 3 })).toBe('');
  });
});
