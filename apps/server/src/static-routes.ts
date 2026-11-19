import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as Layer from 'effect/Layer';
import type * as PlatformError from 'effect/PlatformError';

const CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';
const ONE_HOUR = 'public, max-age=3600';

const getContentType = (fileName: string): string => {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1) return 'application/octet-stream';
  const ext = fileName.slice(dotIndex);
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
};

/** `_astro/` bundles are content-hashed; HTML must revalidate; other site files cache for an hour. */
const siteCacheControl = (key: string, contentType: string): string => {
  if (key.startsWith('_astro/')) return IMMUTABLE;
  if (contentType.startsWith('text/html')) return NO_CACHE;
  return ONE_HOUR;
};

/** A file read at startup, so each request stays a pure web Response. */
type StaticFile = {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly cacheControl: string;
};

const readFile = (
  fs: FileSystem.FileSystem,
  path: string,
  key: string,
  cacheControl: (key: string, contentType: string) => string,
): Effect.Effect<StaticFile, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const contentType = getContentType(key);
    return {
      content: yield* fs.readFile(path),
      contentType,
      cacheControl: cacheControl(key, contentType),
    };
  });

/** Every file under `dir`, keyed by its `/`-separated path relative to `dir`. */
const readTree = (
  fs: FileSystem.FileSystem,
  dir: string,
  cacheControl: (key: string, contentType: string) => string,
  prefix = '',
): Effect.Effect<Map<string, StaticFile>, PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const files = new Map<string, StaticFile>();
    for (const name of yield* fs.readDirectory(dir)) {
      const path = `${dir}/${name}`;
      const key = `${prefix}${name}`;
      const stat = yield* fs.stat(path);
      if (stat.type === 'Directory') {
        for (const [childKey, file] of yield* readTree(fs, path, cacheControl, `${key}/`)) {
          files.set(childKey, file);
        }
      } else if (stat.type === 'File') {
        files.set(key, yield* readFile(fs, path, key, cacheControl));
      }
    }
    return files;
  });

/** Percent-decodes a request path; a stray `%` is not an encoding, so it is kept literally. */
const decodePath = (pathname: string): string => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

/**
 * Serves the marketing site, the app's assets and the app shell from one origin, with no path
 * list to maintain. Files are looked up in in-memory maps keyed by relative path, so nothing is
 * read from disk per request and a `..` can match nothing.
 *
 * Route precedence is the router's: API, `/flow-steps/v1.js` and the QR route are more specific
 * than this catch-all, and win.
 */
export const StaticRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const bundlePath = yield* Config.String('FLOW_STEPS_PATH').pipe(
      Config.withDefault('flow-steps.js'),
    );
    const webDistPath = yield* Config.String('WEB_DIST_PATH').pipe(Config.withDefault('web'));
    const siteDistPath = yield* Config.String('SITE_DIST_PATH').pipe(Config.withDefault('site'));
    const fs = yield* FileSystem.FileSystem;

    const bundle = yield* fs.readFileString(bundlePath).pipe(Effect.orDie);
    const appIndex = yield* readFile(
      fs,
      `${webDistPath}/index.html`,
      'index.html',
      () => NO_CACHE,
    ).pipe(Effect.orDie);
    const appAssets = yield* readTree(fs, `${webDistPath}/assets`, () => IMMUTABLE).pipe(
      Effect.orDie,
    );
    const site = yield* readTree(fs, siteDistPath, siteCacheControl).pipe(Effect.orDie);

    // Astro's `build.format: 'file'` writes `/privacy` as `privacy.html` and `/` as `index.html`.
    const findSiteFile = (pathname: string): StaticFile | undefined => {
      const key = pathname.slice(1);
      if (key === '') return site.get('index.html');
      return site.get(key) ?? site.get(`${key}.html`);
    };

    const serve = (file: StaticFile): HttpServerResponse.HttpServerResponse =>
      HttpServerResponse.raw(file.content, {
        contentType: file.contentType,
        headers: { 'cache-control': file.cacheControl },
      });

    return Layer.mergeAll(
      HttpRouter.add(
        'GET',
        '/flow-steps/v1.js',
        HttpServerResponse.text(bundle, {
          contentType: 'text/javascript',
          headers: { 'cache-control': NO_CACHE },
        }),
      ),
      HttpRouter.add(
        'GET',
        '/*',
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;
          const pathname = decodePath(new URL(req.url, 'http://localhost').pathname);

          const siteFile = findSiteFile(pathname);
          if (siteFile) return serve(siteFile);

          if (pathname.startsWith('/assets/')) {
            const asset = appAssets.get(pathname.slice('/assets/'.length));
            return asset ? serve(asset) : HttpServerResponse.empty({ status: 404 });
          }

          return serve(appIndex);
        }),
      ),
    );
  }),
);
