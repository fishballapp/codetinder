import { describe, expect, it } from 'vitest';
import { mergeAgentConfig } from './agent-config';
import {
  isProposedIn,
  isSandboxFixMergeRequest,
  sandboxFixDescription,
  sandboxFixItems,
  sandboxFixItemsIn,
  sandboxFixItemsOf,
  sandboxFixNeeds,
} from './sandbox-fix';

describe('sandboxFixItems', () => {
  it('allows the hosts the sandbox blocked', () => {
    expect(
      sandboxFixItems({ _tag: 'BlockedHosts', hosts: ['api.example.com', 'cdn.example.com'] }),
    ).toEqual([
      { _tag: 'Host', host: 'api.example.com' },
      { _tag: 'Host', host: 'cdn.example.com' },
    ]);
  });

  it('installs the UBI 9 package of each library the image lacks', () => {
    expect(
      sandboxFixItems({
        _tag: 'MissingLibraries',
        libraries: ['libnss3.so', 'libgbm.so.1', 'libatomic.so.1'],
      }),
    ).toEqual([
      { _tag: 'Library', library: 'libnss3.so', package: 'nss' },
      { _tag: 'Library', library: 'libgbm.so.1', package: 'mesa-libgbm' },
      { _tag: 'Library', library: 'libatomic.so.1', package: 'libatomic' },
    ]);
  });

  it('proposes nothing for a library without a known package, or a diagnosis config cannot fix', () => {
    expect(
      sandboxFixItems({ _tag: 'MissingLibraries', libraries: ['libnss3.so', 'libmystery.so.9'] }),
    ).toEqual([]);
    expect(sandboxFixItems({ _tag: 'TimedOut' })).toEqual([]);
    expect(sandboxFixItems({ _tag: 'ReadOnlyPaths', paths: ['/var/lib'] })).toEqual([]);
    expect(sandboxFixItems({ _tag: 'Unknown' })).toEqual([]);
  });
});

describe('sandboxFixNeeds', () => {
  it('asks for the hosts and one microdnf line for the packages, for the default image', () => {
    const needs = sandboxFixNeeds([
      { _tag: 'Host', host: 'api.example.com' },
      { _tag: 'Library', library: 'libnss3.so', package: 'nss' },
      { _tag: 'Library', library: 'libsmime3.so', package: 'nss' },
      { _tag: 'Library', library: 'libgbm.so.1', package: 'mesa-libgbm' },
    ]);
    expect(needs.allowedDomains).toEqual(['api.example.com']);
    expect(needs.setupScript).toEqual([
      {
        command: 'microdnf install -y nss mesa-libgbm',
        why: "Added by CodeTinder: the project's install or tests load libnss3.so, libsmime3.so, libgbm.so.1, which Duo's default image lacks.",
        isForDefaultImage: true,
      },
    ]);
  });

  it('adds nothing under a custom image, where microdnf may not exist', () => {
    const needs = sandboxFixNeeds([{ _tag: 'Library', library: 'libnss3.so', package: 'nss' }]);
    expect(
      mergeAgentConfig(
        'image: node:24\nid_tokens:\n  CODETINDER_ID_TOKEN:\n    aud: https://codetinder.dev\n',
        needs,
      ),
    ).toEqual({
      _tag: 'Unchanged',
      customImage: 'node:24',
    });
  });
});

describe('the fix MR description', () => {
  const items = [
    { _tag: 'Host', host: 'api.example.com' },
    { _tag: 'Library', library: 'libnss3.so', package: 'nss' },
  ] as const;

  it('lists each item, and reads them back from their markers', () => {
    const description = sandboxFixDescription(items);
    expect(description).toContain(
      '- Allow `api.example.com` in `network_policy.allowed_domains`, which the sandbox blocked.',
    );
    expect(description).toContain(
      '- Install `nss` in `setup_script`, for `libnss3.so`, which the image lacks.',
    );
    expect(sandboxFixItemsOf(description)).toEqual(items);
    expect(isProposedIn(description, { _tag: 'Host', host: 'api.example.com' })).toBe(true);
    expect(isProposedIn(description, { _tag: 'Host', host: 'example.com' })).toBe(false);
  });
});

describe('sandboxFixItemsIn', () => {
  const items = [
    { _tag: 'Host', host: 'api.example.com' },
    { _tag: 'Library', library: 'libnss3.so', package: 'nss' },
  ] as const;

  it('finds the hosts in the allow-list and the packages in microdnf lines', () => {
    const config = `network_policy:
  allowed_domains: [api.example.com]
setup_script:
  - microdnf install -y libatomic nss
`;
    expect(sandboxFixItemsIn(config, items)).toEqual(items);
    expect(sandboxFixItemsIn('setup_script: echo nss\n', items)).toEqual([]);
    expect(sandboxFixItemsIn('network_policy: [', items)).toEqual([]);
  });
});

describe('isSandboxFixMergeRequest', () => {
  it('needs both the branch prefix and an item marker', () => {
    const description = sandboxFixDescription([{ _tag: 'Host', host: 'a.com' }]);
    expect(
      isSandboxFixMergeRequest({ sourceBranch: 'codetinder/sandbox-fix-1', description }),
    ).toBe(true);
    expect(isSandboxFixMergeRequest({ sourceBranch: 'feature/x', description })).toBe(false);
    expect(
      isSandboxFixMergeRequest({ sourceBranch: 'codetinder/sandbox-fix-1', description: 'mine' }),
    ).toBe(false);
  });
});
