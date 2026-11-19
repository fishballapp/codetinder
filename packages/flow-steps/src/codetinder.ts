import {
  Api,
  Authentication,
  type ClaimPayload,
  type ClaimSuccess,
  type CreateRoundPayload,
  type CreateRoundSuccess,
  type EndClaimPayload,
  type EndSweepPayload,
  type FinishSweepPayload,
  type Forbidden,
  type GetEvidenceSuccess,
  type GetQuestionsSuccess,
  type GetRoundSuccess,
  type GetSwipesSuccess,
  type LearnReportPayload,
  type NotClaimOwner,
  type RoundId,
  type RoundNotFound,
  type RoundTooLarge,
  type StopSweepPayload,
  type SweepClaimPayload,
  type SweepClaimSuccess,
  type SweepState,
  type Unauthorized,
} from '@codetinder/api';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpApiClient from 'effect/http-api/HttpApiClient';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';

/** Default origin of codetinder.dev; overridable with `CODETINDER_URL`. */
export const CODETINDER_BASE_URL = 'https://codetinder.dev';

export class CodeTinder extends Context.Service<
  CodeTinder,
  {
    /** Origin used for API calls and for the round URL printed to stdout. */
    readonly baseUrl: string;
    /** Asks to make the round for one commit: only the run that gets the claim makes it. */
    readonly claim: (
      payload: ClaimPayload,
    ) => Effect.Effect<ClaimSuccess, Unauthorized | Forbidden>;
    /** Gives up a claimed commit whose attempt ended without a round. */
    readonly endClaim: (payload: EndClaimPayload) => Effect.Effect<void, Unauthorized | Forbidden>;
    readonly createRound: (
      payload: CreateRoundPayload,
    ) => Effect.Effect<
      CreateRoundSuccess,
      Unauthorized | Forbidden | RoundTooLarge | NotClaimOwner
    >;
    readonly getRound: (
      id: RoundId,
    ) => Effect.Effect<GetRoundSuccess, Unauthorized | Forbidden | RoundNotFound>;
    readonly getSwipes: (
      id: RoundId,
    ) => Effect.Effect<GetSwipesSuccess, Unauthorized | Forbidden | RoundNotFound>;
    /** What the project's rounds before round `id` say about the principles its cards test. */
    readonly getEvidence: (
      id: RoundId,
    ) => Effect.Effect<GetEvidenceSuccess, Unauthorized | Forbidden | RoundNotFound>;
    /** Tells codetinder.dev how the learn run of the reply `noteId` on round `id` is going. */
    readonly reportLearn: (
      id: RoundId,
      payload: LearnReportPayload,
    ) => Effect.Effect<void, Unauthorized | Forbidden | RoundNotFound>;
    /** The questions of the project the flow runs for, `projectId` (GitLab's numeric id). */
    readonly getQuestions: (
      projectId: string,
    ) => Effect.Effect<GetQuestionsSuccess, Unauthorized | Forbidden>;
    /** The sweep of the project the flow runs for, `projectId` (GitLab's numeric id). */
    readonly getSweep: (projectId: string) => Effect.Effect<SweepState, Unauthorized | Forbidden>;
    /** Asks to sweep the project at a commit: only the run that gets the claim sweeps. */
    readonly claimSweep: (
      projectId: string,
      payload: SweepClaimPayload,
    ) => Effect.Effect<SweepClaimSuccess, Unauthorized | Forbidden>;
    /** The run's sweep done: its commit becomes the last sweep's, its carry-over the next's. */
    readonly finishSweep: (
      projectId: string,
      payload: FinishSweepPayload,
    ) => Effect.Effect<void, Unauthorized | Forbidden | NotClaimOwner>;
    /** The run's sweep stopped short: recorded as stopped, its claim given up. */
    readonly stopSweep: (
      projectId: string,
      payload: StopSweepPayload,
    ) => Effect.Effect<void, Unauthorized | Forbidden>;
    /** Gives up the run's claim on the sweep, when none was due. */
    readonly endSweep: (
      projectId: string,
      payload: EndSweepPayload,
    ) => Effect.Effect<void, Unauthorized | Forbidden>;
  }
>()('@codetinder/flow-steps/CodeTinder') {
  static readonly layer = Layer.effect(
    CodeTinder,
    Effect.gen(function* () {
      const baseUrl = yield* Config.URL('CODETINDER_URL').pipe(
        Config.withDefault(new URL(CODETINDER_BASE_URL)),
      );
      const origin = baseUrl.origin;
      // A cold start or a busy instance answers 503 or drops a connection: retry those, so a
      // round isn't lost to them. Waits 500 ms, 1 s, then 2 s.
      const client = yield* HttpApiClient.make(Api, {
        baseUrl: origin,
        transformClient: HttpClient.retryTransient({
          schedule: Schedule.exponential('500 millis'),
          times: 3,
        }),
      });

      // A transport or decoding failure is a fault; the API's own errors stay typed.
      const transportFaults = { HttpClientError: Effect.die, SchemaError: Effect.die };

      return CodeTinder.of({
        baseUrl: origin,
        claim: payload => client.claims.claim({ payload }).pipe(Effect.catchTags(transportFaults)),
        endClaim: payload => client.claims.end({ payload }).pipe(Effect.catchTags(transportFaults)),
        createRound: payload =>
          client.rounds.create({ payload }).pipe(Effect.catchTags(transportFaults)),
        getRound: id =>
          client.rounds.getById({ params: { id } }).pipe(Effect.catchTags(transportFaults)),
        getSwipes: id =>
          client.rounds.getSwipes({ params: { id } }).pipe(Effect.catchTags(transportFaults)),
        getEvidence: id =>
          client.rounds.getEvidence({ params: { id } }).pipe(Effect.catchTags(transportFaults)),
        reportLearn: (id, payload) =>
          client.rounds
            .reportLearn({ params: { id }, payload })
            .pipe(Effect.catchTags(transportFaults)),
        getQuestions: projectId =>
          client.projects
            .getQuestions({ params: { projectId } })
            .pipe(Effect.catchTags(transportFaults)),
        getSweep: projectId =>
          client.sweeps.get({ params: { projectId } }).pipe(Effect.catchTags(transportFaults)),
        claimSweep: (projectId, payload) =>
          client.sweeps
            .claim({ params: { projectId }, payload })
            .pipe(Effect.catchTags(transportFaults)),
        finishSweep: (projectId, payload) =>
          client.sweeps
            .finish({ params: { projectId }, payload })
            .pipe(Effect.catchTags(transportFaults)),
        stopSweep: (projectId, payload) =>
          client.sweeps
            .stop({ params: { projectId }, payload })
            .pipe(Effect.catchTags(transportFaults)),
        endSweep: (projectId, payload) =>
          client.sweeps
            .end({ params: { projectId }, payload })
            .pipe(Effect.catchTags(transportFaults)),
      });
    }),
  ).pipe(
    Layer.provide(
      HttpApiMiddleware.layerClient(
        Authentication,
        Effect.gen(function* () {
          const token = yield* Config.Redacted('CODETINDER_ID_TOKEN');
          return ({ request, next }) => next(HttpClientRequest.bearerToken(request, token));
        }),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
  );
}

/** As much of the run's ID token as the run reads: the flow's service account it was issued to. */
const IdTokenPayloadSchema = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(Schema.Struct({ user_login: Schema.String }))),
);

/**
 * The flow's service account, the handle a developer mentions: its ID token's `user_login`. The
 * token is the run's own, so its payload is read without verifying it; codetinder.dev verifies.
 */
export const readServiceAccount = Effect.fn('codetinder.readServiceAccount')(function* () {
  const token = yield* Config.Redacted('CODETINDER_ID_TOKEN');
  const [, payload = ''] = Redacted.value(token).split('.');
  const { user_login } = yield* Schema.decodeEffect(IdTokenPayloadSchema)(payload).pipe(
    Effect.mapError(error => new Config.ConfigError(error)),
  );
  return user_login;
});

/** The public URL of a round on this client's origin. */
export const roundUrl = (baseUrl: string, id: RoundId): string => `${baseUrl}/rounds/${id}`;
