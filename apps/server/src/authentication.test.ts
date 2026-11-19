import { GitLabUsers, InvalidToken } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { CachedGitLabUsers } from './authentication';
import { OAUTH_TOKEN } from './test-fixtures';

/** GitLab users that record each call and answer with the given behaviour. */
const recordingUsers = (behaviour: {
  readonly whoAmI?: () => Effect.Effect<{ userId: number; username: string }, InvalidToken>;
  readonly canReadCode?: () => Effect.Effect<boolean>;
  readonly canPush?: () => Effect.Effect<boolean>;
}) => {
  const calls: string[] = [];
  const layer = Layer.succeed(
    GitLabUsers,
    GitLabUsers.of({
      whoAmI: () => {
        calls.push('whoAmI');
        return behaviour.whoAmI?.() ?? Effect.succeed({ userId: 42, username: 'ada' });
      },
      canReadCode: () => {
        calls.push('canReadCode');
        return behaviour.canReadCode?.() ?? Effect.succeed(true);
      },
      canPush: () => {
        calls.push('canPush');
        return behaviour.canPush?.() ?? Effect.succeed(true);
      },
    }),
  );
  return { calls, layer };
};

describe('CachedGitLabUsers.canReadCode', () => {
  it.effect('answers an identical second lookup from the cache', () => {
    const { calls, layer } = recordingUsers({});
    return Effect.gen(function* () {
      const users = yield* CachedGitLabUsers;
      const lookup = () =>
        users.canReadCode({ token: Redacted.make(OAUTH_TOKEN), projectId: '111' });
      expect(yield* lookup()).toBe(true);
      expect(yield* lookup()).toBe(true);
      expect(calls).toEqual(['canReadCode']);
    }).pipe(Effect.provide(CachedGitLabUsers.layer.pipe(Layer.provide(layer))));
  });

  it.effect('asks GitLab again for another project', () => {
    const { calls, layer } = recordingUsers({});
    return Effect.gen(function* () {
      const users = yield* CachedGitLabUsers;
      yield* users.canReadCode({ token: Redacted.make(OAUTH_TOKEN), projectId: '111' });
      yield* users.canReadCode({ token: Redacted.make(OAUTH_TOKEN), projectId: '222' });
      expect(calls).toEqual(['canReadCode', 'canReadCode']);
    }).pipe(Effect.provide(CachedGitLabUsers.layer.pipe(Layer.provide(layer))));
  });

  it.effect('does not cache a defect', () => {
    const { calls, layer } = recordingUsers({
      canReadCode: () => Effect.die(new Error('GitLab 500')),
    });
    return Effect.gen(function* () {
      const users = yield* CachedGitLabUsers;
      const lookup = () =>
        users.canReadCode({ token: Redacted.make(OAUTH_TOKEN), projectId: '111' });
      expect(Exit.isFailure(yield* Effect.exit(lookup()))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(lookup()))).toBe(true);
      expect(calls).toEqual(['canReadCode', 'canReadCode']);
    }).pipe(Effect.provide(CachedGitLabUsers.layer.pipe(Layer.provide(layer))));
  });
});

describe('CachedGitLabUsers.canPush', () => {
  it.effect('answers an identical second lookup from the cache', () => {
    const { calls, layer } = recordingUsers({});
    return Effect.gen(function* () {
      const users = yield* CachedGitLabUsers;
      const lookup = () =>
        users.canPush({
          token: Redacted.make(OAUTH_TOKEN),
          projectId: '111',
          userId: 42,
        });
      expect(yield* lookup()).toBe(true);
      expect(yield* lookup()).toBe(true);
      expect(calls).toEqual(['canPush']);
    }).pipe(Effect.provide(CachedGitLabUsers.layer.pipe(Layer.provide(layer))));
  });
});

describe('CachedGitLabUsers.whoAmI', () => {
  it.effect('does not cache a rejected token', () => {
    const { calls, layer } = recordingUsers({
      whoAmI: () => Effect.fail(new InvalidToken({ message: 'GitLab rejected the token' })),
    });
    return Effect.gen(function* () {
      const users = yield* CachedGitLabUsers;
      yield* Effect.flip(users.whoAmI(Redacted.make('bad')));
      yield* Effect.flip(users.whoAmI(Redacted.make('bad')));
      expect(calls).toEqual(['whoAmI', 'whoAmI']);
    }).pipe(Effect.provide(CachedGitLabUsers.layer.pipe(Layer.provide(layer))));
  });
});
