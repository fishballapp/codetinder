import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';

/** A `fetch` that answers with the given handler, for tests over the real HttpClient. */
export const scriptedFetch = (
  handler: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };
  return fetch;
};

export const withScriptedFetch = (fetch: typeof globalThis.fetch) =>
  Layer.succeed(FetchHttpClient.Fetch, fetch);
