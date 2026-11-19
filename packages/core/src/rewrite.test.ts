import { describe, expect, it } from 'vitest';
import { isRewritable } from './rewrite';

describe('isRewritable', () => {
  const protectedFiles = [
    '.codetinder/config.json',
    '.gitlab/duo/agent-config.yml',
    '.gitlab-ci.yml',
    'package.json',
    'packages/app/package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'tsconfig.json',
    'tsconfig.build.json',
    'vitest.config.ts',
    'jest.config.js',
    '.eslintrc.json',
    'pyproject.toml',
    'go.mod',
    'src/todos.test.ts',
    'src/todos.spec.tsx',
    'pkg/todos_test.go',
    'tests/todos.py',
    'src/__tests__/todos.ts',
    'test_todos.py',
    'conftest.py',
    'pkg/sub/conftest.py',
    'noxfile.py',
    'setup.py',
    'karma.conf.js',
    'jest.setup.ts',
  ];
  const mergeRequestFiles = new Set(['src/todos.ts', 'src/latest.ts', ...protectedFiles]);

  it('allows source the merge request changes', () => {
    expect(isRewritable('src/todos.ts', mergeRequestFiles)).toBe(true);
    expect(isRewritable('src/latest.ts', mergeRequestFiles)).toBe(true);
  });

  it("refuses a file the merge request doesn't change", () => {
    expect(isRewritable('src/other.ts', mergeRequestFiles)).toBe(false);
  });

  it.each(protectedFiles)('refuses %s, which decides whether the tests pass', file => {
    expect(isRewritable(file, mergeRequestFiles)).toBe(false);
  });
});
