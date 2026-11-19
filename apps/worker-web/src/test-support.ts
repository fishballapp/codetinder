/// <reference types="node" />
// Tests run the REAL code (real SQL through the real `D1Client` over an in-memory `node:sqlite` with
// every migration applied, the real services, HTTP app and guards) and fake only the rate limit
// binding.
import { fileURLToPath } from 'node:url';
import { captureLogs, createTestD1 } from '@internal/effect-worker/testing';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as Layer from 'effect/Layer';
import { onTestFinished } from 'vitest';
import { HttpApp } from './http/app';
import { makeWorkerLayer } from './layer';
import { SignupLimit } from './platform/signup-limit';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url).href);

/** How many calls per key the fake allows before it refuses, as the real binding's `limit` does. */
export const FAKE_LIMIT = 5;

/** The rate limit binding: allows each key `FAKE_LIMIT` calls, never resets, and keeps the keys it saw. */
export const fakeRateLimit = (): RateLimit & { readonly keys: string[] } => {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: RateLimitOptions) => {
      keys.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= FAKE_LIMIT };
    },
  };
};

export type EntryRow = {
  id: number;
  email: string;
  email_normalised: string;
  platform: string | null;
  consent_version: string;
  joined_at: number;
};

/**
 * A body as the browser sends it: JSON bytes with their Content-Length. A header given as
 * `undefined` is left off. The body is bytes, so the runtime adds no Content-Type of its own.
 */
export const jsonRequest = (
  body: unknown,
  headers: Record<string, string | undefined> = {},
  method = 'POST',
  path = '/api/waitlist',
) => {
  const bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  const sent = {
    'content-type': 'application/json',
    'content-length': String(bytes.length),
    'cf-connecting-ip': '203.0.113.7',
    ...headers,
  };
  return new Request(`http://localhost${path}`, {
    method,
    headers: Object.fromEntries(
      Object.entries(sent).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    ...(method === 'GET' || method === 'OPTIONS' ? {} : { body: bytes }),
  });
};

export const VALID = { email: 'ada@example.com', consent: 'v1' } as const;

/** `api` is the real HTTP app as a `fetch`. */
export const testWorld = () => {
  const { sqlite, d1 } = createTestD1({ migrationsDir });
  const limit = fakeRateLimit();
  const logging = captureLogs();
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpApp.pipe(
      Layer.provideMerge(makeWorkerLayer(d1, SignupLimit.layer(limit))),
      Layer.provideMerge(logging.layer),
    ),
    { disableLogger: true },
  );
  onTestFinished(dispose);

  return {
    sqlite,
    limit,
    logs: logging.logs,
    api: (request: Request) => handler(request),
    entries: () =>
      sqlite.prepare('SELECT * FROM waitlist_entry ORDER BY id').all() as unknown as EntryRow[],
  };
};
