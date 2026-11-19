import * as NodeFs from 'node:fs';
import * as NodeOs from 'node:os';
import * as NodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appPaths,
  appRoutePattern,
  findClashes,
  listFiles,
  marketingPaths,
  pagePatterns,
} from './check-routes';

describe('pagePatterns', () => {
  it('maps Astro pages to their URL, index to its folder, and dynamic segments to /*', () => {
    expect(pagePatterns('index.astro')).toEqual(['/']);
    expect(pagePatterns('privacy.astro')).toEqual(['/privacy']);
    expect(pagePatterns('privacy.md')).toEqual(['/privacy']);
    expect(pagePatterns('blog/index.astro')).toEqual(['/blog']);
    expect(pagePatterns('blog/[slug].astro')).toEqual(['/blog/*']);
  });

  it('treats a segment with a parameter anywhere in it as dynamic', () => {
    expect(pagePatterns('[prefix]jects.astro')).toEqual(['/*']);
  });

  it('lets a rest parameter be empty, so it claims its folder too', () => {
    expect(pagePatterns('docs/[...rest].astro')).toEqual(['/docs', '/docs/*']);
    expect(pagePatterns('[...rest].astro')).toEqual(['/', '/*']);
  });

  it('ignores files that are not pages', () => {
    expect(pagePatterns('styles.css')).toEqual([]);
  });
});

describe('appRoutePattern', () => {
  it('maps TanStack flat routes to their paths', () => {
    expect(appRoutePattern('index.tsx')).toBe('/');
    expect(appRoutePattern('projects.tsx')).toBe('/projects');
    expect(appRoutePattern('rounds.$id.tsx')).toBe('/rounds/*');
    expect(appRoutePattern('auth.callback.tsx')).toBe('/auth/callback');
    expect(appRoutePattern('projects.index.tsx')).toBe('/projects');
  });

  it('ignores the root, the generated tree, `-` files and layouts, which claim no URL', () => {
    expect(appRoutePattern('__root.tsx')).toBeUndefined();
    expect(appRoutePattern('routeTree.gen.ts')).toBeUndefined();
    expect(appRoutePattern('-helpers.tsx')).toBeUndefined();
    expect(appRoutePattern('_authed.tsx')).toBeUndefined();
  });

  it('drops pathless layout segments from the path of their children', () => {
    expect(appRoutePattern('_authed.projects.tsx')).toBe('/projects');
    expect(appRoutePattern('_authed.index.tsx')).toBe('/');
  });
});

describe('marketingPaths and appPaths', () => {
  it('claims public files at their root path, and reserves /assets/* for the app', () => {
    expect(marketingPaths(['index.astro'], ['robots.txt', 'og/card.png'])).toEqual([
      '/',
      '/robots.txt',
      '/og/card.png',
    ]);
    expect(appPaths(['index.tsx'])).toEqual(['/assets/*', '/']);
  });

  it('claims a public HTML file without its extension too, as the server serves it', () => {
    expect(marketingPaths([], ['projects.html', 'index.html'])).toEqual([
      '/projects.html',
      '/projects',
      '/index.html',
      '/',
    ]);
  });

  it('catches the clashes these extra claims reveal', () => {
    const app = appPaths(['projects.tsx', 'rounds.$id.tsx']);
    expect(findClashes(marketingPaths(['projects/[...rest].astro'], []), app)).toContainEqual({
      marketing: '/projects',
      app: '/projects',
    });
    expect(findClashes(marketingPaths([], ['projects.html']), app)).toContainEqual({
      marketing: '/projects',
      app: '/projects',
    });
  });
});

describe('findClashes', () => {
  it('reports the same static path on both sides', () => {
    expect(findClashes(['/privacy'], ['/projects', '/privacy'])).toEqual([
      { marketing: '/privacy', app: '/privacy' },
    ]);
  });

  it('reports a static path that a dynamic pattern on the other side covers', () => {
    expect(findClashes(['/rounds/ABC'], ['/rounds/*'])).toEqual([
      { marketing: '/rounds/ABC', app: '/rounds/*' },
    ]);
    expect(findClashes(['/blog/*'], ['/blog/first-post'])).toEqual([
      { marketing: '/blog/*', app: '/blog/first-post' },
    ]);
  });

  it('reports two dynamic patterns that overlap, nested or equal', () => {
    expect(findClashes(['/blog/*'], ['/blog/*'])).toHaveLength(1);
    expect(findClashes(['/a/*'], ['/a/b/*'])).toHaveLength(1);
  });

  it('reports a marketing root against the app root, and the reserved assets prefix', () => {
    expect(findClashes(['/'], ['/'])).toHaveLength(1);
    expect(findClashes(['/assets/logo.png'], ['/assets/*'])).toHaveLength(1);
  });

  it('does not report paths that only look alike', () => {
    expect(findClashes(['/privacy'], ['/projects'])).toEqual([]);
    expect(findClashes(['/blogs/*'], ['/blog/*'])).toEqual([]);
    // `/projects/*` is under `/projects/`, which the app's `/projects` page is not.
    expect(findClashes(['/projects/*'], ['/projects'])).toEqual([]);
    expect(findClashes(['/rounds'], ['/rounds/*'])).toEqual([]);
  });
});

describe('listFiles', () => {
  it('lists files recursively, and a missing folder has none', () => {
    const tmpDir = NodePath.join(NodeOs.tmpdir(), `codetinder-routes-${crypto.randomUUID()}`);
    try {
      NodeFs.mkdirSync(NodePath.join(tmpDir, 'blog'), { recursive: true });
      NodeFs.writeFileSync(NodePath.join(tmpDir, 'index.astro'), '');
      NodeFs.writeFileSync(NodePath.join(tmpDir, 'blog', '[slug].astro'), '');

      expect(listFiles(tmpDir).sort()).toEqual(['blog/[slug].astro', 'index.astro']);
      expect(listFiles(NodePath.join(tmpDir, 'missing'))).toEqual([]);
    } finally {
      NodeFs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
