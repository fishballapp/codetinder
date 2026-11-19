import { describe, expect, it } from 'vitest';
import {
  type AgentConfigNeeds,
  mergeAgentConfig,
  renderAgentConfigAdditions,
  type SetupCommand,
} from './agent-config';

const libatomic: SetupCommand = {
  command: 'microdnf install -y libatomic',
  why: 'Node 25 links libatomic.',
  isForDefaultImage: true,
};

const needs: AgentConfigNeeds = {
  allowedDomains: ['registry.npmjs.org', 'codetinder.dev'],
  setupScript: [libatomic],
};

const merged = (existing: string | undefined, given: AgentConfigNeeds = needs) => {
  const result = mergeAgentConfig(existing, given);
  if (result._tag !== 'Merged') throw new Error(`expected a merge, got ${result._tag}`);
  return result;
};

describe('mergeAgentConfig', () => {
  it('writes a fresh config when the project has none', () => {
    expect(merged(undefined).content).toBe(`id_tokens:
  CODETINDER_ID_TOKEN:
    aud: https://codetinder.dev
setup_script:
  # Node 25 links libatomic.
  - microdnf install -y libatomic
network_policy:
  allowed_domains:
    - registry.npmjs.org
    - codetinder.dev
`);
  });

  it("adds to the team's config, keeping its keys, order and comments", () => {
    const existing = `# Our flows' sandbox.
cache:
  paths: [node_modules] # warm installs
network_policy:
  allowed_domains:
    - registry.npmjs.org # npm
  include_recommended_allowed: true
setup_script:
  - dnf install -y git-lfs
`;
    const result = merged(existing);
    expect(result.content).toBe(`# Our flows' sandbox.
cache:
  paths: [ node_modules ] # warm installs
network_policy:
  allowed_domains:
    - registry.npmjs.org # npm
    - codetinder.dev
  include_recommended_allowed: true
setup_script:
  - dnf install -y git-lfs
  # Node 25 links libatomic.
  - microdnf install -y libatomic
id_tokens:
  CODETINDER_ID_TOKEN:
    aud: https://codetinder.dev
`);
    expect(result.added).toEqual({
      isIdTokenAdded: true,
      allowedDomains: ['codetinder.dev'],
      setupScript: [libatomic],
    });
    expect(result.customImage).toBeUndefined();
  });

  it('turns a one-command setup_script into a list, its command first', () => {
    expect(merged('setup_script: apt-get update\n').content).toContain(`setup_script:
  - apt-get update
  # Node 25 links libatomic.
  - microdnf install -y libatomic
`);
  });

  it("leaves out the default image's commands under a custom image, and says which image", () => {
    const result = merged('image: node:24\n');
    expect(result.customImage).toBe('node:24');
    expect(result.added.setupScript).toEqual([]);
    expect(result.content).not.toContain('setup_script');
    expect(result.content).toMatch(/^image: node:24\n/);
  });

  it('changes nothing once merged, so Finish setup can run again', () => {
    expect(mergeAgentConfig(merged(undefined).content, needs)).toEqual({
      _tag: 'Unchanged',
      customImage: undefined,
    });
    const listAudience = `id_tokens:
  CODETINDER_ID_TOKEN:
    aud: [https://codetinder.dev, https://example.com]
`;
    expect(merged(listAudience).added.isIdTokenAdded).toBe(false);
  });

  it("refuses what it can't merge without changing the team's settings", () => {
    const cases: [string, string][] = [
      ['network_policy: [', "it isn't valid YAML"],
      ['- a\n- b\n', "it isn't a YAML mapping"],
      [
        'id_tokens:\n  CODETINDER_ID_TOKEN:\n    aud: https://example.com\n',
        'its `CODETINDER_ID_TOKEN` is for another audience than `https://codetinder.dev`',
      ],
      ['network_policy:\n  allowed_domains: example.com\n', "its `allowed_domains` isn't a list"],
      ['setup_script:\n  run: x\n', "its `setup_script` isn't a command or a list of them"],
      ['image:\n  name: node:24\n', "its `image` isn't a string"],
    ];
    for (const [existing, reason] of cases) {
      expect(mergeAgentConfig(existing, needs)).toEqual({ _tag: 'Conflict', reason });
    }
  });

  it("keeps a one-command setup_script's comment when it becomes a list", () => {
    expect(merged('setup_script: apt-get update # ours\n').content).toContain(
      'setup_script:\n  - apt-get update # ours\n',
    );
  });

  it('refuses anchors or aliases on the keys it adds to, and never throws', () => {
    expect(mergeAgentConfig('setup_script: &script echo hi\nother: *script\n', needs)).toEqual({
      _tag: 'Conflict',
      reason: 'its `setup_script` uses YAML anchors or aliases, which adding to could break',
    });
    expect(
      mergeAgentConfig(
        'base: &domains [a.com]\nnetwork_policy:\n  allowed_domains: *domains\n',
        needs,
      ),
    ).toMatchObject({ _tag: 'Conflict' });
    for (const odd of [
      '? [a]\n: b\n',
      '!!binary aGk=',
      '%YAML 1.1\n---\n<<: {}\n',
      'a: !custom x\n',
    ]) {
      expect(() => mergeAgentConfig(odd, needs)).not.toThrow();
    }
  });

  it('reads a file of comments only as an empty config', () => {
    expect(merged('# nothing yet\n').content).toContain('# nothing yet');
  });
});

describe('renderAgentConfigAdditions', () => {
  it('shows only what was added, as YAML', () => {
    expect(
      renderAgentConfigAdditions({
        isIdTokenAdded: false,
        allowedDomains: ['codetinder.dev'],
        setupScript: [],
      }),
    ).toBe('network_policy:\n  allowed_domains:\n    - codetinder.dev\n');
  });
});
