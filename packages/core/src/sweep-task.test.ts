import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import type { Principle } from './principles';
import { SweepAnswerSchema, type SweepFinding } from './sweep';
import { sweepRewriteTask, sweepTask } from './sweep-task';
import { renderTask } from './tasks';
import { oneLine } from './verify';

const principles: Principle[] = [
  { id: 'early-returns', section: 'General', strength: 'strong', statement: 'Return early.' },
  { id: 'readonly-fields', section: 'TypeScript', strength: 'moderate', statement: 'Readonly.' },
  { id: 'comprehensions', section: 'Python', strength: 'tentative', statement: 'Comprehend.' },
];

const finding: SweepFinding = {
  file: 'src/cart.ts',
  name: 'total',
  principleIds: ['early-returns'],
  why: 'It nests its happy path in two ifs.',
};

describe('sweepTask', () => {
  const task = sweepTask({
    principles,
    changedCode: [
      {
        file: 'src/cart.ts',
        lines: [
          { start: 3, end: 3 },
          { start: 11, end: 14 },
        ],
      },
    ],
    carryOver: [{ file: 'lib/tax.py', name: 'rate' }],
  });

  it('lists the changed code by line ranges, and what the last sweep left', () => {
    expect(task.instructions).toContain('- `src/cart.ts`: lines 3, 11-14');
    expect(task.instructions).toContain('- `rate` in `lib/tax.py`');
    expect(task.instructions).toContain('Name a method as `Class.method`');
  });

  it('gives the principles for the languages of every file it reaches', () => {
    for (const id of ['early-returns', 'readonly-fields', 'comprehensions']) {
      expect(task.instructions).toContain(id);
    }
    const typescriptOnly = sweepTask({
      principles,
      changedCode: [{ file: 'src/a.ts', lines: [{ start: 1, end: 1 }] }],
      carryOver: [],
    });
    expect(typescriptOnly.instructions).not.toContain('comprehensions');
  });

  it('asks for every function worst first, in an answer its schema decodes', () => {
    expect(renderTask(task)).toContain('"functions"');
    const decode = Schema.decodeUnknownResult(SweepAnswerSchema);
    expect(Result.isSuccess(decode({ functions: [finding] }))).toBe(true);
    expect(Result.isSuccess(decode({ functions: [] }))).toBe(true);
    expect(Result.isFailure(decode({ functions: [{ ...finding, principleIds: [] }] }))).toBe(true);
    expect(Result.isFailure(decode({ functions: [{ ...finding, why: '' }] }))).toBe(true);
  });
});

describe('sweepRewriteTask', () => {
  it('names exactly the functions to rewrite, each with its principles and why', () => {
    const { instructions } = sweepRewriteTask({ functions: [finding], principles });
    expect(instructions).toContain(
      '- `total` in `src/cart.ts`: breaks `early-returns`. It nests its happy path in two ifs.',
    );
    expect(instructions).toContain('readonly-fields');
    expect(instructions).not.toContain('comprehensions');
    expect(instructions).not.toContain('previous rewrite failed');
  });

  it('limits the rewrite to what the principles call for, and to symbols it has read every use of', () => {
    const { instructions } = sweepRewriteTask({ functions: [finding], principles });
    expect(oneLine(instructions)).toContain("No unrelated tidying: don't remove an import");
    expect(oneLine(instructions)).toContain('leave the project compiling');
    expect(oneLine(instructions)).toContain('find every use yourself: read the whole file');
    expect(oneLine(instructions)).toContain('ranked snippets that leave matches out');
  });

  it('keeps the summary to the code changes, never whether a check ran', () => {
    const { instructions } = sweepRewriteTask({ functions: [finding], principles });
    expect(oneLine(instructions)).toContain(
      'Your summary describes only the code changes you made and why.',
    );
  });

  it("is the retry when given the tests' failing output", () => {
    const { instructions } = sweepRewriteTask({
      functions: [finding],
      principles,
      previousFailure: 'FAIL cart.test.ts',
    });
    expect(instructions).toContain('The previous rewrite failed the tests');
    expect(instructions).toContain('FAIL cart.test.ts');
  });
});
