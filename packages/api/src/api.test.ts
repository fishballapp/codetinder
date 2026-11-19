import { assignCardIds } from '@codetinder/core';
import * as DateTime from 'effect/DateTime';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as SchemaAST from 'effect/SchemaAST';
import { describe, expect, it } from 'vitest';
import { Forbidden, Unauthorized } from './authentication';
import { ClaimPayloadSchema, ClaimSuccessSchema } from './claims';
import { GetQuestionsSuccessSchema } from './projects';
import {
  CreateRoundPayloadSchema,
  CreateRoundSuccessSchema,
  GetRoundSuccessSchema,
  GetSwipesSuccessSchema,
  InvalidSwipes,
  PutSwipesPayloadSchema,
  RoundNotFound,
  RoundTooLarge,
} from './rounds';

const RUN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const httpStatus = (schema: { readonly ast: SchemaAST.AST }): number | undefined =>
  SchemaAST.resolveAt<number>('httpApiStatus')(schema.ast);

const card = (operation: string) => ({
  operation,
  change: `Applied ${operation}.`,
  principle: { id: 'early-returns', statement: 'Return early.' },
  stance: 'supports' as const,
  kind: 'explore' as const,
  after: `function f() { /* ${operation} */ }`,
});

const round = {
  version: 2 as const,
  target: { file: 'src/f.ts', symbol: 'f', text: 'function f() {}' },
  reason: 'It has the most branching.',
  context: [] as const,
  imports: [] as const,
  cards: assignCardIds([card('Rename Variable'), card('Extract Function')]),
};

describe('CreateRoundPayloadSchema', () => {
  const decode = Schema.decodeUnknownResult(CreateRoundPayloadSchema);

  const headSha = 'a'.repeat(40);
  const runId = RUN_ID;

  it('decodes a valid payload', () => {
    const payload = { mergeRequestIid: 7, headSha, runId, round };
    expect(decode(payload)).toEqual(Result.succeed(payload));
  });

  it('rejects a non-integer merge request iid', () => {
    expect(Result.isFailure(decode({ mergeRequestIid: 1.5, headSha, runId, round }))).toBe(true);
    expect(Result.isFailure(decode({ mergeRequestIid: '7', headSha, runId, round }))).toBe(true);
  });

  it('rejects a head that is not a commit id', () => {
    for (const sha of [undefined, 'main', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) {
      expect(Result.isFailure(decode({ mergeRequestIid: 7, headSha: sha, runId, round }))).toBe(
        true,
      );
    }
  });
});

describe('ClaimPayloadSchema', () => {
  const decode = Schema.decodeUnknownResult(ClaimPayloadSchema);
  const headSha = 'b'.repeat(64);

  it('decodes a claim for each event that starts a round', () => {
    for (const event of [
      'merge_request',
      'merge_request_ready',
      'assign_reviewer',
      'pipeline_hooks',
      'mention',
    ]) {
      const payload = { mergeRequestIid: 7, headSha, runId: RUN_ID, event };
      expect(decode(payload)).toEqual(Result.succeed(payload));
    }
  });

  it('rejects a run id that is not a UUID', () => {
    for (const runId of [undefined, '', 'run-1', RUN_ID.toUpperCase()]) {
      expect(
        Result.isFailure(decode({ mergeRequestIid: 7, headSha, runId, event: 'merge_request' })),
      ).toBe(true);
    }
  });

  it('rejects an event that starts no round', () => {
    expect(
      Result.isFailure(decode({ mergeRequestIid: 7, headSha, runId: RUN_ID, event: 'assign' })),
    ).toBe(true);
  });
});

describe('ClaimSuccessSchema', () => {
  const decode = Schema.decodeUnknownResult(ClaimSuccessSchema);

  it('decodes each answer', () => {
    for (const answer of [
      { _tag: 'Claimed' },
      { _tag: 'Claimed', replacedRoundId: '0123456789AB' },
      { _tag: 'Busy' },
      { _tag: 'Tried' },
      { _tag: 'HasRound', roundId: '0123456789AB' },
    ]) {
      expect(decode(answer)).toEqual(Result.succeed(answer));
    }
  });
});

describe('CreateRoundSuccessSchema', () => {
  const decode = Schema.decodeUnknownResult(CreateRoundSuccessSchema);

  it('decodes a round id', () => {
    expect(decode({ id: '0123456789AB' })).toEqual(Result.succeed({ id: '0123456789AB' }));
  });

  it('rejects a bad id', () => {
    expect(Result.isFailure(decode({ id: 'short' }))).toBe(true);
  });
});

describe('GetRoundSuccessSchema', () => {
  const decode = Schema.decodeUnknownResult(Schema.toCodecJson(GetRoundSuccessSchema));

  it('decodes a stored round with an ISO createdAt', () => {
    const sample = {
      id: '0123456789AB',
      projectId: '87434709',
      mergeRequestIid: 7,
      round,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const decoded = decode(sample);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success.id).toBe(sample.id);
    expect(decoded.success.projectId).toBe(sample.projectId);
    expect(DateTime.formatIso(decoded.success.createdAt)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects a missing round', () => {
    expect(
      Result.isFailure(
        decode({
          id: '0123456789AB',
          projectId: '87434709',
          mergeRequestIid: 7,
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ).toBe(true);
  });
});

describe('PutSwipesPayloadSchema', () => {
  const decode = Schema.decodeUnknownResult(PutSwipesPayloadSchema);

  it('decodes one verdict per card id', () => {
    const payload = { verdicts: { c1: 'like' as const, c2: 'dislike' as const } };
    expect(decode(payload)).toEqual(Result.succeed(payload));
  });

  it('rejects an unknown verdict', () => {
    expect(Result.isFailure(decode({ verdicts: { c1: 'meh' } }))).toBe(true);
  });

  it('rejects the old list of verdicts', () => {
    expect(Result.isFailure(decode({ verdicts: [{ variantId: 'v1', verdict: 'like' }] }))).toBe(
      true,
    );
  });
});

describe('GetSwipesSuccessSchema', () => {
  const decode = Schema.decodeUnknownResult(Schema.toCodecJson(GetSwipesSuccessSchema));

  it('decodes every developer swipe', () => {
    const sample = {
      swipes: [
        {
          userId: 42,
          username: 'ada',
          verdicts: { c1: 'like' },
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    };
    const decoded = decode(sample);
    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success.swipes[0]?.username).toBe('ada');
  });

  it('rejects a non-integer userId', () => {
    expect(
      Result.isFailure(
        decode({
          swipes: [
            {
              userId: '42',
              username: 'ada',
              verdicts: [],
              updatedAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe('GetQuestionsSuccessSchema', () => {
  const decode = Schema.decodeUnknownResult(GetQuestionsSuccessSchema);

  it("decodes a project's questions", () => {
    const questions = [
      {
        id: 'early-returns',
        statement: 'Return early.',
        supports: { likes: 2, dislikes: 0 },
        opposes: { likes: 0, dislikes: 1 },
        roundsSinceJudged: 2,
      },
      {
        id: 'guards',
        statement: 'Guard first.',
        supports: { likes: 0, dislikes: 0 },
        opposes: { likes: 0, dislikes: 0 },
        roundsSinceJudged: null,
      },
    ];
    expect(decode({ questions })).toEqual(Result.succeed({ questions }));
  });
});

describe('error status codes', () => {
  it('annotates each tagged error with its HTTP status', () => {
    expect(httpStatus(Unauthorized)).toBe(401);
    expect(httpStatus(Forbidden)).toBe(403);
    expect(httpStatus(RoundNotFound)).toBe(404);
    expect(httpStatus(RoundTooLarge)).toBe(413);
    expect(httpStatus(InvalidSwipes)).toBe(400);
  });
});
