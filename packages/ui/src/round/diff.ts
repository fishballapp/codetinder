import { diff, type Edit } from '@codetinder/core';

/** A run of a diff's lines: shown, or folded away behind one row a tap expands. */
export type DiffSegment<Line> = { readonly isFolded: boolean; readonly lines: readonly Line[] };

/**
 * A diff's lines in runs, the unchanged ones further than `context` from every change folded, each
 * fold hiding at least `minFolded` (a fold row hiding fewer would barely save room). A diff of at
 * most `maxWhole` lines reads at a glance, so it is shown whole, as is one without a change. The
 * lines at `kept` indexes are never folded: a fold stops either side of them.
 */
export const foldUnchanged = <Line extends { readonly kind: Edit['kind'] }>(
  lines: readonly Line[],
  {
    context,
    minFolded,
    maxWhole,
    kept = new Set(),
  }: {
    readonly context: number;
    readonly minFolded: number;
    readonly maxWhole: number;
    readonly kept?: ReadonlySet<number>;
  },
): DiffSegment<Line>[] => {
  const changes = lines.flatMap((line, index) => (line.kind === 'unchanged' ? [] : [index]));
  if (lines.length <= maxWhole || changes.length === 0) return [{ isFolded: false, lines }];
  const isNearChange = (index: number) =>
    changes.some(change => Math.abs(change - index) <= context);

  const runs: DiffSegment<Line>[] = [];
  lines.forEach((line, index) => {
    const isFolded = !isNearChange(index) && !kept.has(index);
    const last = runs.at(-1);
    if (last?.isFolded === isFolded) {
      runs[runs.length - 1] = { isFolded, lines: [...last.lines, line] };
    } else {
      runs.push({ isFolded, lines: [line] });
    }
  });

  // A fold too short to be worth its row is shown, joining the runs either side of it.
  return runs
    .map(run => (run.isFolded && run.lines.length < minFolded ? { ...run, isFolded: false } : run))
    .reduce<DiffSegment<Line>[]>((segments, run) => {
      const last = segments.at(-1);
      if (last !== undefined && !last.isFolded && !run.isFolded) {
        return [
          ...segments.slice(0, -1),
          { isFolded: false, lines: [...last.lines, ...run.lines] },
        ];
      }
      return [...segments, run];
    }, []);
};

/** A span of a line's characters: `[start, end)`. */
export type Range = readonly [start: number, end: number];

/** Words, runs of white space, and each other character alone. */
const WORD = /\w+|\s+|[^\w\s]/g;

/** How much two lines must share, as a share of their length, for marking their words to help. */
const MIN_SHARED = 0.5;

/**
 * Where two versions of one line differ, word by word: the ranges of each that the other lacks.
 * Undefined when they share too little for the marks to say more than the line's own colour does.
 * A change of white space alone (a line indented anew) isn't marked.
 */
export const changedWords = (
  before: string,
  after: string,
): { readonly before: readonly Range[]; readonly after: readonly Range[] } | undefined => {
  const beforeWords = before.match(WORD) ?? [];
  const afterWords = after.match(WORD) ?? [];
  const edits = diff(beforeWords, afterWords);
  const shared = edits
    .filter(edit => edit.kind === 'unchanged')
    .reduce((total, { before: index }) => total + (beforeWords[index]?.trim().length ?? 0), 0);
  const length = before.trim().length + after.trim().length;
  if (length === 0 || (2 * shared) / length < MIN_SHARED) return undefined;

  /** The ranges of the words in `side` that `isChanged` picks, neighbours joined. */
  const rangesOf = (words: readonly string[], isChanged: (index: number) => boolean): Range[] => {
    const ranges: [number, number][] = [];
    let offset = 0;
    words.forEach((word, index) => {
      const start = offset;
      offset += word.length;
      const last = ranges.at(-1);
      if (!isChanged(index)) {
        // White space between two changed words joins them into one mark.
        if (last?.[1] === start && word.trim() === '' && isChanged(index + 1)) last[1] = offset;
        return;
      }
      if (last?.[1] === start) {
        last[1] = offset;
      } else {
        ranges.push([start, offset]);
      }
    });
    // A mark starts and ends on a word: changed indentation around it isn't the change.
    const text = words.join('');
    return ranges.flatMap(([start, end]): Range[] => {
      const marked = text.slice(start, end);
      const trimmedStart = start + marked.length - marked.trimStart().length;
      const trimmedEnd = end - (marked.length - marked.trimEnd().length);
      return trimmedStart < trimmedEnd ? [[trimmedStart, trimmedEnd]] : [];
    });
  };

  const removed = new Set(edits.flatMap(edit => (edit.kind === 'removed' ? [edit.before] : [])));
  const added = new Set(edits.flatMap(edit => (edit.kind === 'added' ? [edit.after] : [])));
  return {
    before: rangesOf(beforeWords, index => removed.has(index)),
    after: rangesOf(afterWords, index => added.has(index)),
  };
};
