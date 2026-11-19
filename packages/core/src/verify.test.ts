import { describe, expect, it } from 'vitest';
import {
  errorsIn,
  failed,
  firstErrorIn,
  formatVerdict,
  hasSourceErrors,
  isTypeScriptFile,
  oneLine,
  parsePorcelainStatus,
  skipped,
  typecheckFiles,
  typecheckTsconfig,
  verified,
} from './verify';

describe('isTypeScriptFile', () => {
  it('matches .ts, .tsx, .mts, .cts only', () => {
    expect(['a.ts', 'a.tsx', 'a.mts', 'a.cts'].every(isTypeScriptFile)).toBe(true);
    expect(['a.js', 'a.jsx', 'a.ts.md', 'a.d'].some(isTypeScriptFile)).toBe(false);
  });
});

describe('oneLine', () => {
  it('collapses whitespace runs and newlines to single spaces and trims', () => {
    expect(oneLine('  hello \n\n world \t foo   ')).toBe('hello world foo');
  });
});

describe('formatVerdict', () => {
  it('formats verified', () => {
    expect(formatVerdict(verified)).toBe('verified');
  });

  it('formats skipped with one-line reason', () => {
    expect(
      formatVerdict(
        skipped(`line 1
        line 2   extra spaces`),
      ),
    ).toBe('skipped: line 1 line 2 extra spaces');
  });

  it('formats failed with one-line reason', () => {
    expect(
      formatVerdict(
        failed(`error occurred:
        connection lost`),
      ),
    ).toBe('failed: error occurred: connection lost');
  });
});

describe('typecheckFiles', () => {
  const card = (operation: string, after: string) => ({
    operation,
    change: 'Changed it.',
    principle: { id: 'p', statement: 'Do it.' },
    stance: 'supports' as const,
    kind: 'explore' as const,
    after,
  });
  const answer = {
    target: { file: 'src/f.tsx', symbol: 'f', text: 'function f() {}' },
    reason: 'r',
    context: [{ file: 'src/t.ts', symbol: 'T', text: 'type T = 1;' }],
    imports: ["import x from 'x';"],
    cards: [card('a', 'function f() { return; }'), card('b', 'const f = () => {};')],
  };

  it("writes the original and each card's after with the imports and context", () => {
    const files = typecheckFiles(answer);
    expect(files.original).toEqual({
      name: '.codetinder-typecheck-original.tsx',
      text: "import x from 'x';\n\ntype T = 1;\n\nfunction f() {}",
    });
    expect(files.cards.map(({ name, card }) => [name, card.operation])).toEqual([
      ['.codetinder-typecheck-card-1.tsx', 'a'],
      ['.codetinder-typecheck-card-2.tsx', 'b'],
    ]);
  });

  it('uses .ts for any other TypeScript file', () => {
    const files = typecheckFiles({ ...answer, target: { ...answer.target, file: 'src/f.mts' } });
    expect(files.original.name).toBe('.codetinder-typecheck-original.ts');
  });
});

describe('typecheckTsconfig', () => {
  it('checks only the given files, each as its own module, without unused checks', () => {
    expect(
      JSON.parse(typecheckTsconfig({ extendsPath: '/repo/tsconfig.json', files: ['a.ts'] })),
    ).toMatchObject({
      extends: '/repo/tsconfig.json',
      compilerOptions: {
        moduleDetection: 'force',
        noUnusedLocals: false,
        noUnusedParameters: false,
      },
    });
  });
});

describe('hasSourceErrors / errorsIn / firstErrorIn', () => {
  const tscOutput = [
    'src/a.ts(1,2): error TS2304: Cannot find name "x".',
    'src/b.ts(3,4): error TS2322: Type mismatch.',
    'src/tsconfig.json(1,1): error TS5000: Bad config.',
  ].join('\n');

  it('detects errors in sources only', () => {
    expect(hasSourceErrors(tscOutput)).toBe(true);
    expect(hasSourceErrors('error TS5000: Bad config.')).toBe(false);
  });

  it('gives every error in a file with the text of its line, and none for a clean file', () => {
    const output = [
      'src/a.ts(2,3): error TS2448: Block-scoped variable used before its declaration.',
      'src/b.ts(1,1): error TS2322: Type mismatch.',
      'src/a.ts(3,1): error TS2304: Cannot find name "y".',
    ].join('\n');
    expect(errorsIn(output, { name: 'a.ts', text: 'const a = 1;\n  id: x,\ny;' })).toEqual([
      'error TS2448: Block-scoped variable used before its declaration.\n  at: id: x,',
      'error TS2304: Cannot find name "y".\n  at: y;',
    ]);
    expect(errorsIn(output, { name: 'c.ts', text: '' })).toEqual([]);
  });

  it('keeps the indented lines that continue an error, and only its own', () => {
    const output = [
      "src/a.ts(1,7): error TS2322: Type '{ port: string; }' is not assignable to type 'Config'.",
      "  Types of property 'port' are incompatible.",
      "    Type 'string' is not assignable to type 'number'.",
      'tsconfig.json(1,1): error TS5000: Bad config.',
      '  A continuation of the config error.',
    ].join('\n');
    expect(
      errorsIn(output, { name: 'a.ts', text: "const config: Config = { port: '1' };" }),
    ).toEqual([
      [
        "error TS2322: Type '{ port: string; }' is not assignable to type 'Config'.",
        "  Types of property 'port' are incompatible.",
        "    Type 'string' is not assignable to type 'number'.",
        "  at: const config: Config = { port: '1' };",
      ].join('\n'),
    ]);
    expect(firstErrorIn(output, 'a.ts')).toBe(
      "error TS2322: Type '{ port: string; }' is not assignable to type 'Config'.",
    );
  });

  it('returns the first error for a file without the location prefix', () => {
    expect(firstErrorIn(tscOutput, 'a.ts')).toBe('error TS2304: Cannot find name "x".');
    expect(firstErrorIn(tscOutput, 'missing.ts')).toBeUndefined();
  });
});

describe('parsePorcelainStatus', () => {
  it('reads modified, deleted and untracked paths, unquoted', () => {
    expect(
      parsePorcelainStatus(' M src/f.ts\0 D old.ts\0?? src/new file.ts\0?? src/café.ts\0'),
    ).toEqual([
      { path: 'src/f.ts', isUntracked: false },
      { path: 'old.ts', isUntracked: false },
      { path: 'src/new file.ts', isUntracked: true },
      { path: 'src/café.ts', isUntracked: true },
    ]);
  });

  it('reads a rename as its new and its old path', () => {
    expect(parsePorcelainStatus('R  src/g.ts\0src/f.ts\0 M package.json\0')).toEqual([
      { path: 'src/g.ts', isUntracked: false },
      { path: 'src/f.ts', isUntracked: false },
      { path: 'package.json', isUntracked: false },
    ]);
  });

  it('reads a clean tree as no changes', () => {
    expect(parsePorcelainStatus('')).toEqual([]);
  });
});
