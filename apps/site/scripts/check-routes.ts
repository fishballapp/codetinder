/**
 * Fails when the marketing site and the app claim the same URL path. The server serves both from
 * one origin with one rule (a marketing file first, then the app), so a shared path would silently
 * hide whichever side the rule ranks second.
 *
 * Paths come from the file layout: Astro's `pages/` and `public/` for the site, TanStack Router's
 * flat file routes for the app. A dynamic segment makes a pattern `/prefix/*`, and two patterns
 * clash when either one claims the other's path.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');
const MARKETING_PAGES = 'apps/site/src/pages';
const MARKETING_PUBLIC = 'apps/site/public';
const APP_ROUTES = 'apps/web/src/routes';

const DYNAMIC = '*';
const PAGE_FILE = /\.(astro|md|mdx|js|ts)$/;
const ROUTE_FILE = /\.tsx?$/;

/** A route pattern: a static path such as `/privacy`, or `/blog/*` for everything under `/blog/`. */
const toPattern = (segments: readonly string[]): string => {
  const statics: string[] = [];
  for (const segment of segments) {
    // Anything after a dynamic segment is covered too: that can over-report a clash, never miss one.
    if (segment === DYNAMIC) return `/${[...statics, DYNAMIC].join('/')}`;
    statics.push(segment);
  }
  return `/${statics.join('/')}`;
};

/**
 * An Astro page's routes. `index` is its folder's root; a segment with a `[param]` anywhere in it
 * (`[slug]`, `[prefix]jects`) is dynamic; a rest parameter (`[...rest]`) may be empty, so it also
 * claims its folder's own path.
 */
export const pagePatterns = (file: string): string[] => {
  if (!PAGE_FILE.test(file)) return [];
  const names = file
    .replace(PAGE_FILE, '')
    .split('/')
    .filter(segment => segment !== 'index');
  const segments = names.map(segment => (/\[.+\]/.test(segment) ? DYNAMIC : segment));
  const restAt = names.findIndex(segment => /\[\.\.\..+\]/.test(segment));
  const pattern = toPattern(segments);
  return restAt === -1 ? [pattern] : [toPattern(segments.slice(0, restAt)), pattern];
};

/**
 * A TanStack flat route's path. Dots split segments; `$x` is dynamic; `index` adds no segment.
 * A layout (`_x`, last segment) claims no URL of its own, and `-` files are not routes.
 */
export const appRoutePattern = (file: string): string | undefined => {
  if (!ROUTE_FILE.test(file)) return undefined;
  const name = file.replace(ROUTE_FILE, '');
  if (name === 'routeTree.gen' || name.startsWith('-')) return undefined;

  const segments = name.split('.');
  if (segments.at(-1)?.startsWith('_')) return undefined;

  return toPattern(
    segments
      .filter(segment => segment !== 'index' && !segment.startsWith('_'))
      .map(segment => (segment.includes('$') ? DYNAMIC : segment)),
  );
};

/**
 * Every path the marketing site claims, from its pages and its `public/` files. The server answers
 * `/x` with `x.html` too, so a public HTML file also claims its path without the extension.
 */
export const marketingPaths = (
  pageFiles: readonly string[],
  publicFiles: readonly string[],
): string[] => [
  ...pageFiles.flatMap(pagePatterns),
  ...publicFiles.flatMap(file => {
    if (!file.endsWith('.html')) return [`/${file}`];
    const page = file === 'index.html' ? '' : file.slice(0, -'.html'.length);
    return [`/${file}`, `/${page}`];
  }),
];

/** Every path the app claims. `/assets/*` is reserved: the server serves the app's build there. */
export const appPaths = (routeFiles: readonly string[]): string[] => [
  '/assets/*',
  ...routeFiles.flatMap(file => appRoutePattern(file) ?? []),
];

export type Clash = { readonly marketing: string; readonly app: string };

/** Whether a pattern claims a path: exact for a static pattern, any path under the prefix for `/*`. */
const claims = (pattern: string, path: string): boolean =>
  pattern.endsWith(`/${DYNAMIC}`) ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

const overlaps = (a: string, b: string): boolean => claims(a, b) || claims(b, a);

export const findClashes = (marketing: readonly string[], app: readonly string[]): Clash[] =>
  marketing.flatMap(marketingPath =>
    app
      .filter(appPath => overlaps(marketingPath, appPath))
      .map(appPath => ({ marketing: marketingPath, app: appPath })),
  );

/** Files under `dir`, as paths relative to it. A missing folder has no files: the site may not exist yet. */
export const listFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)));
};

if (import.meta.main) {
  const marketing = marketingPaths(
    listFiles(join(PROJECT_ROOT, MARKETING_PAGES)),
    listFiles(join(PROJECT_ROOT, MARKETING_PUBLIC)),
  );
  const app = appPaths(listFiles(join(PROJECT_ROOT, APP_ROUTES)));
  const clashes = findClashes(marketing, app);

  if (clashes.length > 0) {
    for (const clash of clashes) {
      console.error(`${clash.marketing}  clashes with app route  ${clash.app}`);
    }
    console.error(
      `\n${clashes.length} route clash(es). The marketing site and the app must not claim the same path.`,
    );
    process.exit(1);
  }

  console.log(`Routes OK (${marketing.length} marketing, ${app.length} app).`);
}
