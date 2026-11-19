import * as Context from 'effect/Context';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import * as HttpApiSecurity from 'effect/http-api/HttpApiSecurity';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';

export type Caller =
  | {
      readonly _tag: 'Flow';
      readonly projectId: string;
      readonly projectPath: string;
    }
  | {
      readonly _tag: 'Developer';
      readonly userId: number;
      readonly username: string;
      readonly token: Redacted.Redacted<string>;
    };

/** The verified caller; provided by {@link Authentication}. */
export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()(
  '@codetinder/api/Caller',
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  'Unauthorized',
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  'Forbidden',
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

/** Reads `Authorization: Bearer <token>` and provides {@link CurrentCaller}. Implemented by the server. */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentCaller; requires: never }
>()('@codetinder/api/Authentication', {
  requiredForClient: true,
  security: {
    bearer: HttpApiSecurity.bearer,
  },
  error: Unauthorized,
}) {}
