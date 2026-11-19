import type * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientError from 'effect/http/HttpClientError';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Option from 'effect/Option';
import type * as Redacted from 'effect/Redacted';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';

/** GitLab.com; every request this package makes goes here. */
export const GITLAB_BASE_URL = 'https://gitlab.com';

/**
 * Longest a call to GitLab that is never sent again may take: a sign-in's token request and the
 * server's key fetch. Past it the call is a fault.
 */
export const REQUEST_TIMEOUT = '10 seconds';

/**
 * Longest GitLab may take to start answering one attempt of a call someone waits on (the body is
 * not covered). GitLab's API sometimes takes over 20 seconds and then recovers, so a slow attempt
 * is cut short and sent again: three attempts and their backoffs end within 26 seconds.
 */
export const INTERACTIVE_ATTEMPT_TIMEOUT = '8 seconds';

/**
 * Longest GitLab may take to start answering one attempt of a flow's call. GitLab's API sometimes takes over 20
 * seconds and then recovers, and a flow has no one waiting on it, so it waits longer and retries a
 * slow attempt: four attempts and their backoffs fit in a step's 120 seconds.
 */
export const FLOW_ATTEMPT_TIMEOUT = '25 seconds';

export class GitLabRequestFailed extends Schema.TaggedError<GitLabRequestFailed>()(
  'GitLabRequestFailed',
  {
    status: Schema.Int,
    message: Schema.String,
  },
) {}

const isTransientStatus = (status: number) => [408, 429, 500, 502, 503, 504].includes(status);

/**
 * Retries a transient failure (a network error, a timed-out attempt, or a transient status) at most
 * `times` times in all, 500 ms apart and doubling; the last transient status is returned as the
 * response it was, and a last timeout stays a timeout. Effect's own `retryTransient` retries
 * errors and transient statuses in two nested loops, so each error resets the statuses' count and
 * `times` bounds neither. Here a transient status becomes a failure for the one retry loop.
 */
const retryTransientWithin =
  (times: number) =>
  (client: HttpClient.HttpClient.With<HttpClientError.HttpClientError | Cause.TimeoutError>) =>
    client.pipe(
      HttpClient.transform((attempt, request) =>
        Effect.flatMap(attempt, response =>
          isTransientStatus(response.status)
            ? Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.StatusCodeError({ request, response }),
                }),
              )
            : Effect.succeed(response),
        ),
      ),
      HttpClient.retryTransient({
        retryOn: 'errors-only',
        schedule: Schedule.exponential('500 millis'),
        times,
      }),
      HttpClient.transformResponse(
        Effect.catchTag('HttpClientError', error =>
          error.reason._tag === 'StatusCodeError'
            ? Effect.succeed(error.reason.response)
            : Effect.fail(error),
        ),
      ),
    );

/**
 * The HTTP client every service authenticates with a run's token: each attempt times out, and
 * transient failures, a timed-out attempt among them, retry.
 */
export const gitLabClient = (
  client: HttpClient.HttpClient,
  baseUrl: string,
  token: Redacted.Redacted<string>,
) =>
  client.pipe(
    HttpClient.mapRequest(req =>
      req.pipe(HttpClientRequest.prependUrl(baseUrl), HttpClientRequest.bearerToken(token)),
    ),
    HttpClient.transformResponse(Effect.timeout(FLOW_ATTEMPT_TIMEOUT)),
    retryTransientWithin(3),
    // Still timing out after the retries is a fault.
    HttpClient.transformResponse(Effect.catchTag('TimeoutError', error => Effect.die(error))),
  );

/** Methods HTTP defines as idempotent: sending one again leaves GitLab as sending it once did. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

const IsRepeatable = Context.Reference<boolean>('@codetinder/gitlab/IsRepeatable', {
  defaultValue: () => false,
});

/**
 * Marks a call as safe to send again though its method isn't idempotent: a GraphQL query, or a
 * mutation that sets state rather than adds to it. A POST that creates something is never marked.
 */
export const repeatable = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  Effect.provideService(call, IsRepeatable, true);

/**
 * The HTTP client every service authenticates with a user's token, for calls someone waits on:
 * each attempt times out, and only a call safe to send again retries a transient failure, a
 * timed-out attempt among them (the idempotent methods, or a call marked `repeatable`). Any other
 * call gets one attempt, as a repeat could do its work twice.
 */
export const gitLabInteractiveClient = (client: HttpClient.HttpClient) => {
  const attempted = client.pipe(
    HttpClient.transformResponse(Effect.timeout(INTERACTIVE_ATTEMPT_TIMEOUT)),
  );
  return attempted.pipe(
    retryTransientWithin(2),
    HttpClient.transform((retried, request) =>
      Effect.gen(function* () {
        const isMarkedRepeatable = yield* Effect.service(IsRepeatable);
        const isSafeToRepeat = isMarkedRepeatable || IDEMPOTENT_METHODS.has(request.method);
        if (!isSafeToRepeat) {
          return yield* attempted.execute(request);
        }
        return yield* retried;
      }),
    ),
    HttpClient.mapRequest(HttpClientRequest.prependUrl(GITLAB_BASE_URL)),
    // Still timing out after the retries is a fault.
    HttpClient.transformResponse(Effect.catchTag('TimeoutError', error => Effect.die(error))),
  );
};

export const checkStatus = (
  response: HttpClientResponse.HttpClientResponse,
  method: string,
  path: string,
) =>
  response.status >= 200 && response.status < 300
    ? Effect.void
    : new GitLabRequestFailed({
        status: response.status,
        message: `${method} ${path} failed with status ${response.status}`,
      });

export const GITLAB_JWKS_URL = `${GITLAB_BASE_URL}/oauth/discovery/keys`;

export const CODETINDER_AUDIENCE = 'https://codetinder.dev';

export const ID_TOKEN_ISSUER = 'https://gitlab.com';

export const ID_TOKEN_PIPELINE_SOURCE = 'duo_workflow';

/** Seconds of clock skew allowed on `exp` / `nbf`. */
export const ID_TOKEN_LEEWAY_SECONDS = 60;

/** The page GitLab's `X-Next-Page` header names; none past the last page. */
const nextPageOf = ({ headers }: HttpClientResponse.HttpClientResponse): Option.Option<number> =>
  Option.fromNullishOr(headers['x-next-page']).pipe(
    Option.map(header => Number.parseInt(header, 10)),
    Option.filter(page => !Number.isNaN(page)),
  );

/** Follows GitLab's `X-Next-Page` header across paginated endpoints until exhausted. */
export const paginateGitLab = <A, E, R>(
  fetchPage: (page: number) => Effect.Effect<
    {
      readonly items: readonly A[];
      readonly response: HttpClientResponse.HttpClientResponse;
    },
    E,
    R
  >,
): Effect.Effect<readonly A[], E, R> =>
  Stream.paginate(1, page =>
    fetchPage(page).pipe(
      Effect.map(({ items, response }) => [items, nextPageOf(response)] as const),
    ),
  ).pipe(Stream.runCollect);
