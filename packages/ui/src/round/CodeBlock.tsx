import { Fragment, type ReactNode, useMemo } from 'react';
import { cn } from '../cn';
import { type CodeToken, highlightCode, highlightLines } from './highlight';

/** A round's name for something its context defines: underlined. SymbolPeek's trigger shares it. */
export const symbolClass = 'text-code-type underline decoration-1 underline-offset-[0.2em]';

const TOKEN_CLASS: Record<Exclude<CodeToken['kind'], 'plain'>, string> = {
  keyword: 'text-code-keyword',
  builtin: 'text-code-builtin',
  string: 'text-code-string',
  comment: 'text-code-comment italic',
  symbol: symbolClass,
};

export const preClass =
  'm-0 overflow-auto text-[0.875em] leading-[1.6] text-ink tab-2 [scrollbar-width:thin]';

export type CodeProps = {
  readonly text: string;
  readonly symbols: readonly string[];
  readonly renderSymbol?: (symbol: string) => ReactNode;
};

export const renderToken =
  (renderSymbol: CodeProps['renderSymbol']) => (token: CodeToken, index: number) => {
    const key = `${index}:${token.text}`;
    if (token.kind === 'plain') return token.text;
    if (token.kind === 'symbol' && renderSymbol) {
      return <Fragment key={key}>{renderSymbol(token.text)}</Fragment>;
    }
    return (
      <span key={key} className={TOKEN_CLASS[token.kind]}>
        {token.text}
      </span>
    );
  };

/** One run of text that scrolls sideways, line breaks and all: a copy keeps every line. */
const ScrollingCode = ({ text, symbols, renderSymbol }: CodeProps) => {
  const tokens = useMemo(() => highlightCode(text, new Set(symbols)), [text, symbols]);
  return (
    <pre className={cn(preClass, 'whitespace-pre')}>
      <code>{tokens.map(renderToken(renderSymbol))}</code>
    </pre>
  );
};

/** How numbered lines lay out: wrapped, or wrapped only under a finger (a swipe card's). */
export type NumberedLayout = 'wrap' | 'wrap-on-touch';

/**
 * Each numbered layout's classes: the block's, the code's (as wide as its widest line when it
 * scrolls, so a pinned gutter stays pinned to the end), and the gutter's.
 */
export const NUMBERED_LAYOUTS: Record<
  NumberedLayout,
  { readonly pre: string; readonly code: string; readonly gutter: string }
> = {
  wrap: { pre: 'whitespace-pre-wrap wrap-anywhere', code: '', gutter: '' },
  // A mouse drag swipes and the wheel scrolls, so nothing clashes: lines stay whole, as typed,
  // and the numbers stay put as they scroll, on their line's ground. Scrolling past the edge never
  // turns into the trackpad's back gesture.
  'wrap-on-touch': {
    pre: 'whitespace-pre-wrap wrap-anywhere pointer-fine:whitespace-pre pointer-fine:wrap-normal pointer-fine:overscroll-x-contain',
    code: 'pointer-fine:block pointer-fine:w-max pointer-fine:min-w-full',
    gutter: 'pointer-fine:sticky pointer-fine:left-0 bg-inherit',
  },
};

/**
 * Numbered lines that wrap as an editor's do: a continuation starts at its line's own indent, and
 * only the line itself has a number, so a wrap never reads as a line of its own.
 */
const NumberedCode = ({
  layout,
  text,
  symbols,
  renderSymbol,
}: CodeProps & { readonly layout: NumberedLayout }) => {
  const lines = useMemo(() => highlightLines(text, new Set(symbols)), [text, symbols]);
  const classes = NUMBERED_LAYOUTS[layout];
  return (
    <pre className={cn(preClass, classes.pre)}>
      <code className={classes.code}>
        {lines.map(({ indent, tokens }, lineIndex) => (
          // A line is its place in the text: the text is fixed for the block's life.
          <span key={lineIndex} className="flex">
            <span
              className={cn(
                'flex-none pr-[1.25ch] text-right text-ink-faint/55 tabular-nums select-none',
                classes.gutter,
              )}
              // Faint on purpose (about 2.2:1, under WCAG's 4.5:1): an editor's gutter, not content, and
              // hidden from screen readers. Padding, not a margin: a pinned gutter's background hides
              // code scrolling under it.
              style={{ width: `calc(${String(lines.length).length}ch + 1.25ch)` }}
              aria-hidden="true"
            >
              {lineIndex + 1}
            </span>
            <span
              className="min-h-lh min-w-0 flex-1"
              style={{ paddingLeft: `${indent}ch`, textIndent: `-${indent}ch` }}
            >
              {tokens.map(renderToken(renderSymbol))}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
};

/**
 * Code exactly as written, coloured. Names the round's context defines are underlined;
 * `renderSymbol` draws them instead, to make them open their definitions. Its `layout`:
 * - `scroll` (a definition's popover): one run of text that scrolls sideways;
 * - `wrap` (a definition's sheet on a phone): numbered lines that wrap.
 */
export const CodeBlock = ({
  layout = 'scroll',
  ...props
}: CodeProps & { readonly layout?: 'scroll' | 'wrap' }) =>
  layout === 'scroll' ? <ScrollingCode {...props} /> : <NumberedCode layout={layout} {...props} />;
