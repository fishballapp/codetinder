// The rate limit on signups: Cloudflare's Workers Rate Limiting binding, which counts each key
// in each location on its own and is approximate (a few requests past the limit can pass).
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

export class SignupLimit extends Context.Service<
  SignupLimit,
  {
    /** Counts one request against `key`'s allowance, and says whether it is still within it. */
    readonly allows: (key: string) => Effect.Effect<boolean>;
  }
>()('@codetinder/worker-web/platform/SignupLimit') {
  static readonly layer = (binding: RateLimit) =>
    Layer.succeed(
      SignupLimit,
      SignupLimit.of({
        allows: Effect.fn('SignupLimit.allows')(function* (key) {
          const { success } = yield* Effect.tryPromise(() => binding.limit({ key })).pipe(
            Effect.orDie,
          );
          return success;
        }),
      }),
    );
}

const IPV6_GROUPS = 8;

/**
 * Who a request counts against, from the `cf-connecting-ip` Cloudflare sets. An IPv6 client is its
 * /64, because one machine holds a whole /64 and could otherwise spend a fresh allowance per
 * address. The header is always there on Cloudflare's edge; a request without it (or with it
 * empty) shares one key. The edge sends canonical forms, so an IPv4-mapped IPv6 address or one with
 * a dotted tail is not specially read: it is keyed as whatever its first four groups are.
 */
export const clientKey = (ip: string | undefined): string => {
  if (ip === undefined || ip === '') return 'no-client-ip';
  if (!ip.includes(':')) return ip;
  const [head = '', tail] = ip.split('::');
  const leading = head === '' ? [] : head.split(':');
  const trailing = tail === undefined || tail === '' ? [] : tail.split(':');
  const zeros = Array.from(
    { length: tail === undefined ? 0 : IPV6_GROUPS - leading.length - trailing.length },
    () => '0',
  );
  return `${[...leading, ...zeros, ...trailing]
    .slice(0, 4)
    .map(group => group.toLowerCase().padStart(4, '0'))
    .join(':')}::/64`;
};
