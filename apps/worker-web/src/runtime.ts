// The only module that reads `env` from `cloudflare:workers`. The layers are built eagerly, at
// isolate start, so building them must do no I/O: every binding call happens inside a request.
import { env } from 'cloudflare:workers';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import { makeWorkerLayer } from './layer';
import { SignupLimit } from './platform/signup-limit';

export const WorkerLive = makeWorkerLayer(env.DB, SignupLimit.layer(env.SIGNUP_LIMIT)).pipe(
  Layer.provideMerge(Logger.layer([Logger.consoleJson])),
);
