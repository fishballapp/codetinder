import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';
import {
  type CommitAdditions,
  nextCarryOver,
  parseChangedCode,
  parseLogNumstat,
  parseNumstat,
  pickSweep,
  SWEEP_CARRY_OVER_LIMIT,
  SWEEP_FUNCTION_LIMIT,
  type SweepFinding,
  sweepBranch,
  sweepLineCount,
  walkToFirstSweepBase,
} from './sweep';

describe('sweepLineCount', () => {
  it('counts the lines added to code files only', () => {
    expect(
      sweepLineCount([
        { path: 'src/cart.ts', addedLines: 40 },
        { path: 'README.md', addedLines: 300 },
        { path: 'pnpm-lock.yaml', addedLines: 900 },
        { path: 'Makefile', addedLines: 2 },
      ]),
    ).toBe(42);
  });

  it('is zero for no files', () => {
    expect(sweepLineCount([])).toBe(0);
  });
});

describe('parseNumstat', () => {
  it("reads each file's added lines, a binary file adding none", () => {
    expect(parseNumstat('12\t3\tsrc/cart.ts\x000\t9\tsrc/old.ts\x00-\t-\tlogo.png\x00')).toEqual([
      { path: 'src/cart.ts', addedLines: 12 },
      { path: 'src/old.ts', addedLines: 0 },
      { path: 'logo.png', addedLines: 0 },
    ]);
  });

  it('reads nothing from no output', () => {
    expect(parseNumstat('')).toEqual([]);
  });
});

describe('parseLogNumstat', () => {
  it("reads each commit's first parent and the lines it adds, a binary file adding none", () => {
    const output = [
      // An empty commit, then a merge with its diff against its first parent, then the root.
      'commit p1\0',
      'commit p2 side\0\n-\t-\tlogo.png\0',
      '7\t0\tsrc/tax.ts\0',
      'commit p3\0\n2\t1\tsrc/cart.ts\0',
      'commit \0\n10\t0\tsrc/app.ts\0',
    ].join('');
    expect(parseLogNumstat(output)).toEqual([
      { firstParent: 'p1', files: [] },
      {
        firstParent: 'p2',
        files: [
          { path: 'logo.png', addedLines: 0 },
          { path: 'src/tax.ts', addedLines: 7 },
        ],
      },
      { firstParent: 'p3', files: [{ path: 'src/cart.ts', addedLines: 2 }] },
      { firstParent: null, files: [{ path: 'src/app.ts', addedLines: 10 }] },
    ]);
  });

  it('reads nothing from no output', () => {
    expect(parseLogNumstat('')).toEqual([]);
  });
});

describe('walkToFirstSweepBase', () => {
  const commit = (firstParent: string | null, files: Record<string, number>): CommitAdditions => ({
    firstParent,
    files: Object.entries(files).map(([path, addedLines]) => ({ path, addedLines })),
  });
  // Newest first: c4's parent is c3, and so on back to the root.
  const history = [
    commit('c3', { 'src/a.ts': 40 }),
    commit('c2', { 'README.md': 500, 'pnpm-lock.yaml': 900 }),
    commit('c1', { 'src/b.ts': 60, 'logo.png': 0 }),
    commit(null, { 'src/c.ts': 30 }),
  ];

  it('starts from the parent of the commit whose lines reach the threshold exactly', () => {
    expect(walkToFirstSweepBase({ commits: history, threshold: 100 })).toEqual({
      _tag: 'Base',
      sha: 'c1',
      lines: 100,
    });
  });

  it('takes the whole commit that crosses the threshold', () => {
    expect(walkToFirstSweepBase({ commits: history, threshold: 50 })).toEqual({
      _tag: 'Base',
      sha: 'c1',
      lines: 100,
    });
  });

  it('skips commits that add no code', () => {
    expect(walkToFirstSweepBase({ commits: history, threshold: 41 })).toEqual({
      _tag: 'Base',
      sha: 'c1',
      lines: 100,
    });
  });

  it('counts a merge as its diff against its first parent, and starts from that parent', () => {
    const merge = commit('main-before', { 'src/feature.ts': 120 });
    expect(walkToFirstSweepBase({ commits: [merge], threshold: 100 })).toEqual({
      _tag: 'Base',
      sha: 'main-before',
      lines: 120,
    });
  });

  it('sweeps the whole history when it is short of the threshold', () => {
    expect(walkToFirstSweepBase({ commits: history, threshold: 5000 })).toEqual({
      _tag: 'Base',
      sha: null,
      lines: 130,
    });
  });

  it('starts from the start of history when the root reaches the threshold', () => {
    expect(walkToFirstSweepBase({ commits: history, threshold: 130 })).toEqual({
      _tag: 'Base',
      sha: null,
      lines: 130,
    });
  });

  it('asks for the commits before the page when it ends short, carrying the count', () => {
    expect(
      walkToFirstSweepBase({ commits: history.slice(0, 3), threshold: 500, lines: 200 }),
    ).toEqual({ _tag: 'Earlier', from: 'c1', lines: 300 });
  });
});

describe('parseChangedCode', () => {
  const diff = [
    'diff --git a/src/cart.ts b/src/cart.ts',
    'index 1111111..2222222 100644',
    '--- a/src/cart.ts',
    '+++ b/src/cart.ts',
    '@@ -3 +3 @@ export const total = 1;',
    '-old',
    '+new',
    '@@ -10,0 +11,4 @@',
    '+a',
    '+++ b/not-a-header.ts',
    '+c',
    '+d',
    '@@ -20,2 +24,0 @@',
    '-gone',
    '-gone',
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/src/old.ts b/src/old.ts',
    'deleted file mode 100644',
    '--- a/src/old.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-x',
    '-y',
    'diff --git a/src/my file.ts b/src/my file.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/my file.ts\t',
    '@@ -0,0 +1,2 @@',
    '+x',
    '+y',
  ].join('\n');

  it('reads the line ranges added to each code file, as the file is now', () => {
    expect(parseChangedCode(diff)).toEqual([
      {
        file: 'src/cart.ts',
        lines: [
          { start: 3, end: 3 },
          { start: 11, end: 14 },
        ],
      },
      { file: 'src/my file.ts', lines: [{ start: 1, end: 2 }] },
    ]);
  });
});

describe('sweepBranch', () => {
  it('names the branch by when the sweep ran, in UTC', () => {
    expect(sweepBranch(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-16T09:30:12Z')))).toBe(
      'codetinder/sweep-2026-10-16-093012',
    );
  });
});

describe('pickSweep', () => {
  const finding = (name: string, file = 'src/cart.ts'): SweepFinding => ({
    file,
    name,
    principleIds: ['early-returns'],
    why: `${name} nests its happy path.`,
  });
  const files = new Map([
    ['src/cart.ts', 'export function total() {}\nconst $price = () => 1;\nfunction subtotal() {}'],
    ['src/cart.test.ts', 'function total() {}'],
  ]);
  const principleIds = new Set(['early-returns', 'small-functions']);

  it('keeps the functions the files it reaches declare, in the order found', () => {
    expect(
      pickSweep({ findings: [finding('subtotal'), finding('$price')], files, principleIds }),
    ).toEqual({ kept: [finding('subtotal'), finding('$price')], left: [], dropped: [] });
  });

  it("drops a function its file doesn't have and a file out of reach or protected, saying why, and a repeat silently", () => {
    const findings = [
      finding('tot'),
      finding('total', 'src/other.ts'),
      finding('total', 'src/cart.test.ts'),
      finding('total'),
      finding('total'),
    ];
    expect(pickSweep({ findings, files, principleIds })).toEqual({
      kept: [finding('total')],
      left: [],
      dropped: [
        { finding: finding('tot'), why: '`src/cart.ts` has no function `tot`' },
        {
          finding: finding('total', 'src/other.ts'),
          why: "`src/other.ts` isn't a code file this sweep reaches and may rewrite",
        },
        {
          finding: finding('total', 'src/cart.test.ts'),
          why: "`src/cart.test.ts` isn't a code file this sweep reaches and may rewrite",
        },
      ],
    });
  });

  it('keeps only the principles the doc has, dropping a function left with none', () => {
    const findings: SweepFinding[] = [
      { ...finding('total'), principleIds: ['made-up', 'small-functions'] },
      { ...finding('subtotal'), principleIds: ['made-up'] },
    ];
    const { kept, dropped } = pickSweep({ findings, files, principleIds });
    expect(kept).toEqual([{ ...finding('total'), principleIds: ['small-functions'] }]);
    expect(dropped).toEqual([
      {
        finding: { ...finding('subtotal'), principleIds: ['made-up'] },
        why: 'none of its principles (`made-up`) is in the principles doc',
      },
    ]);
  });

  it(`rewrites the first ${SWEEP_FUNCTION_LIMIT} and leaves the rest for the next sweep`, () => {
    const names = Array.from({ length: SWEEP_FUNCTION_LIMIT + 2 }, (_, index) => `f${index}`);
    const many = new Map([['src/many.ts', names.map(name => `function ${name}() {}`).join('\n')]]);
    const { kept, left } = pickSweep({
      findings: names.map(name => finding(name, 'src/many.ts')),
      files: many,
      principleIds,
    });
    expect(kept.map(({ name }) => name)).toEqual(names.slice(0, SWEEP_FUNCTION_LIMIT));
    expect(left).toEqual([
      { file: 'src/many.ts', name: `f${SWEEP_FUNCTION_LIMIT}` },
      { file: 'src/many.ts', name: `f${SWEEP_FUNCTION_LIMIT + 1}` },
    ]);
  });

  it('keeps same-named methods of two classes apart, checking the class and the method', () => {
    const views = new Map([
      ['src/views.ts', 'class CartView {\n  render() {}\n}\nclass TaxView {\n  render() {}\n}\n'],
    ]);
    const findings = [
      finding('CartView.render', 'src/views.ts'),
      finding('TaxView.render', 'src/views.ts'),
      finding('CartView.render', 'src/views.ts'),
      finding('FeeView.render', 'src/views.ts'),
      finding('CartView.draw', 'src/views.ts'),
    ];
    expect(
      pickSweep({ findings, files: views, principleIds }).kept.map(({ name }) => name),
    ).toEqual(['CartView.render', 'TaxView.render']);
  });
});

describe('nextCarryOver', () => {
  it('puts the picks a sweep did not rewrite ahead of those it had no room for', () => {
    const unswept: SweepFinding = {
      file: 'src/cart.ts',
      name: 'total',
      principleIds: ['early-returns'],
      why: 'It nests.',
    };
    expect(nextCarryOver([unswept], [{ file: 'src/tax.ts', name: 'rate' }])).toEqual([
      { file: 'src/cart.ts', name: 'total' },
      { file: 'src/tax.ts', name: 'rate' },
    ]);
  });

  it(`keeps at most ${SWEEP_CARRY_OVER_LIMIT}, the worst first`, () => {
    const many = Array.from({ length: SWEEP_CARRY_OVER_LIMIT + 5 }, (_, index) => ({
      file: 'src/many.ts',
      name: `f${index}`,
    }));
    const carried = nextCarryOver(many.slice(0, 3), many.slice(3));
    expect(carried).toHaveLength(SWEEP_CARRY_OVER_LIMIT);
    expect(carried[0]).toEqual({ file: 'src/many.ts', name: 'f0' });
  });
});
