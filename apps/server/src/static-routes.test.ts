import * as NodeFs from 'node:fs';
import * as NodeOs from 'node:os';
import * as NodePath from 'node:path';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServer from 'effect/http/HttpServer';
import * as Layer from 'effect/Layer';
import { AppRoutes } from './app';
import { RoundStore } from './round-store';
import { SweepStore } from './sweep-store';
import { fakeIdTokens, fakeUsers } from './test-fixtures';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IMMUTABLE = 'public, max-age=31536000, immutable';
const ONE_HOUR = 'public, max-age=3600';
const SECRET = 'TOP SECRET: outside the dist folders';

const withStaticFixtures = <A, E>(
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E>,
): Effect.Effect<A, E> => {
  const tmpDir = NodePath.join(NodeOs.tmpdir(), `codetinder-test-${crypto.randomUUID()}`);
  NodeFs.mkdirSync(tmpDir, { recursive: true });

  const bundlePath = NodePath.join(tmpDir, 'flow-steps.js');
  NodeFs.writeFileSync(bundlePath, 'export const version = "test";\n');
  // Sits beside the dist folders, so any traversal that escapes them would read it.
  NodeFs.writeFileSync(NodePath.join(tmpDir, 'secret.txt'), SECRET);

  const webDistPath = NodePath.join(tmpDir, 'web');
  NodeFs.mkdirSync(NodePath.join(webDistPath, 'assets'), { recursive: true });
  NodeFs.writeFileSync(
    NodePath.join(webDistPath, 'index.html'),
    '<!doctype html><html><body><div id="root">CodeTinder Web</div></body></html>',
  );
  NodeFs.writeFileSync(NodePath.join(webDistPath, 'assets', 'app-123.js'), 'console.log("app");');
  NodeFs.writeFileSync(NodePath.join(webDistPath, 'assets', 'heart-123.webp'), 'RIFF');

  const siteDistPath = NodePath.join(tmpDir, 'site');
  NodeFs.mkdirSync(NodePath.join(siteDistPath, '_astro'), { recursive: true });
  NodeFs.writeFileSync(
    NodePath.join(siteDistPath, 'index.html'),
    '<!doctype html><html><body>CodeTinder Marketing</body></html>',
  );
  NodeFs.writeFileSync(
    NodePath.join(siteDistPath, 'privacy.html'),
    '<!doctype html><html><body>CodeTinder Privacy</body></html>',
  );
  NodeFs.writeFileSync(NodePath.join(siteDistPath, 'robots.txt'), 'User-agent: *\n');
  NodeFs.writeFileSync(NodePath.join(siteDistPath, 'favicon.svg'), '<svg/>');
  NodeFs.writeFileSync(NodePath.join(siteDistPath, '_astro', 'x.js'), 'console.log("site");');

  const routes = AppRoutes.pipe(
    Layer.provide(Layer.mergeAll(RoundStore.memory, SweepStore.memory)),
    Layer.provide(fakeIdTokens),
    Layer.provide(fakeUsers),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          FLOW_STEPS_PATH: bundlePath,
          WEB_DIST_PATH: webDistPath,
          SITE_DIST_PATH: siteDistPath,
        }),
      ),
    ),
    Layer.provide(HttpServer.layerServices),
  );

  return Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    ({ handler }) => use(handler),
    ({ dispose }) =>
      Effect.promise(async () => {
        await dispose();
        NodeFs.rmSync(tmpDir, { recursive: true, force: true });
      }),
  );
};

const get = (handler: (request: Request) => Promise<Response>, path: string) =>
  Effect.promise(() => handler(new Request(`http://localhost${path}`)));

describe('static routes', () => {
  it.effect('serves the marketing index at / with no-cache', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        const response = yield* get(handler, '/');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/text\/html/);
        expect(response.headers.get('cache-control')).toBe('no-cache');
        const body = yield* Effect.promise(() => response.text());
        expect(body).toContain('CodeTinder Marketing');
      }),
    ),
  );

  it.effect('serves marketing pages extensionless, as their .html file', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        const response = yield* get(handler, '/privacy');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/text\/html/);
        expect(response.headers.get('cache-control')).toBe('no-cache');
        const body = yield* Effect.promise(() => response.text());
        expect(body).toContain('CodeTinder Privacy');
      }),
    ),
  );

  it.effect('serves marketing root files and hashed bundles with their cache headers', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        const robots = yield* get(handler, '/robots.txt');
        expect(robots.status).toBe(200);
        expect(robots.headers.get('content-type')).toMatch(/^text\/plain/);
        expect(robots.headers.get('cache-control')).toBe(ONE_HOUR);

        const favicon = yield* get(handler, '/favicon.svg');
        expect(favicon.status).toBe(200);
        expect(favicon.headers.get('content-type')).toBe('image/svg+xml');
        expect(favicon.headers.get('cache-control')).toBe(ONE_HOUR);

        const bundle = yield* get(handler, '/_astro/x.js');
        expect(bundle.status).toBe(200);
        expect(bundle.headers.get('content-type')).toMatch(/javascript/);
        expect(bundle.headers.get('cache-control')).toBe(IMMUTABLE);
        const body = yield* Effect.promise(() => bundle.text());
        expect(body).toContain('console.log("site");');
      }),
    ),
  );

  it.effect('serves the app shell for SPA routes with no-cache', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        for (const path of [
          '/projects',
          '/rounds/round-123',
          '/auth/callback?code=x',
          '/some/unknown',
        ]) {
          const response = yield* get(handler, path);
          expect(response.status).toBe(200);
          expect(response.headers.get('content-type')).toMatch(/text\/html/);
          expect(response.headers.get('cache-control')).toBe('no-cache');
          const body = yield* Effect.promise(() => response.text());
          expect(body).toContain('CodeTinder Web');
        }
      }),
    ),
  );

  it.effect('serves app assets with their content types and immutable caching', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        const script = yield* get(handler, '/assets/app-123.js');
        expect(script.status).toBe(200);
        expect(script.headers.get('content-type')).toMatch(/javascript/);
        expect(script.headers.get('cache-control')).toBe(IMMUTABLE);
        const body = yield* Effect.promise(() => script.text());
        expect(body).toContain('console.log("app");');

        const image = yield* get(handler, '/assets/heart-123.webp');
        expect(image.status).toBe(200);
        expect(image.headers.get('content-type')).toBe('image/webp');
      }),
    ),
  );

  it.effect('returns 404 for a missing app asset', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        const response = yield* get(handler, '/assets/nope.js');
        expect(response.status).toBe(404);
      }),
    ),
  );

  it.effect('never reads outside the dist folders', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        const attempts = [
          '/../secret.txt',
          '/%2e%2e/secret.txt',
          '/%2e%2e%2fsecret.txt',
          '/..%2fsecret.txt',
          '/%252e%252e%252fsecret.txt',
          '//secret.txt',
          '/%2f%2e%2e%2fsecret.txt',
          '/assets/..%2f..%2fsecret.txt',
          '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
          '/privacy/..%2f..%2fsecret.txt',
          '/%00/secret.txt',
          '/%E0%A4%A',
        ];
        for (const path of attempts) {
          const response = yield* get(handler, path);
          const body = yield* Effect.promise(() => response.text());
          expect(body, path).not.toContain(SECRET);
        }
      }),
    ),
  );

  it.effect('serves the flow-steps bundle with no-cache', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        const response = yield* get(handler, '/flow-steps/v1.js');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/javascript/);
        expect(response.headers.get('cache-control')).toBe('no-cache');
        const body = yield* Effect.promise(() => response.text());
        expect(body).toContain('export const version');
      }),
    ),
  );

  it.effect('serves QR png for valid round id with immutable caching', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        const response = yield* get(handler, '/rounds/0123456789AB/qr.png');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(response.headers.get('cache-control')).toBe(IMMUTABLE);
        const buffer = yield* Effect.promise(() => response.arrayBuffer());
        const bytes = new Uint8Array(buffer);
        expect(Array.from(bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);
      }),
    ),
  );

  it.effect('returns 404, not the app shell, for an invalid round id on the qr route', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        const response = yield* get(handler, '/rounds/invalid-id/qr.png');
        expect(response.status).toBe(404);
      }),
    ),
  );

  it.effect('serves the app shell for the round page while the qr route serves its image', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        const roundResponse = yield* get(handler, '/rounds/0123456789AB');
        expect(roundResponse.status).toBe(200);
        expect(roundResponse.headers.get('content-type')).toMatch(/text\/html/);
        const body = yield* Effect.promise(() => roundResponse.text());
        expect(body).toContain('CodeTinder Web');

        const qrResponse = yield* get(handler, '/rounds/0123456789AB/qr.png');
        expect(qrResponse.status).toBe(200);
        expect(qrResponse.headers.get('content-type')).toBe('image/png');
      }),
    ),
  );

  it.effect('answers API routes ahead of the catch-all', () =>
    withStaticFixtures(handler =>
      Effect.gen(function* () {
        // No credentials: the API answers 401 itself rather than falling through to the shell.
        const response = yield* get(handler, '/api/rounds/0123456789AB');
        expect(response.status).toBe(401);
      }),
    ),
  );
});
