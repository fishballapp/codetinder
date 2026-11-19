import { describe, expect, it } from 'vitest';
import { firstCodeLine, highlightCode, highlightLines, markTokens } from './highlight';

describe('highlightCode', () => {
  it('classifies keywords, builtins, strings, comments and context symbols', () => {
    const tokens = highlightCode(
      'function f(todo: Todo, title: string) { // rename\n  return "x"; }',
      new Set(['Todo']),
    );

    expect(tokens).toEqual([
      { kind: 'keyword', text: 'function' },
      { kind: 'plain', text: ' f(todo: ' },
      { kind: 'symbol', text: 'Todo' },
      { kind: 'plain', text: ', title: ' },
      { kind: 'builtin', text: 'string' },
      { kind: 'plain', text: ') { ' },
      { kind: 'comment', text: '// rename' },
      { kind: 'plain', text: '\n  ' },
      { kind: 'keyword', text: 'return' },
      { kind: 'plain', text: ' ' },
      { kind: 'string', text: '"x"' },
      { kind: 'plain', text: '; }' },
    ]);
  });

  it('keeps keywords inside strings and comments as part of them', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the input is TypeScript source.
    const source = '`return ${x}` /* if */';
    expect(highlightCode(source, new Set())).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected TypeScript source.
      { kind: 'string', text: '`return ${x}`' },
      { kind: 'plain', text: ' ' },
      { kind: 'comment', text: '/* if */' },
    ]);
  });

  it('joins back to the exact text', () => {
    const text = 'const { a, b } = xs.reduce((acc, x) => acc, { a: [] as Todo[] });\n';
    const joined = highlightCode(text, new Set(['Todo']))
      .map(token => token.text)
      .join('');

    expect(joined).toBe(text);
  });
});

describe('highlightLines', () => {
  it('splits the tokens at line breaks, a comment across lines too, and keeps empty lines', () => {
    const lines = highlightLines('/* a\n   b */\n\n\tif (x) {}\n', new Set());

    expect(lines).toEqual([
      { indent: 0, tokens: [{ kind: 'comment', text: '/* a' }] },
      { indent: 3, tokens: [{ kind: 'comment', text: '   b */' }] },
      { indent: 0, tokens: [] },
      {
        indent: 2,
        tokens: [
          { kind: 'plain', text: '  ' },
          { kind: 'keyword', text: 'if' },
          { kind: 'plain', text: ' (x) {}' },
        ],
      },
    ]);
  });

  it('turns tabs into the spaces that reach their tab stops, mid-line too', () => {
    const lines = highlightLines(' \tx\n\t \tx\ta', new Set());
    expect(lines.map(({ indent }) => indent)).toEqual([2, 4]);
    expect(lines.map(({ tokens }) => tokens.map(({ text }) => text).join(''))).toEqual([
      '  x',
      '    x a',
    ]);
  });
});

describe('markTokens', () => {
  it('cuts tokens where a range starts and ends', () => {
    const [line] = highlightLines('const rawId = rest;', new Set());

    expect(
      markTokens(line?.tokens ?? [], [[6, 11]])
        .filter(({ isMarked }) => isMarked)
        .map(({ kind, text }) => [kind, text]),
    ).toEqual([['plain', 'rawId']]);
  });

  it('keeps every character, in order', () => {
    const [line] = highlightLines("return 'All done!';", new Set());
    const pieces = markTokens(line?.tokens ?? [], [
      [0, 3],
      [10, 14],
    ]);

    expect(pieces.map(({ text }) => text).join('')).toBe("return 'All done!';");
    expect(pieces.filter(({ isMarked }) => isMarked).map(({ text }) => text)).toEqual([
      'ret',
      'l do',
    ]);
  });
});

describe('firstCodeLine', () => {
  const firstCode = (code: string) => firstCodeLine(highlightLines(code, new Set()));

  it('is the first line of code that opens with no comment', () => {
    expect(firstCode('function f() {\n  return 1;\n}')).toBe(0);
  });

  it('skips a leading comment, line or block, and blank lines', () => {
    expect(firstCode('// Sums it.\n// Twice.\nfunction f() {}')).toBe(2);
    expect(firstCode('/**\n * Sums it.\n */\n\nexport function f() {}')).toBe(4);
  });
});
