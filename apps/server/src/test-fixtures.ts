import { AskIdSchema } from '@codetinder/api';
import { assignCardIds, type RoundAnswer } from '@codetinder/core';
import { GitLabIdTokens, GitLabUsers, InvalidIdToken, InvalidToken } from '@codetinder/gitlab';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import type { LearnAsk } from './learn';

const sampleCards: RoundAnswer['cards'] = [
  {
    operation: 'Replace Nested Conditional with Guard Clauses',
    change: 'Returns early on the empty case.',
    principle: {
      id: 'early-returns',
      statement: 'Return early instead of nesting conditionals.',
    },
    stance: 'supports',
    kind: 'explore',
    after: 'function f(x: number) { if (x === 0) return 0; return 1; }',
  },
  {
    operation: 'Rename Variable',
    change: 'Renames the local to `total`.',
    principle: {
      id: 'named-results',
      statement: 'Name an intermediate result instead of returning an expression inline.',
    },
    stance: 'opposes',
    kind: 'challenge',
    after: 'function f() { const total = 1; return total; }',
  },
  {
    operation: 'Extract Variable',
    change: 'Pulls the returned value into a named constant.',
    principle: {
      id: 'named-results',
      statement: 'Name an intermediate result instead of returning an expression inline.',
    },
    stance: 'supports',
    kind: 'confirm',
    after: 'function f() { const result = 1; return result; }',
  },
];

export const sampleRound = {
  version: 2 as const,
  target: { file: 'src/f.ts', symbol: 'f', text: 'function f() {}' },
  reason: 'It has the most branching.',
  context: [] as const,
  imports: [] as const,
  cards: assignCardIds(sampleCards),
};

/** The commit a test round is made at. */
export const HEAD_SHA = 'c0ffee'.padEnd(40, '0');

export const FLOW_TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImtpZCJ9.eyJzdWIiOiJmbG93In0.sig';
export const FLOW_OTHER_TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6Im90aGVyIn0.eyJzdWIiOiJvdGhlci1mbG93In0.sig';
export const OAUTH_TOKEN = 'oauth-ada-token';
export const OAUTH_TEAMMATE_TOKEN = 'oauth-bob-token';
export const OAUTH_NO_ACCESS = 'oauth-no-access';
export const BAD_OAUTH = 'oauth-bad';

export const fakeIdTokens = Layer.succeed(
  GitLabIdTokens,
  GitLabIdTokens.of({
    verify: (token: Redacted.Redacted<string>) => {
      const value = Redacted.value(token);
      if (value === FLOW_TOKEN) {
        return Effect.succeed({
          projectId: '111',
          projectPath: 'group/project',
        });
      }
      if (value === FLOW_OTHER_TOKEN) {
        return Effect.succeed({
          projectId: '222',
          projectPath: 'group/other',
        });
      }
      return Effect.fail(new InvalidIdToken({ message: 'bad id token' }));
    },
  }),
);

export const fakeUsers = Layer.succeed(
  GitLabUsers,
  GitLabUsers.of({
    whoAmI: (token: Redacted.Redacted<string>) => {
      const value = Redacted.value(token);
      if (value === OAUTH_TOKEN) return Effect.succeed({ userId: 42, username: 'ada' });
      if (value === OAUTH_TEAMMATE_TOKEN) return Effect.succeed({ userId: 43, username: 'bob' });
      if (value === OAUTH_NO_ACCESS) return Effect.succeed({ userId: 99, username: 'eve' });
      return Effect.fail(new InvalidToken({ message: 'bad oauth' }));
    },
    canReadCode: ({
      token,
      projectId,
    }: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
    }) => {
      const canRead = [OAUTH_TOKEN, OAUTH_TEAMMATE_TOKEN].includes(Redacted.value(token));
      return Effect.succeed(canRead && projectId === '111');
    },
    // Ada maintains the project; Bob can read its code but not push to it.
    canPush: ({ projectId, userId }: { readonly projectId: string; readonly userId: number }) =>
      Effect.succeed(userId === 42 && projectId === '111'),
  }),
);

/** An ask for one developer's like on `c1`, tied to note 900, its run not started. */
export const sampleAsk: LearnAsk = {
  id: Schema.decodeSync(AskIdSchema)('7c9e6679-7425-40de-944b-e07fc1f90ae7'),
  swipes: '[[42,[["c1","like"]]]]',
  askedAt: DateTime.makeUnsafe('2026-01-05T00:00:00.000Z'),
  isRetry: false,
  noteId: 900,
  startedAt: null,
  ended: null,
};
