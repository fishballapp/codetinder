import type { ProjectConfig } from '@codetinder/core';

/** For tests: `.codetinder/config.json` as the setup MR writes it, with any field overridden. */
export const projectConfigFile = (overrides: Partial<ProjectConfig> = {}) => ({
  '.codetinder/config.json': JSON.stringify({
    version: 1,
    install: 'npm ci',
    test: 'npm test',
    proposal: 'merge-request',
    tone: 'mischievous',
    ...overrides,
  }),
});
