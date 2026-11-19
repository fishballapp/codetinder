// The Worker answers `/api/waitlist` only; the site is static assets beside it, on the same
// origin, so nothing here needs CORS.
import { WaitlistApi } from '@codetinder/api/waitlist';
import { ErrorContract } from '@internal/effect-worker';
import * as HttpServer from 'effect/http/HttpServer';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Layer from 'effect/Layer';
import { WaitlistHandlers } from './api/waitlist';
import { GuardsLive } from './guards';

const ApiHandlers = WaitlistHandlers.pipe(Layer.provideMerge(GuardsLive));

export const HttpApp = HttpApiBuilder.layer(WaitlistApi).pipe(
  Layer.provide(ApiHandlers),
  Layer.provide(ErrorContract),
  Layer.provide(HttpServer.layerServices),
);
