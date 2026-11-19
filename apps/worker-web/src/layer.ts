// runtime.ts builds it over the live `env`; test-support.ts over a test D1 and a fake limit.
import * as D1Client from '@effect/sql-d1/D1Client';
import * as Layer from 'effect/Layer';
import * as Str from 'effect/String';
import type { SignupLimit } from './platform/signup-limit';
import { Waitlist } from './services/waitlist';

export const makeWorkerLayer = (db: D1Database, signupLimit: Layer.Layer<SignupLimit>) =>
  Layer.mergeAll(Waitlist.layer, signupLimit).pipe(
    Layer.provideMerge(D1Client.layer({ db, transformResultNames: Str.snakeToCamel })),
    Layer.orDie,
  );
