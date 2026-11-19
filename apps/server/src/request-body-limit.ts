import * as ByteSize from 'effect/ByteSize';
import * as Effect from 'effect/Effect';
import * as HttpIncomingMessage from 'effect/http/HttpIncomingMessage';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Result from 'effect/Result';

/** A request body is at most 1 MiB: a round is at most 900 KB, with its envelope well inside that. */
export const REQUEST_MAX_BYTES = 1024 * 1024;

const tooLarge = HttpServerResponse.text(`request body exceeds ${REQUEST_MAX_BYTES} bytes`, {
  status: 413,
});

/**
 * Answers 413 to a body over the cap before any route parses it. A declared length is refused
 * unread, so Node drains the upload and the client gets the 413. Otherwise the body is read under
 * the cap, as the API reads it: Node drops the connection at the cap, and a runtime that doesn't
 * enforce it hands over the whole body, which is measured here.
 */
export const RequestBodyLimit = HttpRouter.middleware(httpEffect =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers['content-length']) > REQUEST_MAX_BYTES) return tooLarge;
    const text = yield* request.text.pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.fromInputUnsafe(REQUEST_MAX_BYTES),
      ),
      Effect.result,
    );
    if (Result.isFailure(text)) return tooLarge;
    if (new TextEncoder().encode(text.success).byteLength > REQUEST_MAX_BYTES) return tooLarge;
    return yield* httpEffect;
  }),
);
