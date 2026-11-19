#!/usr/bin/env node
/**
 * Puts the marketing site (@codetinder/site) and this package's _headers into dist/, the one
 * assets directory wrangler.jsonc serves. The site must be built, and must have a 404.html: it is
 * what every other path answers with. `--allow-missing` (for `wrangler dev`, which only needs the
 * directory) assembles whatever is there and warns about the rest.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.resolve(packageDir, '../site/dist');
const out = path.join(packageDir, 'dist');
const isMissingAllowed = process.argv.includes('--allow-missing');

const problems = [
  { file: 'index.html', fix: 'Run `pnpm -F @codetinder/site build`.' },
  { file: '404.html', fix: 'The site needs a 404 page (src/pages/404.astro).' },
].filter(({ file }) => !existsSync(path.join(siteDir, file)));

for (const { file, fix } of problems) {
  const message = `@codetinder/site has no ${path.relative(packageDir, path.join(siteDir, file))}. ${fix}`;
  if (!isMissingAllowed) throw new Error(message);
  console.warn(`Warning: ${message}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (existsSync(siteDir)) cpSync(siteDir, out, { recursive: true });
copyFileSync(path.join(packageDir, '_headers'), path.join(out, '_headers'));
console.log('Assembled the site and _headers into dist/.');
