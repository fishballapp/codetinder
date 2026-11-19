import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { catalogGraphql, GitLabCatalogError } from './catalog-graphql';
import { GITLAB_BASE_URL, gitLabInteractiveClient } from './gitlab';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RenameDataSchema = Schema.Struct({
  renameThing: Schema.NullOr(
    Schema.Struct({ name: Schema.String, errors: Schema.Array(Schema.String) }),
  ),
});

/** One call through the helper, over the real client, to a fetch that answers `answer`. */
const rename = (answer: (request: Request) => Response | Promise<Response>) =>
  Effect.gen(function* () {
    const graphql = catalogGraphql(gitLabInteractiveClient(yield* HttpClient.HttpClient));
    return yield* graphql({
      token: Redacted.make('oauth-token'),
      query: 'mutation Rename($input: RenameInput!) { renameThing(input: $input) { name errors } }',
      variables: { input: { name: 'new' } },
      data: RenameDataSchema,
      mutationErrors: ({ renameThing }) => renameThing?.errors,
    });
  }).pipe(
    Effect.provide(
      Layer.succeed(FetchHttpClient.Fetch, async (input, init) =>
        answer(input instanceof Request ? input : new Request(input, init)),
      ).pipe(Layer.provideMerge(FetchHttpClient.layer)),
    ),
  );

describe('catalogGraphql', () => {
  it.effect("posts the query and its variables with the token, and answers GitLab's data", () =>
    Effect.gen(function* () {
      const data = yield* rename(async request => {
        expect(request.url).toBe(`${GITLAB_BASE_URL}/api/graphql`);
        expect(request.method).toBe('POST');
        expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
        const body = await request.json();
        expect(body.query).toContain('renameThing(input: $input)');
        expect(body.variables).toEqual({ input: { name: 'new' } });
        return json({ data: { renameThing: { name: 'new', errors: [] } } });
      });
      expect(data).toEqual({ renameThing: { name: 'new', errors: [] } });
    }),
  );

  it.effect('fails with InvalidToken when GitLab refuses the token or its scope', () =>
    Effect.gen(function* () {
      const errors = yield* Effect.forEach(
        [401, 403],
        status => Effect.flip(rename(() => json({ message: 'Unauthorized' }, status))),
        { concurrency: 'unbounded' },
      );
      expect(errors.map(error => error._tag)).toEqual(['InvalidToken', 'InvalidToken']);
    }),
  );

  it.effect('dies on any other status', () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(rename(() => json({}, 404)));
      expect(Exit.hasDies(exit)).toBe(true);
    }),
  );

  it.effect("fails with the query's errors, joined", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        rename(() => json({ errors: [{ message: 'Field missing' }, { message: 'Too complex' }] })),
      );
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toBe('Field missing; Too complex');
    }),
  );

  it.effect("fails with the mutation's refusals, joined", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        rename(() =>
          json({ data: { renameThing: { name: 'old', errors: ['Taken', 'Too long'] } } }),
        ),
      );
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toBe('Taken; Too long');
    }),
  );

  it.effect('fails when GitLab answers neither data nor errors', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(rename(() => json({ data: null })));
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toBe('GitLab answered without data');
    }),
  );
});
