import { RoundIdSchema } from '@codetinder/api';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as QRCode from 'qrcode';

/**
 * `GET /rounds/<id>/qr.png`: a QR code of the round's URL, for the MR note, so a developer can
 * swipe on their phone. Public and unchecked: it encodes only the URL the note already links.
 */
export const RoundQrRoute = Layer.unwrap(
  Effect.gen(function* () {
    const { origin } = yield* Config.URL('CODETINDER_URL').pipe(
      Config.withDefault(new URL('https://codetinder.dev')),
    );

    return HttpRouter.add(
      'GET',
      '/rounds/:id/qr.png',
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.params;
        const roundId = Schema.decodeUnknownOption(RoundIdSchema)(id);
        if (Option.isNone(roundId)) return HttpServerResponse.empty({ status: 404 });

        const png = yield* Effect.promise(() =>
          QRCode.toBuffer(`${origin}/rounds/${roundId.value}`, {
            errorCorrectionLevel: 'M',
            margin: 2,
            scale: 8,
          }),
        );
        // A round's URL never changes, so neither does its code.
        return HttpServerResponse.raw(png, {
          contentType: 'image/png',
          headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        });
      }),
    );
  }),
);
