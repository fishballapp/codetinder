import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { fence } from './fence';
import type { Principle } from './principles';
import { RewriteAnswerSchema, renderTask, rewriteTask } from './tasks';
import { oneLine } from './verify';

const principles: Principle[] = [
  { id: 'early-returns', section: 'General', strength: 'strong', statement: 'Return early.' },
];

const languagePrinciples: Principle[] = [
  ...principles,
  { id: 'readonly-fields', section: 'TypeScript', strength: 'moderate', statement: 'Readonly.' },
  { id: 'comprehensions', section: 'Python', strength: 'tentative', statement: 'Comprehend.' },
];

const mergeRequestFiles = ['src/f.ts', 'README.md'];

const sampleDiff = 'diff --git a/src/f.ts b/src/f.ts\n+function f() { return 1; }';

describe('rewriteTask', () => {
  it('shows the diff and the principles', () => {
    const printed = renderTask(
      rewriteTask({ mergeRequestIid: 3, diff: sampleDiff, mergeRequestFiles, principles }),
    );
    expect(printed).toContain('## The diff');
    expect(printed).toContain(sampleDiff);
    expect(printed).toContain('- early-returns (strong): Return early.');
  });

  it("shows only the General principles and the sections of the merge request's languages", () => {
    const printed = renderTask(
      rewriteTask({
        mergeRequestIid: 3,
        diff: sampleDiff,
        mergeRequestFiles: ['app/main.py'],
        principles: languagePrinciples,
      }),
    );
    expect(printed).toContain('### General\n\n- early-returns (strong): Return early.');
    expect(printed).toContain('### Python\n\n- comprehensions (tentative): Comprehend.');
    expect(printed).not.toContain('readonly-fields');
    expect(oneLine(printed)).toContain(
      'Apply a "General" principle to every file, a language\'s only to that language\'s files.',
    );
  });

  it('limits the rewrite to what the principles call for, and to symbols it has read every use of', () => {
    const printed = oneLine(
      renderTask(
        rewriteTask({ mergeRequestIid: 3, diff: sampleDiff, mergeRequestFiles, principles }),
      ),
    );
    expect(printed).toContain("No unrelated tidying: don't remove an import");
    expect(printed).toContain('leave the project compiling');
    expect(printed).toContain('find every use yourself: read the whole file');
    expect(printed).toContain('ranked snippets that leave matches out');
  });

  it('keeps the summary to the code changes, never whether a check ran', () => {
    const printed = oneLine(
      renderTask(
        rewriteTask({ mergeRequestIid: 3, diff: sampleDiff, mergeRequestFiles, principles }),
      ),
    );
    expect(printed).toContain('Your summary describes only the code changes you made and why.');
    expect(printed).toContain('Never say whether tests, the typecheck or any other check ran');
    expect(printed).toContain('"description": "What the code changes are and why');
  });

  it('says nothing of a previous rewrite the first time', () => {
    const printed = renderTask(
      rewriteTask({ mergeRequestIid: 3, diff: sampleDiff, mergeRequestFiles, principles }),
    );
    expect(printed).not.toContain('previous rewrite');
  });

  it('asks the retry to fix the previous rewrite, showing the failed tests’ output', () => {
    const output = 'FAIL src/f.test.ts\n  expected 1, got 2';
    const printed = renderTask(
      rewriteTask({
        mergeRequestIid: 3,
        diff: sampleDiff,
        mergeRequestFiles,
        principles,
        previousFailure: output,
      }),
    );
    const [, retry] = printed.split('## The previous rewrite failed the tests');
    expect(retry).toBeDefined();
    expect(retry).toContain(fence(output));
    expect(oneLine(retry!)).toContain('still in the working tree');
    expect(oneLine(retry!)).toContain(
      'or undo the part of it that broke the build or changed behaviour',
    );
    expect(printed).toContain('- early-returns (strong): Return early.');
  });

  it('decodes the agent report', () => {
    const decode = Schema.decodeUnknownResult(RewriteAnswerSchema);
    expect(
      Result.isSuccess(decode({ summary: 'Early returns.', appliedPrincipleIds: ['a'] })),
    ).toBe(true);
    expect(Result.isFailure(decode({ summary: '', appliedPrincipleIds: [] }))).toBe(true);
  });
});
