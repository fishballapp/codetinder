/** One run of code, classified for colouring; joined back, the tokens are the text. */
export type CodeToken = {
  readonly kind: 'plain' | 'keyword' | 'builtin' | 'string' | 'comment' | 'symbol';
  readonly text: string;
};

const KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'of',
  'readonly',
  'return',
  'satisfies',
  'switch',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'var',
  'while',
  'yield',
]);

const BUILTINS = new Set([
  'any',
  'bigint',
  'boolean',
  'never',
  'null',
  'number',
  'object',
  'string',
  'symbol',
  'undefined',
  'unknown',
  'void',
]);

// A comment, a string or template literal, or an identifier; everything between is plain.
const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|([A-Za-z_$][\w$]*)/g;

const classify = (
  [, comment, string, word]: RegExpExecArray,
  symbols: ReadonlySet<string>,
): CodeToken['kind'] => {
  if (comment !== undefined) return 'comment';
  if (string !== undefined) return 'string';
  if (word === undefined) return 'plain';
  if (symbols.has(word)) return 'symbol';
  if (KEYWORDS.has(word)) return 'keyword';
  if (BUILTINS.has(word)) return 'builtin';
  return 'plain';
};

/**
 * Splits TypeScript or JavaScript into coloured runs. `symbols` are the names the round's context
 * defines; they come out as `symbol` so the reader can open their definitions.
 */
export const highlightCode = (text: string, symbols: ReadonlySet<string>): CodeToken[] => {
  const tokens: CodeToken[] = [];
  const push = (kind: CodeToken['kind'], tokenText: string) => {
    const previous = tokens.at(-1);
    if (kind === 'plain' && previous?.kind === 'plain') {
      tokens[tokens.length - 1] = { kind, text: previous.text + tokenText };
    } else {
      tokens.push({ kind, text: tokenText });
    }
  };

  let end = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [whole] = match;
    if (match.index > end) push('plain', text.slice(end, match.index));
    push(classify(match, symbols), whole);
    end = match.index + whole.length;
  }
  if (end < text.length) push('plain', text.slice(end));
  return tokens;
};

/** A line of highlighted code, and how many columns its indentation takes. */
export type CodeLine = { readonly indent: number; readonly tokens: readonly CodeToken[] };

/** The site's tab width, as `tab-2` draws a tab. */
const TAB_SIZE = 2;

/** A line with each tab turned into the spaces that reach its tab stop: the same look, all spaces. */
const expandTabs = (line: string) => {
  let expanded = '';
  for (const character of line) {
    expanded +=
      character === '\t' ? ' '.repeat(TAB_SIZE - (expanded.length % TAB_SIZE)) : character;
  }
  return expanded;
};

/** A text's lines: a final line break ends the last line, as in a `<pre>`, rather than starting an empty one. */
export const splitLines = (text: string): string[] =>
  (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');

/**
 * `highlightCode`, line by line, for code that wraps: tabs become spaces, so a line's indent is its
 * leading spaces, and a token across a line break, a block comment say, splits there. Its lines are
 * `splitLines`'.
 */
export const highlightLines = (code: string, symbols: ReadonlySet<string>): CodeLine[] => {
  const text = splitLines(code).map(expandTabs).join('\n');
  const lineTokens: CodeToken[][] = [[]];
  for (const token of highlightCode(text, symbols)) {
    token.text.split('\n').forEach((part, index) => {
      if (index > 0) lineTokens.push([]);
      if (part !== '') lineTokens[lineTokens.length - 1]?.push({ kind: token.kind, text: part });
    });
  }
  return text.split('\n').map((line, index) => ({
    indent: /^ */.exec(line)?.[0].length ?? 0,
    tokens: lineTokens[index] ?? [],
  }));
};

/**
 * The first line that holds code: past a leading comment and any blank lines. The lines' length
 * when there is none.
 */
export const firstCodeLine = (lines: readonly CodeLine[]): number => {
  const index = lines.findIndex(({ tokens }) =>
    tokens.some(token => token.kind !== 'comment' && token.text.trim() !== ''),
  );
  return index === -1 ? lines.length : index;
};

/** A piece of a highlighted line, and whether it falls in a marked range. */
export type MarkedToken = CodeToken & { readonly isMarked: boolean };

/**
 * A line's tokens cut where `ranges` (of its characters, in order, apart) start and end, each piece
 * saying whether it is inside one.
 */
export const markTokens = (
  tokens: readonly CodeToken[],
  ranges: readonly (readonly [number, number])[],
): MarkedToken[] => {
  const pieces: MarkedToken[] = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.text.length;
    const cuts = [offset, ...ranges.flat().filter(cut => cut > offset && cut < end), end];
    cuts.slice(1).forEach((cut, index) => {
      const start = cuts[index] ?? offset;
      pieces.push({
        kind: token.kind,
        text: token.text.slice(start - offset, cut - offset),
        isMarked: ranges.some(([from, to]) => start >= from && cut <= to),
      });
    });
    offset = end;
  }
  return pieces;
};
