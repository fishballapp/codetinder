/** One item of a diff between two sequences, by its index in each. */
export type Edit =
  | { readonly kind: 'unchanged'; readonly before: number; readonly after: number }
  | { readonly kind: 'removed'; readonly before: number }
  | { readonly kind: 'added'; readonly after: number };

/**
 * The shortest edit from `before` to `after`, through their longest common subsequence. Within a
 * change, removals come before additions, as in a unified diff.
 */
export const diff = <T>(before: readonly T[], after: readonly T[]): Edit[] => {
  // A card changes a little of a long function: what the two share at either end needs no table.
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);

  // How long a common subsequence a[i..] and b[j..] have.
  const common = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = common[i];
      if (row === undefined) throw new Error(`no row ${i}`);
      row[j] =
        a[i] === b[j]
          ? (common[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(common[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const middle: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      middle.push({ kind: 'unchanged', before: prefix + i++, after: prefix + j++ });
    } else if (
      j === b.length ||
      (i < a.length && (common[i + 1]?.[j] ?? 0) >= (common[i]?.[j + 1] ?? 0))
    ) {
      middle.push({ kind: 'removed', before: prefix + i++ });
    } else {
      middle.push({ kind: 'added', after: prefix + j++ });
    }
  }

  return [
    ...Array.from({ length: prefix }, (_, k) => ({
      kind: 'unchanged' as const,
      before: k,
      after: k,
    })),
    ...middle,
    ...Array.from({ length: suffix }, (_, k) => ({
      kind: 'unchanged' as const,
      before: before.length - suffix + k,
      after: after.length - suffix + k,
    })),
  ];
};

/** A text's lines, a final newline ending the last one rather than starting another. */
const linesOf = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');

/**
 * `before` against `after` as a unified diff's hunks, without file headers: each change with up to
 * `context` unchanged lines either side, under its `@@ -start,count +start,count @@` line. Changes
 * whose context meets share a hunk. Empty when the texts are equal.
 */
export const unifiedDiff = (
  before: string,
  after: string,
  { context }: { readonly context: number },
): string => {
  const beforeLines = linesOf(before);
  const afterLines = linesOf(after);
  const edits = diff(beforeLines, afterLines);
  const hunks = edits
    .flatMap((edit, index) => (edit.kind === 'unchanged' ? [] : [index]))
    .reduce<{ start: number; end: number }[]>((ranges, change) => {
      const start = Math.max(0, change - context);
      const end = Math.min(edits.length, change + context + 1);
      const last = ranges.at(-1);
      if (last !== undefined && start <= last.end) {
        return [...ranges.slice(0, -1), { start: last.start, end }];
      }
      return [...ranges, { start, end }];
    }, []);

  const isBefore = (edit: Edit) => edit.kind !== 'added';
  const isAfter = (edit: Edit) => edit.kind !== 'removed';
  /** One side's range in a hunk's header: its first line, or the one before when it has none. */
  const range = (
    { start, end }: { start: number; end: number },
    isSide: (edit: Edit) => boolean,
  ) => {
    const preceding = edits.slice(0, start).filter(isSide).length;
    const count = edits.slice(start, end).filter(isSide).length;
    return `${count === 0 ? preceding : preceding + 1},${count}`;
  };
  const lineOf = (edit: Edit) => {
    if (edit.kind === 'removed') return `-${beforeLines[edit.before]}`;
    if (edit.kind === 'added') return `+${afterLines[edit.after]}`;
    return ` ${beforeLines[edit.before]}`;
  };
  return hunks
    .map(hunk =>
      [
        `@@ -${range(hunk, isBefore)} +${range(hunk, isAfter)} @@`,
        ...edits.slice(hunk.start, hunk.end).map(lineOf),
      ].join('\n'),
    )
    .join('\n');
};
