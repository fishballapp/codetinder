import { describe, expect, it } from 'vitest';
import { isNotCode } from './no-code';

describe('isNotCode', () => {
  it.each([
    'README.md',
    'docs/guide.MDX',
    'notes.txt',
    'docs/spec.rst',
    'assets/logo.PNG',
    'public/favicon.ico',
    'diagram.svg',
    'pnpm-lock.yaml',
    'apps/web/package-lock.json',
    'Cargo.lock',
    'go.sum',
  ])('is true for %s', path => {
    expect(isNotCode(path)).toBe(true);
  });

  it.each([
    'src/index.ts',
    'script.py',
    'package.json',
    'config.yaml',
    'Makefile',
    '.md',
    'docs/readme.md.ts',
    'lock',
  ])('is false for %s', path => {
    expect(isNotCode(path)).toBe(false);
  });
});
