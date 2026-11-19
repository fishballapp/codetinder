import { diff, type Edit } from '@codetinder/core';
import { ArrowsOutLineVerticalIcon } from '@phosphor-icons/react';
import { type ReactNode, useMemo, useState } from 'react';
import { cn } from '../cn';
import {
  type CodeProps,
  NUMBERED_LAYOUTS,
  type NumberedLayout,
  preClass,
  renderToken,
} from './CodeBlock';
import { changedWords, type DiffSegment, foldUnchanged, type Range } from './diff';
import { type CodeLine, firstCodeLine, highlightLines, markTokens, splitLines } from './highlight';

/** Unchanged lines this close to a change stay in view around it. */
const CONTEXT_LINES = 3;
/** A fold hides at least this many lines: fewer read faster than the row that would hide them. */
const MIN_FOLDED_LINES = 4;
/** A diff this long or shorter fits a phone's card, so nothing folds. */
const MAX_WHOLE_LINES = 20;

/** A line of the diff, coloured, with its number: in the original once removed, else in the after. */
type DiffLine = {
  readonly kind: Edit['kind'];
  readonly line: CodeLine;
  readonly number: number;
  readonly marks: readonly Range[];
};

/**
 * How each kind of line reads: its ground, its number's colour, its sign, its element and its
 * changed words. A number is faint, as an editor's gutter is, in its line's tone.
 */
const LINE_STYLES = {
  unchanged: {
    row: 'bg-card',
    number: 'text-ink-faint/55',
    sign: '',
    signClass: '',
    Content: 'span',
    content: 'opacity-62',
    mark: '',
  },
  removed: {
    row: 'bg-diff-removed',
    number: 'text-diff-removed-ink/60',
    sign: '−',
    signClass: 'text-diff-removed-ink',
    Content: 'del',
    content: '',
    mark: 'bg-diff-removed-word',
  },
  added: {
    row: 'bg-diff-added',
    number: 'text-diff-added-ink/60',
    sign: '+',
    signClass: 'text-diff-added-ink',
    Content: 'ins',
    content: '',
    mark: 'bg-diff-added-word',
  },
} as const satisfies Record<
  Edit['kind'],
  {
    readonly row: string;
    readonly number: string;
    readonly sign: string;
    readonly signClass: string;
    readonly Content: 'span' | 'del' | 'ins';
    readonly content: string;
    readonly mark: string;
  }
>;

/**
 * The diff from `before` to `after`, line by line, folded around its changes. A removed line and
 * the added line in its place mark the words they differ by. The target's first line never folds,
 * nor, when it opens with a comment, its declaration's: the card always shows which function it is.
 */
const diffSegments = (
  before: string,
  after: string,
  symbols: ReadonlySet<string>,
): DiffSegment<DiffLine>[] => {
  const beforeLines = highlightLines(before, symbols);
  const afterLines = highlightLines(after, symbols);
  const edits = diff(splitLines(before), splitLines(after));
  const lineOf = (edit: Edit) => {
    const line = edit.kind === 'removed' ? beforeLines[edit.before] : afterLines[edit.after];
    if (line === undefined) throw new Error(`no line for ${JSON.stringify(edit)}`);
    return line;
  };
  const textOf = (edit: Edit) =>
    lineOf(edit)
      .tokens.map(token => token.text)
      .join('');

  // Each change is its removed lines, then the added ones: the first removed pairs with the first
  // added, and so on, as the line that replaced it.
  const changes = edits.reduce<Edit[][]>((runs, edit, index) => {
    if (edit.kind === 'unchanged') return runs;
    const run = runs.at(-1);
    if (run !== undefined && edits[index - 1]?.kind !== 'unchanged') {
      run.push(edit);
    } else {
      runs.push([edit]);
    }
    return runs;
  }, []);
  const marks = new Map<Edit, readonly Range[]>();
  for (const change of changes) {
    const added = change.filter(edit => edit.kind === 'added');
    change
      .filter(edit => edit.kind === 'removed')
      .forEach((removed, index) => {
        const replacement = added[index];
        if (replacement === undefined) return;
        const words = changedWords(textOf(removed), textOf(replacement));
        if (words === undefined) return;
        marks.set(removed, words.before);
        marks.set(replacement, words.after);
      });
  }

  const lines = edits.map(edit => ({
    kind: edit.kind,
    line: lineOf(edit),
    number: edit.kind === 'removed' ? edit.before + 1 : edit.after + 1,
    marks: marks.get(edit) ?? [],
  }));
  const heads = new Set([0, firstCodeLine(beforeLines)]);
  const kept = new Set(
    edits.flatMap((edit, index) =>
      edit.kind === 'unchanged' && heads.has(edit.before) ? [index] : [],
    ),
  );
  return foldUnchanged(lines, {
    context: CONTEXT_LINES,
    minFolded: MIN_FOLDED_LINES,
    maxWhole: MAX_WHOLE_LINES,
    kept,
  });
};

/** A line's code, its changed words marked. */
const lineCode = (
  { kind, line, marks }: DiffLine,
  renderSymbol: CodeProps['renderSymbol'],
): ReactNode => {
  const render = renderToken(renderSymbol);
  if (marks.length === 0) return line.tokens.map(render);
  // Consecutive marked pieces share one mark.
  const runs = markTokens(line.tokens, marks).reduce<
    { isMarked: boolean; tokens: CodeLine['tokens'][number][] }[]
  >((current, { isMarked, ...token }) => {
    const run = current.at(-1);
    if (run?.isMarked === isMarked) {
      run.tokens.push(token);
    } else {
      current.push({ isMarked, tokens: [token] });
    }
    return current;
  }, []);
  return runs.map(({ isMarked, tokens }, index) =>
    isMarked ? (
      // A run is its place in the line: the line is fixed for the card's life.
      <mark key={index} className={cn('rounded-[0.2em] text-inherit', LINE_STYLES[kind].mark)}>
        {tokens.map(render)}
      </mark>
    ) : (
      tokens.map(render)
    ),
  );
};

/**
 * A card's change: the whole function as an inline diff, its removed and added lines marked and the
 * rest dimmed. Unchanged lines far from the change fold away behind a row that a tap expands. It
 * bleeds to the edges of the card it sits on (`--card-inset`), as a diff's coloured lines do in an
 * editor. Its `layout`, and its names, as `CodeBlock`'s.
 */
export const CodeDiff = ({
  before,
  after,
  symbols,
  renderSymbol,
  layout,
}: Omit<CodeProps, 'text'> & {
  readonly before: string;
  readonly after: string;
  readonly layout: NumberedLayout;
}) => {
  const segments = useMemo(
    () => diffSegments(before, after, new Set(symbols)),
    [before, after, symbols],
  );
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set());
  const classes = NUMBERED_LAYOUTS[layout];
  // Wide enough for either side's numbers, so the gutter never shifts.
  const digits = String(Math.max(splitLines(before).length, splitLines(after).length)).length;
  const gutterClass = cn('flex flex-none select-none pl-[var(--card-inset,0px)]', classes.gutter);
  // The number column, then the sign's.
  const numberStyle = { width: `${digits}ch` };

  return (
    <pre className={cn(preClass, classes.pre, '-mx-[var(--card-inset,0px)]')}>
      <code className={classes.code}>
        {segments.map((segment, segmentIndex) => {
          if (segment.isFolded && !unfolded.has(segmentIndex)) {
            const count = segment.lines.length;
            return (
              <button
                // A segment is its place in the diff: the diff is fixed for the card's life.
                key={segmentIndex}
                type="button"
                className={cn(
                  'flex min-h-[2.1em] w-full cursor-pointer items-center border-y border-rule bg-card-sunk font-sans text-ink-soft pointer-coarse:min-h-11',
                  'transition-[background-color,color] duration-150 hover:bg-petal-wash hover:text-wine focus-visible:-outline-offset-3',
                )}
                onClick={() => setUnfolded(current => new Set([...current, segmentIndex]))}
                aria-label={`Show ${count} unchanged lines`}
              >
                <span className={cn(gutterClass, 'items-center')}>
                  <span className="grid justify-items-end" style={numberStyle}>
                    <ArrowsOutLineVerticalIcon
                      className="size-[1.1em]"
                      weight="bold"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="w-[2ch]" />
                </span>
                <span className="whitespace-nowrap text-[0.92em] font-semibold pointer-fine:sticky pointer-fine:left-[calc(var(--card-inset,0px)_+_2ch)]">
                  {count} unchanged lines
                </span>
              </button>
            );
          }
          return segment.lines.map((diffLine, lineIndex) => {
            const style = LINE_STYLES[diffLine.kind];
            const { Content } = style;
            const { indent } = diffLine.line;
            return (
              <span
                // A line is its place in the diff: the diff is fixed for the card's life.
                key={`${segmentIndex}:${lineIndex}`}
                className={cn('flex pr-[var(--card-inset,0px)]', style.row)}
              >
                {/* Faint on purpose, and hidden from screen readers: an editor's gutter, not
                    content. <del> and <ins> say what a line is. */}
                <span className={gutterClass} aria-hidden="true">
                  <span className={cn('text-right tabular-nums', style.number)} style={numberStyle}>
                    {diffLine.number}
                  </span>
                  <span className={cn('w-[2ch] text-center', style.signClass)}>{style.sign}</span>
                </span>
                <Content
                  className={cn('min-h-lh min-w-0 flex-1 no-underline', style.content)}
                  style={{ paddingLeft: `${indent}ch`, textIndent: `-${indent}ch` }}
                >
                  {lineCode(diffLine, renderSymbol)}
                </Content>
              </span>
            );
          });
        })}
      </code>
    </pre>
  );
};
