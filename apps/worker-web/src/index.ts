import * as HttpRouter from 'effect/http/HttpRouter';
import * as Layer from 'effect/Layer';
import { HttpApp } from './http/app';
import { WorkerLive } from './runtime';

// Built once per isolate, at module load: `toWebHandler` builds the app layer (and the services
// under it) right away, so no layer may do I/O while it builds.
const { handler } = HttpRouter.toWebHandler(HttpApp.pipe(Layer.provideMerge(WorkerLive)), {
  disableLogger: true,
});

export default {
  // Not `fetch: handler`: the handler's 2nd parameter is an Effect `Context`, not the Workers
  // `env`. Only /api/waitlist reaches this Worker (wrangler.jsonc); the rest is static assets.
  fetch: request => handler(request),
} satisfies ExportedHandler<Env>;
