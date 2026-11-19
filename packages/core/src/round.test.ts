import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import {
  assignCardIds,
  buildTypecheckFile,
  type CardKind,
  decodeGenerateAnswer,
  GenerateAnswerSchema,
  RoundAnswerSchema,
  RoundSchema,
  type Stance,
} from './round';

const card = (
  operation: string,
  overrides: Partial<{ kind: CardKind; principleId: string; stance: Stance }> = {},
) => ({
  operation,
  change: `Applied ${operation}.`,
  principle: { id: overrides.principleId ?? 'early-returns', statement: 'Return early.' },
  stance: overrides.stance ?? 'supports',
  kind: overrides.kind ?? 'explore',
  after: `function f() { /* ${operation} */ }`,
});

const cards = Array.from({ length: 6 }, (_, i) => card(`op${i}`));

const answer = {
  target: { file: 'src/f.ts', symbol: 'f', text: 'function f() {}' },
  reason: 'It has the most branching.',
  context: [],
  imports: [],
  cards,
};

const decodeAnswer = Schema.decodeUnknownResult(RoundAnswerSchema);

describe('RoundAnswerSchema', () => {
  it('decodes an answer with no context', () => {
    expect(decodeAnswer(answer)).toEqual(Result.succeed(answer));
  });

  it('takes 4 to 8 cards', () => {
    const withCards = (count: number) =>
      decodeAnswer({ ...answer, cards: Array.from({ length: count }, (_, i) => card(`op${i}`)) });
    expect(Result.isSuccess(withCards(4))).toBe(true);
    expect(Result.isSuccess(withCards(8))).toBe(true);
    expect(Result.isFailure(withCards(3))).toBe(true);
    expect(Result.isFailure(withCards(9))).toBe(true);
  });

  it('takes one consistency pair: two cards on one principle, with opposite stances', () => {
    const withPair = (...pair: ReturnType<typeof card>[]) =>
      decodeAnswer({ ...answer, cards: [...cards.slice(pair.length), ...pair] });
    const half = (stance: Stance, principleId = 'small-functions') =>
      card('Extract Function', { kind: 'consistency', principleId, stance });
    expect(Result.isSuccess(withPair(half('supports'), half('opposes')))).toBe(true);
    expect(Result.isFailure(withPair(half('supports')))).toBe(true);
    expect(Result.isFailure(withPair(half('supports'), half('supports')))).toBe(true);
    expect(Result.isFailure(withPair(half('supports'), half('opposes', 'other')))).toBe(true);
    expect(Result.isFailure(withPair(half('supports'), half('opposes'), half('opposes')))).toBe(
      true,
    );
  });

  it('takes at most 2 boundary cards, each on its own exception', () => {
    const withBoundaries = (...principleIds: string[]) =>
      decodeAnswer({
        ...answer,
        cards: [
          ...cards.slice(principleIds.length),
          ...principleIds.map(principleId =>
            card('Inline Variable', { kind: 'boundary', principleId }),
          ),
        ],
      });
    expect(Result.isSuccess(withBoundaries('inline-single-use', 'flat-loops'))).toBe(true);
    expect(Result.isFailure(withBoundaries('inline-single-use', 'inline-single-use'))).toBe(true);
    expect(Result.isFailure(withBoundaries('inline-single-use', 'flat-loops', 'short-names'))).toBe(
      true,
    );
  });

  it('rejects a principle id that is not kebab-case', () => {
    expect(
      Result.isFailure(
        decodeAnswer({
          ...answer,
          cards: [...cards.slice(1), card('x', { principleId: 'Early' })],
        }),
      ),
    ).toBe(true);
  });

  it('rejects an empty target', () => {
    expect(
      Result.isFailure(
        decodeAnswer({ ...answer, target: { file: 'src/f.ts', symbol: 'f', text: '' } }),
      ),
    ).toBe(true);
  });

  it('describes every field for the agent', () => {
    const document = Schema.toJsonSchemaDocument(RoundAnswerSchema);
    expect(JSON.stringify(document)).toContain('Between 4 and 8 cards');
    expect(JSON.stringify(document)).toContain("Fowler's refactoring catalogue");
    expect(JSON.stringify(document)).toContain("The function's name");
  });
});

describe('RoundSchema', () => {
  it('decodes a round of format 2 only', () => {
    const round = { version: 2, ...answer, cards: assignCardIds(answer.cards) };
    const decode = Schema.decodeUnknownResult(RoundSchema);
    expect(decode(round)).toEqual(Result.succeed(round));
    expect(Result.isFailure(decode({ ...round, version: 1 }))).toBe(true);
  });
});

describe('assignCardIds', () => {
  it('numbers cards in order', () => {
    expect(assignCardIds(cards.slice(0, 2)).map(({ id, operation }) => [id, operation])).toEqual([
      ['c1', 'op0'],
      ['c2', 'op1'],
    ]);
  });
});

describe('buildTypecheckFile', () => {
  it('puts the imports, the context, then the function, separated by blank lines', () => {
    expect(
      buildTypecheckFile({
        imports: ["import { z } from 'zod';", "import * as R from 'remeda';"],
        context: [
          { file: 'src/todo.ts', symbol: 'Todo', text: 'type Todo = { done: boolean };' },
          { file: 'src/limits.ts', symbol: 'MAX', text: 'const MAX = 3;' },
        ],
        functionText: 'function f(todo: Todo) {}',
      }),
    ).toBe(
      [
        "import { z } from 'zod';\nimport * as R from 'remeda';",
        'type Todo = { done: boolean };',
        'const MAX = 3;',
        'function f(todo: Todo) {}',
      ].join('\n\n'),
    );
  });

  it('puts each definition after those it uses, whatever order the agent listed them in', () => {
    // The context of a round that failed with TS2448: the agent listed the schema that uses
    // `AskIdSchema` and `UnfinishedReasonSchema` before them.
    const askId = {
      file: 'packages/api/src/learn.ts',
      symbol: 'AskIdSchema',
      text: "export const AskIdSchema = Schema.String.pipe(Schema.brand('AskId'));",
    };
    const unfinishedReason = {
      file: 'packages/api/src/learn.ts',
      symbol: 'UnfinishedReasonSchema',
      text: "export const UnfinishedReasonSchema = Schema.Literals(['NotStarted', 'Stalled', 'Failed']);",
    };
    const learnAsk = {
      file: 'apps/server/src/learn.ts',
      symbol: 'LearnAskSchema',
      text: [
        "/** One Done's ask to learn the round's swipes, and how its learn run went. */",
        'export const LearnAskSchema = Schema.Struct({',
        '  id: AskIdSchema,',
        '  swipes: Schema.String,',
        '});',
      ].join('\n'),
    };
    const learnAskType = {
      file: 'apps/server/src/learn.ts',
      symbol: 'LearnAsk',
      text: 'export type LearnAsk = typeof LearnAskSchema.Type;',
    };
    const learnState = {
      file: 'packages/api/src/learn.ts',
      symbol: 'LearnStateSchema',
      text: [
        'export const LearnStateSchema = Schema.TaggedUnion({',
        '  NotLearned: {},',
        '  Unfinished: { askId: AskIdSchema, reason: UnfinishedReasonSchema },',
        '});',
      ].join('\n'),
    };
    const file = buildTypecheckFile({
      imports: ["import * as Schema from 'effect/Schema';"],
      context: [learnAsk, learnAskType, askId, unfinishedReason, learnState],
      functionText: 'const f = (ask: LearnAsk) => ask.id;',
    });
    expect(file.split('\n\n')).toEqual([
      "import * as Schema from 'effect/Schema';",
      askId.text,
      learnAsk.text,
      learnAskType.text,
      unfinishedReason.text,
      learnState.text,
      'const f = (ask: LearnAsk) => ask.id;',
    ]);
  });

  const orderOf = (context: { symbol: string; text: string }[]) =>
    buildTypecheckFile({
      imports: [],
      context: context.map(snippet => ({ file: 'a.ts', ...snippet })),
      functionText: 'function f() {}',
    })
      .split('\n\n')
      .slice(0, -1);

  it("keeps the agent's order when a name appears only as a property or a key", () => {
    const defaults = { symbol: 'defaults', text: 'const defaults = { port: 8080 };' };
    const port = { symbol: 'port', text: 'const port = defaults.port;' };
    expect(orderOf([defaults, port])).toEqual([defaults.text, port.text]);
  });

  it('ignores a name in a comment, a string or template text, not in a template expression', () => {
    const user = {
      symbol: 'user',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text is source code, not a template
      text: "// greets the host\nconst user = 'host' + `host ${prefix}`;",
    };
    const host = { symbol: 'host', text: 'const host = "user";' };
    const prefix = { symbol: 'prefix', text: 'const prefix = 1;' };
    expect(orderOf([user, host, prefix])).toEqual([host.text, prefix.text, user.text]);
  });

  it('keeps the order of a cycle, after what goes before it', () => {
    const isEven = {
      symbol: 'isEven',
      text: 'function isEven(n) { return n === 0 || isOdd(n - 1); }',
    };
    const isOdd = {
      symbol: 'isOdd',
      text: 'function isOdd(n) { return n !== 0 && isEven(n - 1); }',
    };
    const parity = { symbol: 'parity', text: 'const parity = isEven(2);' };
    expect(orderOf([isEven, isOdd])).toEqual([isEven.text, isOdd.text]);
    expect(orderOf([parity, isEven, isOdd])).toEqual([isEven.text, parity.text, isOdd.text]);
  });

  it('counts a spread and a shorthand property as references', () => {
    const merged = { symbol: 'merged', text: 'const merged = { ...base, limit };' };
    const base = { symbol: 'base', text: 'const base = {};' };
    const limit = { symbol: 'limit', text: 'const limit = 3;' };
    expect(orderOf([merged, base, limit])).toEqual([base.text, limit.text, merged.text]);
  });

  it('matches a name only as a whole word', () => {
    const file = buildTypecheckFile({
      imports: [],
      context: [
        { file: 'a.ts', symbol: 'idSchemaFor', text: 'const idSchemaFor = 1;' },
        { file: 'a.ts', symbol: 'idSchema', text: 'const idSchema = 2;' },
      ],
      functionText: 'function f() {}',
    });
    expect(file).toBe(
      ['const idSchemaFor = 1;', 'const idSchema = 2;', 'function f() {}'].join('\n\n'),
    );
  });

  it('is just the function when there is nothing else', () => {
    expect(buildTypecheckFile({ imports: [], context: [], functionText: 'function f() {}' })).toBe(
      'function f() {}',
    );
  });
});

describe('GenerateAnswerSchema', () => {
  const decode = Schema.decodeUnknownResult(GenerateAnswerSchema);

  it('decodes a round, or a decline with its reason', () => {
    expect(decode(answer)).toEqual(Result.succeed(answer));
    expect(decode({ declined: 'No function changes.' })).toEqual(
      Result.succeed({ declined: 'No function changes.' }),
    );
  });

  it('rejects a decline with no reason, and an answer that is neither', () => {
    expect(Result.isFailure(decode({ declined: '' }))).toBe(true);
    expect(Result.isFailure(decode({ error: 'No function changes.' }))).toBe(true);
  });
});

describe('decodeGenerateAnswer', () => {
  const messageOf = (json: string) => {
    const decoded = decodeGenerateAnswer(json);
    return Result.isFailure(decoded) ? decoded.failure.message : undefined;
  };

  it('decodes a round, or a decline', () => {
    expect(decodeGenerateAnswer(JSON.stringify(answer))).toEqual(Result.succeed(answer));
    expect(decodeGenerateAnswer('{"declined":"No function changes."}')).toEqual(
      Result.succeed({ declined: 'No function changes.' }),
    );
  });

  it("names only a round's faults when the answer is no decline", () => {
    const { reason: _, ...withoutReason } = answer;
    expect(messageOf(JSON.stringify(withoutReason))).toBe('Missing key\n  at ["reason"]');
  });

  it('names every fault, so one correction can fix them all', () => {
    const { reason: _, ...withoutReason } = answer;
    const message = messageOf(
      JSON.stringify({
        ...withoutReason,
        cards: cards.map((card, index) =>
          index === 2 ? { ...card, principle: { ...card.principle, id: 'over-isSome' } } : card,
        ),
      }),
    );
    expect(message).toContain('["reason"]');
    expect(message).toContain('["cards"][2]["principle"]["id"]');
  });

  it("names only a decline's faults when the answer declines", () => {
    expect(messageOf('{"declined":""}')).not.toContain('target');
  });

  it('says why text that is not JSON is invalid', () => {
    expect(messageOf('not json')).toBeDefined();
  });
});
