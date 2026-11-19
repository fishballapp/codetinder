import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from './project-config';

const decode = Schema.decodeUnknownResult(ProjectConfigSchema);

const config = {
  version: 1,
  install: 'npm ci',
  test: 'npm test',
  proposal: 'merge-request',
  tone: 'mischievous',
};

describe('ProjectConfigSchema', () => {
  it('decodes a complete config', () => {
    expect(decode(config)).toEqual(Result.succeed(config));
    expect(Result.isSuccess(decode({ ...config, proposal: 'push', tone: 'plain' }))).toBe(true);
  });

  it('still decodes a config from before the doc had a fixed path, ignoring its `principles`', () => {
    expect(decode({ ...config, principles: 'docs/code.md' })).toEqual(Result.succeed(config));
  });

  it('rejects a missing or empty field, an unknown option, or another version', () => {
    const { install: _, ...withoutInstall } = config;
    for (const invalid of [
      withoutInstall,
      { ...config, install: '' },
      { ...config, proposal: 'apply' },
      { ...config, tone: 'corporate' },
      { ...config, version: 2 },
    ]) {
      expect(Result.isFailure(decode(invalid))).toBe(true);
    }
  });
});
