import * as Result from 'effect/Result';
import { describe, expect, it } from 'vitest';
import { locateSnippet, swapSnippet } from './snippet';

const file = 'src/todos.ts';

describe('locateSnippet', () => {
  it('finds a snippet that occurs once', () => {
    expect(locateSnippet('const a = 1;\nconst b = 2;\n', { file, text: 'const b = 2;' })).toEqual(
      Result.succeed(13),
    );
  });

  it('matches CRLF text exactly', () => {
    const fileText = 'function f() {\r\n  return 42;\r\n}\r\n';
    expect(locateSnippet(fileText, { file, text: '  return 42;\r\n' })).toEqual(Result.succeed(16));
    expect(Result.isFailure(locateSnippet(fileText, { file, text: '  return 42;\n}' }))).toBe(true);
  });

  it('rejects a snippet that is missing', () => {
    const result = locateSnippet('const a = 1;', { file, text: 'const b = 2;' });
    expect(Result.isFailure(result) && result.failure._tag).toBe('SnippetNotFoundError');
    expect(Result.isFailure(result) && result.failure.message).toBe('not found in src/todos.ts');
  });

  it('rejects a snippet that occurs twice, overlapping included', () => {
    for (const [fileText, text] of [
      ['const a = 1;\nconst a = 1;\n', 'const a = 1;'],
      ['aaa', 'aa'],
    ] as const) {
      const result = locateSnippet(fileText, { file, text });
      expect(Result.isFailure(result) && result.failure._tag).toBe('SnippetAmbiguousError');
    }
  });
});

describe('swapSnippet', () => {
  it('replaces the one occurrence, keeping what surrounds it', () => {
    const fileText = 'a\r\nconst x = 1;\r\nb';
    expect(swapSnippet(fileText, { file, text: 'const x = 1;' }, 'let x = 1;')).toEqual(
      Result.succeed('a\r\nlet x = 1;\r\nb'),
    );
  });

  it('takes the replacement literally', () => {
    expect(swapSnippet('[x]', { file, text: 'x' }, "$& $1 $$ $` $'")).toEqual(
      Result.succeed("[$& $1 $$ $` $']"),
    );
  });

  it('rejects a target it cannot locate', () => {
    expect(Result.isFailure(swapSnippet('x x', { file, text: 'x' }, 'y'))).toBe(true);
    expect(Result.isFailure(swapSnippet('x', { file, text: 'z' }, 'y'))).toBe(true);
  });
});
