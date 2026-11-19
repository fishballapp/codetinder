import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { gitLabInteractiveClient } from './gitlab';

export type GitLabUser = {
  readonly userId: number;
  readonly username: string;
};

export class InvalidToken extends Schema.TaggedError<InvalidToken>()('InvalidToken', {
  message: Schema.String,
}) {}

export class GitLabUsers extends Context.Service<
  GitLabUsers,
  {
    readonly whoAmI: (token: Redacted.Redacted<string>) => Effect.Effect<GitLabUser, InvalidToken>;
    /** Whether the token can read the project's code, not merely see that the project exists. */
    readonly canReadCode: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
    }) => Effect.Effect<boolean>;
    /** Whether the user is a Developer or above on the project, inherited access from its groups included. */
    readonly canPush: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly userId: number;
    }) => Effect.Effect<boolean>;
  }
>()('@codetinder/gitlab/GitLabUsers') {
  static readonly layer = Layer.effect(
    GitLabUsers,
    Effect.gen(function* () {
      const http = gitLabInteractiveClient(yield* HttpClient.HttpClient);

      const whoAmI = Effect.fn('GitLabUsers.whoAmI')(function* (token: Redacted.Redacted<string>) {
        const response = yield* HttpClientRequest.get('/api/v4/user').pipe(
          HttpClientRequest.bearerToken(token),
          http.execute,
          Effect.orDie,
        );
        // 403 is a token without the scope /user needs: the same refusal as a bad token.
        if (response.status === 401 || response.status === 403) {
          return yield* new InvalidToken({ message: 'GitLab rejected the token' });
        }
        if (response.status !== 200) {
          return yield* Effect.die(new Error(`GitLab /user unexpected status ${response.status}`));
        }
        const body = yield* HttpClientResponse.schemaBodyJson(GitLabUserResponseSchema)(
          response,
        ).pipe(Effect.orDie);
        return { userId: body.id, username: body.username };
      });

      // The project endpoint answers 200 to anyone who can see the project, which isn't the same as
      // reading its code; the repository tree is what needs read access.
      const canReadCode = Effect.fn('GitLabUsers.canReadCode')(function* ({
        token,
        projectId,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
      }) {
        const response = yield* HttpClientRequest.get(
          `/api/v4/projects/${encodeURIComponent(projectId)}/repository/tree`,
        ).pipe(
          HttpClientRequest.setUrlParam('per_page', '1'),
          HttpClientRequest.bearerToken(token),
          http.execute,
          Effect.orDie,
        );
        if (response.status === 200) return true;
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          return false;
        }
        return yield* Effect.die(
          new Error(`GitLab /repository/tree unexpected status ${response.status}`),
        );
      });

      // The effective access, which members of an ancestor group have too; the project's own
      // permissions leave those out. 404 is a user who is not a member at all.
      const canPush = Effect.fn('GitLabUsers.canPush')(function* ({
        token,
        projectId,
        userId,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly userId: number;
      }) {
        const response = yield* HttpClientRequest.get(
          `/api/v4/projects/${encodeURIComponent(projectId)}/members/all/${userId}`,
        ).pipe(HttpClientRequest.bearerToken(token), http.execute, Effect.orDie);
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          return false;
        }
        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /members/all unexpected status ${response.status}`),
          );
        }
        const member = yield* HttpClientResponse.schemaBodyJson(MemberResponseSchema)(
          response,
        ).pipe(Effect.orDie);
        return member.access_level >= DEVELOPER_ACCESS_LEVEL;
      });

      return GitLabUsers.of({ whoAmI, canReadCode, canPush });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

/** GitLab's access level for Developer, the lowest that may push to a project's branches. */
const DEVELOPER_ACCESS_LEVEL = 30;

const GitLabUserResponseSchema = Schema.Struct({
  id: Schema.Int,
  username: Schema.String,
});

const MemberResponseSchema = Schema.Struct({ access_level: Schema.Int });
