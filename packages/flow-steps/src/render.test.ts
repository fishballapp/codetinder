import {
  LEARN_STATE_FILES,
  PRINCIPLES_PATH,
  type Principle,
  renderPrinciplesDoc,
} from '@codetinder/core';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as TestConsole from 'effect/testing/TestConsole';
import { memoryFileSystem } from './memory-file-system';
import { runRender } from './render';
import { SESSION_LOG_FILE } from './session-log';

const earlyReturns: Principle = {
  id: 'early-returns',
  section: 'General',
  strength: 'moderate',
  statement: 'Return early on a failed check.',
};

const ruleEdit = {
  path: 'CONTRIBUTING.md',
  rule: 'Always write else.',
  replacement: '',
  principleId: 'early-returns',
} as const;

const validAnswer = JSON.stringify({
  operations: [
    { op: 'strengthen', id: 'early-returns' },
    {
      op: 'add',
      id: 'readonly-fields',
      section: 'TypeScript',
      statement: 'Mark fields readonly.',
    },
    { op: 'drop', id: 'nowhere' },
  ],
  writtenRuleEdits: [ruleEdit],
});

const withDoc = (files: Record<string, string>) =>
  memoryFileSystem({ [PRINCIPLES_PATH]: renderPrinciplesDoc([earlyReturns]), ...files });

const provide = (fs: ReturnType<typeof memoryFileSystem>) =>
  Effect.provide(Layer.mergeAll(fs.layer, Path.layer, TestConsole.layer));

describe('runRender', () => {
  it.effect(
    "applies the answer's operations to the doc, and keeps what it learned for propose",
    () =>
      Effect.gen(function* () {
        const fs = withDoc({ 'answer.json': validAnswer });
        yield* runRender('answer.json').pipe(provide(fs));
        expect(fs.read(PRINCIPLES_PATH)).toContain(
          '## General\n\n### early-returns · strong\nReturn early on a failed check.\n\n## TypeScript\n\n### readonly-fields · tentative',
        );
        expect(fs.read('AGENTS.md')).toBeUndefined();
        expect(JSON.parse(fs.read(LEARN_STATE_FILES.principles) ?? '')).toEqual({
          principles: [
            { ...earlyReturns, strength: 'strong' },
            {
              id: 'readonly-fields',
              section: 'TypeScript',
              strength: 'tentative',
              statement: 'Mark fields readonly.',
            },
          ],
          skipped: [
            { operation: { op: 'drop', id: 'nowhere' }, reason: '"nowhere" is not in the doc' },
          ],
          writtenRuleEdits: [ruleEdit],
        });
        expect(fs.read(SESSION_LOG_FILE)).toBe(
          `- Updated ${PRINCIPLES_PATH}: 1 strengthened, 1 added.\n`,
        );
      }),
  );

  it.effect('applies a narrow only when the cards the learn task kept back it', () =>
    Effect.gen(function* () {
      const narrow = JSON.stringify({
        operations: [
          {
            op: 'narrow',
            id: 'early-returns',
            exception: { id: 'single-check', statement: 'A single check may stay inline.' },
            difference: 'The contradicting cards check one thing.',
            confirming: ['c1'],
            contradicting: ['c2', 'ABCDEFGHIJKL/c3'],
          },
        ],
        writtenRuleEdits: [],
      });
      const narrowed = (citations: Record<string, number>) =>
        Effect.gen(function* () {
          const fs = withDoc({
            'answer.json': narrow,
            [LEARN_STATE_FILES.citations]: JSON.stringify(citations),
          });
          yield* runRender('answer.json').pipe(provide(fs));
          return fs.read(PRINCIPLES_PATH) ?? '';
        });
      expect(yield* narrowed({ c1: 1, c2: 1, 'ABCDEFGHIJKL/c3': 1 })).toContain(
        '#### Exception · single-check · tentative\nA single check may stay inline.',
      );
      expect(yield* narrowed({ c1: 1, c2: 1 })).not.toContain('single-check');
    }),
  );

  it.effect('starts a project with no doc from no principles', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({ 'answer.json': validAnswer });
      yield* runRender('answer.json').pipe(provide(fs));
      expect(fs.read(PRINCIPLES_PATH)).toContain('### readonly-fields · tentative');
      expect(fs.read(PRINCIPLES_PATH)).not.toContain('early-returns');
    }),
  );

  it.effect('fails on a doc out of format when the answer converted none of it', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({ [PRINCIPLES_PATH]: '# Style', 'answer.json': validAnswer });
      const error = yield* runRender('answer.json').pipe(provide(fs), Effect.flip);
      expect(error).toMatchObject({
        _tag: 'UserError',
        userMessage:
          'the answer is invalid: the doc was out of format, and the answer converted none of its rules',
      });
    }),
  );

  it.effect('reads an answer in a code fence and says it rendered, for the router', () =>
    Effect.gen(function* () {
      const fs = withDoc({ 'answer.json': `\`\`\`json\n${validAnswer}\n\`\`\`` });
      yield* runRender('answer.json').pipe(provide(fs));
      expect(fs.read('.codetinder/principles.md')).toContain('### early-returns · strong');
      expect(yield* TestConsole.logLines).toEqual(['rendered']);
    }),
  );

  it.effect('fails on a bad answer file', () =>
    Effect.gen(function* () {
      const fs = withDoc({ 'answer.json': '{"operations":"nope"}' });
      const error = yield* runRender('answer.json').pipe(provide(fs), Effect.flip);
      expect(error).toMatchObject({
        _tag: 'UserError',
        userMessage: expect.stringContaining('the answer is invalid'),
      });
    }),
  );
});
