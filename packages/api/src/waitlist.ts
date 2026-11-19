// The waitlist: one endpoint that adds an address, answering the same to one already listed.
// The Worker (`apps/worker-web`) implements it and the site's form calls it.
import { coded, ErrorMessageSchema } from '@internal/effect-api';
import * as HttpApi from 'effect/http-api/HttpApi';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import {
  CONSENT_VERSIONS,
  EMAIL_PATTERN,
  HONEYPOT_FIELD,
  MAX_BODY_BYTES,
  MAX_EMAIL_LENGTH,
  PLATFORMS,
} from './waitlist-form';

export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()(
  'InvalidRequestError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 400 },
) {}

export class PayloadTooLargeError extends Schema.TaggedError<PayloadTooLargeError>()(
  'PayloadTooLargeError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 413 },
) {}

export class RateLimitedError extends Schema.TaggedError<RateLimitedError>()(
  'RateLimitedError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 429 },
) {}

export const EmailSchema = Schema.Trim.check(
  Schema.isMaxLength(MAX_EMAIL_LENGTH),
  Schema.isPattern(EMAIL_PATTERN),
).annotate({
  description: `An email address of plain ASCII characters, up to ${MAX_EMAIL_LENGTH} of them. Spaces around it are ignored.`,
});

export const JoinPayloadSchema = Schema.Struct({
  email: EmailSchema,
  platform: Schema.optionalKey(
    Schema.Literals(PLATFORMS).annotate({
      description: 'Where their code is: GitHub, GitLab or both. Leave it out if they did not say.',
    }),
  ),
  consent: Schema.Literals(CONSENT_VERSIONS).annotate({
    description: 'The id of the wording shown next to the form, which the row keeps.',
  }),
  [HONEYPOT_FIELD]: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'A hidden field a person never fills in. Leave it out or empty: anything else is a bot, answered as a success and stored nowhere.',
    }),
  ),
}).annotate({ identifier: 'WaitlistJoin' });
export type JoinPayload = typeof JoinPayloadSchema.Type;

/** The one answer to a join, for a new address and for one already listed. */
export const JoinedSchema = Schema.Struct({ status: Schema.Literal('joined') }).annotate({
  identifier: 'WaitlistJoined',
});

/** Runs before the body is read: the caller's rate limit, then the body's size and type. */
export class AbuseGuard extends HttpApiMiddleware.Service<AbuseGuard>()(
  '@codetinder/api/AbuseGuard',
  { error: [coded(RateLimitedError), coded(PayloadTooLargeError), coded(InvalidRequestError)] },
) {}

/** A request that fails its schema is `400 InvalidRequestError`. */
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  '@codetinder/api/WaitlistRequestValidation',
  { error: coded(InvalidRequestError) },
) {}

export class WaitlistGroup extends HttpApiGroup.make('waitlist')
  .add(
    HttpApiEndpoint.post('join', '/waitlist', {
      payload: JoinPayloadSchema,
      success: JoinedSchema,
      error: [coded(InvalidRequestError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Join the waitlist',
        description: `Adds the address to the list, and answers \`{ "status": "joined" }\` whether it was new or already there: the answer never says which. The request is JSON of at most ${MAX_BODY_BYTES} bytes, sent with a Content-Length.`,
      }),
    ),
  )
  .middleware(AbuseGuard) {}

export class WaitlistApi extends HttpApi.make('codetinder-waitlist')
  .add(WaitlistGroup)
  .middleware(RequestValidation)
  .prefix('/api')
  .annotateMerge(
    OpenApi.annotations({
      title: 'CodeTinder waitlist',
      version: '1.0.0',
      description: 'Leave an email address to hear when CodeTinder relaunches.',
    }),
  ) {}
