import { CATALOG_ITEM_ID } from '@codetinder/gitlab';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';

const UPDATE_MUTATION = `mutation($input: AiCatalogFlowUpdateInput!) {
  aiCatalogFlowUpdate(input: $input) {
    errors
  }
}`;

export class ReleaseError extends Schema.TaggedError<ReleaseError>()('ReleaseError', {
  message: Schema.String,
}) {}

const UpdateResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.Struct({
      aiCatalogFlowUpdate: Schema.NullOr(Schema.Struct({ errors: Schema.Array(Schema.String) })),
    }),
  ),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});

/**
 * Releases `definition` as the flow's next minor version. The token is fine-grained, and GitLab
 * hides every catalog read from such a token, the updated item included: GitLab's `errors` are all
 * it answers, so the item's id is fixed and the job runs only when the definition changed.
 */
export const releaseFlow = Effect.fn('releaseFlow')(function* (definition: string) {
  const graphqlUrl = yield* Config.String('CI_API_GRAPHQL_URL');
  const token = yield* Config.Redacted('AI_CATALOG_TOKEN');
  const http = yield* HttpClient.HttpClient;

  const response = yield* HttpClientRequest.post(graphqlUrl).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.bodyJsonUnsafe({
      query: UPDATE_MUTATION,
      variables: { input: { id: CATALOG_ITEM_ID, definition, release: true } },
    }),
    http.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(UpdateResponseSchema)),
    Effect.orDie,
  );

  const errors = [
    ...(response.errors ?? []).map(({ message }) => message),
    ...(response.data?.aiCatalogFlowUpdate?.errors ?? []),
  ];
  if (errors.length > 0) {
    return yield* new ReleaseError({ message: `GitLab refused the release: ${errors.join('; ')}` });
  }
  yield* Effect.logInfo(`released ${CATALOG_ITEM_ID}`);
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const definitionPath = yield* path
    .fromFileUrl(new URL('../codetinder.yml', import.meta.url))
    .pipe(Effect.orDie);
  const definition = yield* fs.readFileString(definitionPath).pipe(Effect.orDie);
  yield* releaseFlow(definition);
});

if (import.meta.main) {
  main.pipe(
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
