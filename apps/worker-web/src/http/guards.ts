// Declared with the API (`@codetinder/api/waitlist`) so a client types its errors; implemented
// here over `SignupLimit`.
import {
  AbuseGuard,
  InvalidRequestError,
  PayloadTooLargeError,
  RateLimitedError,
  RequestValidation,
} from '@codetinder/api/waitlist';
import { MAX_BODY_BYTES } from '@codetinder/api/waitlist-form';
import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import * as Layer from 'effect/Layer';
import { clientKey, SignupLimit } from '../platform/signup-limit';

// The limit comes first, so a flood of oversized or mistyped bodies is limited too.
//
// The body must be JSON, named as such: a page on another origin can send a body with no
// Content-Type, or `text/plain`, without a preflight, and the router would read it as JSON. Only
// `application/json` forces the preflight, which this Worker answers with no CORS headers. The
// query string is refused so an address never travels in a URL, where logs and referrers keep it.
// Cloudflare's runtime refuses a body longer than its Content-Length, so the header can be
// believed; a request without a well-formed one (chunked) is refused, as nothing sends a form that
// way.
const CONTENT_LENGTH = /^\d+$/u;

const AbuseGuardLive = Layer.effect(
  AbuseGuard,
  Effect.gen(function* () {
    const limit = yield* SignupLimit;
    return AbuseGuard.of(
      Effect.fn(function* (httpEffect) {
        const { headers, url } = yield* HttpServerRequest.HttpServerRequest;
        if (!(yield* limit.allows(clientKey(headers['cf-connecting-ip'])))) {
          return yield* new RateLimitedError({
            message: 'Too many signups from this connection. Wait a minute and try again.',
          });
        }
        if (url.includes('?')) {
          return yield* new InvalidRequestError({
            message: 'Send the address in the JSON body, not in the URL.',
          });
        }
        const contentLength = headers['content-length'];
        if (
          contentLength === undefined ||
          !CONTENT_LENGTH.test(contentLength) ||
          Number(contentLength) > MAX_BODY_BYTES
        ) {
          return yield* new PayloadTooLargeError({
            message: `The body must be at most ${MAX_BODY_BYTES} bytes and sent with a Content-Length.`,
          });
        }
        const mediaType = headers['content-type']?.split(';')[0]?.trim().toLowerCase();
        if (mediaType !== 'application/json') {
          return yield* new InvalidRequestError({
            message: 'Send the body as JSON, with `Content-Type: application/json`.',
          });
        }
        return yield* httpEffect;
      }),
    );
  }),
);

// A request that fails its schema is `400 InvalidRequestError`; a response that fails ITS schema is
// our bug, so it stays a defect (→ 500). The message is fixed: the schema's own is a regular
// expression, which tells a visitor nothing.
const RequestValidationLive = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestValidation,
  error =>
    error.kind === 'Body' || error.kind === 'ResponseHeaders'
      ? Effect.die(error)
      : Effect.fail(
          new InvalidRequestError({
            message:
              'Send JSON like {"email":"you@example.com","consent":"v1"}: a plain-ASCII address, and optionally "platform" as "github", "gitlab" or "both".',
          }),
        ),
);

export const GuardsLive = Layer.mergeAll(AbuseGuardLive, RequestValidationLive);
