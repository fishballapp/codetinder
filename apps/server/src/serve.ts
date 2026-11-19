import { createServer } from 'node:http';
import { GitLabIdTokens, GitLabUsers } from '@codetinder/gitlab';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as Layer from 'effect/Layer';
import { AppRoutes } from './app';
import type { RoundStore } from './round-store';
import type { SweepStore } from './sweep-store';

/** codetinder.dev on Node's HTTP server, over the given stores and log format. */
export const serve = ({
  stores,
  logger,
}: {
  stores: Layer.Layer<RoundStore | SweepStore, Config.ConfigError>;
  logger: Layer.Layer<never>;
}) =>
  HttpRouter.serve(AppRoutes).pipe(
    Layer.provide(stores),
    Layer.provide(GitLabIdTokens.layer),
    Layer.provide(GitLabUsers.layer),
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          // Cloud Run sets PORT.
          const port = yield* Config.Port('PORT').pipe(Config.withDefault(8080));
          yield* Effect.logInfo(`listening on port ${port}`);
          return NodeHttpServer.layer(createServer, { port });
        }),
      ),
    ),
    Layer.provide(logger),
  );
