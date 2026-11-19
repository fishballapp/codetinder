import * as Effect from 'effect/Effect';
import type * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { InvalidToken } from './users';

export class GitLabCatalogError extends Schema.TaggedError<GitLabCatalogError>()(
  'GitLabCatalogError',
  {
    message: Schema.String,
  },
) {}

const graphqlResponse = <S extends Schema.Top>(dataSchema: S) =>
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(dataSchema)),
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  });

/**
 * The catalog's one way to call GitLab's GraphQL API. A refused token is `InvalidToken` (403 is a
 * token without the scope the catalog needs); the query's errors, or else the mutation's refusals
 * (`mutationErrors` picks them out of `data`), are a `GitLabCatalogError`.
 */
export const catalogGraphql = (http: HttpClient.HttpClient) =>
  Effect.fn('GitLabCatalog.graphql')(function* <
    S extends Schema.Top & { readonly DecodingServices: never },
  >({
    token,
    query,
    variables,
    data: dataSchema,
    mutationErrors = () => [],
  }: {
    readonly token: Redacted.Redacted<string>;
    readonly query: string;
    readonly variables: Record<string, unknown>;
    readonly data: S;
    readonly mutationErrors?: (data: S['Type']) => ReadonlyArray<string> | undefined;
  }) {
    const response = yield* HttpClientRequest.post('/api/graphql').pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.bodyJsonUnsafe({ query, variables }),
      http.execute,
      Effect.orDie,
    );
    if (response.status === 401 || response.status === 403) {
      return yield* new InvalidToken({ message: 'GitLab rejected the token' });
    }
    if (response.status !== 200) {
      const unexpectedStatus = `GitLab /api/graphql unexpected status ${response.status}`;
      return yield* Effect.die(new Error(unexpectedStatus));
    }

    const { data, errors = [] } = yield* HttpClientResponse.schemaBodyJson(
      graphqlResponse(dataSchema),
    )(response).pipe(Effect.orDie);
    if (errors.length > 0) {
      const queryErrors = errors.map(({ message }) => message).join('; ');
      return yield* new GitLabCatalogError({ message: queryErrors });
    }
    if (data === null || data === undefined) {
      return yield* new GitLabCatalogError({ message: 'GitLab answered without data' });
    }
    const refusals = mutationErrors(data) ?? [];
    if (refusals.length > 0) {
      return yield* new GitLabCatalogError({ message: refusals.join('; ') });
    }
    return data;
  });

export type CatalogGraphql = ReturnType<typeof catalogGraphql>;
