import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { pointerSection } from './agent-instructions';
import { parsePrinciplesDoc } from './principles';
import { ProjectConfigSchema } from './project-config';
import { guessToolchain, type RepoFile, setupMergeRequestDescription, setupPlan } from './setup';

const PNPM_COMMANDS = {
  install: 'pnpm install --frozen-lockfile',
  test: 'pnpm test',
};

describe('guessToolchain', () => {
  it('identifies pnpm-lock.yaml with highest priority', () => {
    expect(guessToolchain(['package-lock.json', 'pnpm-lock.yaml', 'src'])).toEqual({
      ...PNPM_COMMANDS,
      allowedDomains: ['registry.npmjs.org'],
    });
  });

  it('identifies package-lock.json', () => {
    expect(guessToolchain(['package-lock.json', 'package.json'])).toEqual({
      install: 'npm ci',
      test: 'npm test',
      allowedDomains: ['registry.npmjs.org'],
    });
  });

  it('identifies yarn.lock', () => {
    expect(guessToolchain(['yarn.lock', 'package.json'])).toEqual({
      install: 'yarn install --frozen-lockfile',
      test: 'yarn test',
      allowedDomains: ['registry.yarnpkg.com', 'repo.yarnpkg.com', 'registry.npmjs.org'],
    });
  });

  it('identifies bun.lock and bun.lockb', () => {
    expect(guessToolchain(['bun.lock'])).toEqual({
      install: 'npx --yes bun install --frozen-lockfile',
      test: 'npx --yes bun test',
      allowedDomains: ['registry.npmjs.org'],
    });
    expect(guessToolchain(['bun.lockb'])).toEqual({
      install: 'npx --yes bun install --frozen-lockfile',
      test: 'npx --yes bun test',
      allowedDomains: ['registry.npmjs.org'],
    });
  });

  it('identifies requirements.txt', () => {
    expect(guessToolchain(['requirements.txt', 'app.py'])).toEqual({
      install: 'python3 -m venv /tmp/.venv && /tmp/.venv/bin/pip install -r requirements.txt',
      test: '/tmp/.venv/bin/python -m pytest',
      allowedDomains: ['pypi.org', 'files.pythonhosted.org'],
    });
  });

  it('identifies go.mod', () => {
    expect(guessToolchain(['go.mod', 'main.go'])).toEqual({
      install: 'go mod download',
      test: 'go test ./...',
      allowedDomains: ['proxy.golang.org', 'sum.golang.org', 'storage.googleapis.com'],
    });
  });

  it('falls back when no known lockfile or toolchain config matches', () => {
    expect(guessToolchain(['README.md', 'LICENSE'])).toEqual({
      install: 'echo "Set install in .codetinder/config.json" && exit 1',
      test: 'echo "Set test in .codetinder/config.json" && exit 1',
      allowedDomains: [],
    });
  });

  it('writes plain commands: no version pinned, no environment prefix, no cache flag', () => {
    const toolchains = [
      ['pnpm-lock.yaml'],
      ['package-lock.json'],
      ['yarn.lock'],
      ['bun.lock'],
      ['go.mod'],
    ].map(guessToolchain);
    for (const { install, test } of toolchains) {
      expect(`${install}\n${test}`).not.toMatch(/^\w+=|\/tmp|--store-dir|--cache-folder/m);
    }
    expect(guessToolchain(['pnpm-lock.yaml']).test).toBe('pnpm test');
  });
});

const MISSING: RepoFile = { _tag: 'Missing' };

describe('setupPlan', () => {
  const pnpmToolchain = guessToolchain(['pnpm-lock.yaml']);

  it('creates the three setup files, and an AGENTS.md pointing at the doc when there is none', () => {
    const { files } = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: MISSING,
      agentInstructions: [],
    });
    expect(files.map(({ path, action }) => [path, action])).toEqual([
      ['.gitlab/duo/agent-config.yml', 'create'],
      ['.codetinder/config.json', 'create'],
      ['.codetinder/principles.md', 'create'],
      ['AGENTS.md', 'create'],
    ]);
    const agents = files.find(({ path }) => path === 'AGENTS.md');
    expect(agents?.content).toBe(`# Instructions for coding agents\n\n${pointerSection()}`);
  });

  it('appends the pointer to each agent instruction file the repo has, keeping its text', () => {
    const { files } = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: MISSING,
      agentInstructions: [
        { path: 'CLAUDE.md', file: { _tag: 'Text', content: '# Claude\n\nUse tabs.\n' } },
        { path: '.github/copilot-instructions.md', file: { _tag: 'Text', content: 'Be brief.' } },
      ],
    });
    const pointer = pointerSection();
    expect(files.slice(3)).toEqual([
      {
        path: 'CLAUDE.md',
        action: 'update',
        content: `# Claude\n\nUse tabs.\n\n${pointer}`,
        added: pointer,
        summary: 'adds a section',
      },
      {
        path: '.github/copilot-instructions.md',
        action: 'update',
        content: `Be brief.\n\n${pointer}`,
        added: pointer,
        summary: 'adds a section',
      },
    ]);
  });

  it('adds no second pointer to a file that has one, so Finish setup can run again', () => {
    const { files } = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: MISSING,
      agentInstructions: [
        { path: 'AGENTS.md', file: { _tag: 'Text', content: `# Agents\n\n${pointerSection()}` } },
        { path: 'GEMINI.md', file: { _tag: 'Text', content: '# Gemini\n' } },
      ],
    });
    expect(files.slice(3).map(({ path }) => path)).toEqual(['GEMINI.md']);
  });

  it('leaves a file that is not UTF-8 text, saying why, and creates no AGENTS.md beside it', () => {
    const { files, untouched } = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: MISSING,
      agentInstructions: [{ path: 'CLAUDE.md', file: { _tag: 'NotUtf8' } }],
    });
    expect(files.map(({ path }) => path)).toEqual([
      '.gitlab/duo/agent-config.yml',
      '.codetinder/config.json',
      '.codetinder/principles.md',
    ]);
    expect(untouched).toEqual([
      {
        path: 'CLAUDE.md',
        reason: "it isn't UTF-8 text, so changing it could garble it",
        advice: 'Point your agents at `.codetinder/principles.md` there yourself.',
      },
    ]);
    expect(setupMergeRequestDescription({ files, untouched, notices: [] })).toContain(
      "- `CLAUDE.md`: not updated, as it isn't UTF-8 text, so changing it could garble it. Point your agents at `.codetinder/principles.md` there yourself.",
    );
  });

  it("merges CodeTinder's settings into the project's agent config, showing what it adds", () => {
    const { files, notices } = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: {
        _tag: 'Text',
        content: '# Ours\nnetwork_policy:\n  allowed_domains:\n    - codetinder.dev\n',
      },
      agentInstructions: [],
    });
    const config = files[0];
    expect(config).toMatchObject({
      path: '.gitlab/duo/agent-config.yml',
      action: 'update',
      summary: 'adds settings',
    });
    expect(config?.content).toMatch(/^# Ours\n/);
    expect(config?.action === 'update' && config.added).toContain('registry.npmjs.org');
    expect(config?.action === 'update' && config.added).not.toContain('- codetinder.dev');
    expect(notices).toEqual([]);
  });

  it('warns about a custom image, leaving out the libatomic line', () => {
    const plan = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: { _tag: 'Text', content: 'image: node:24\n' },
      agentInstructions: [],
    });
    expect(plan.files[0]?.content).not.toContain('libatomic');
    expect(plan.notices).toEqual([
      "Your agent config runs flows on its own image, `node:24`. Without `srt` in it, Duo runs commands unsandboxed and ignores `network_policy`; without `microdnf`, the default image's `setup_script` lines can't run, so CodeTinder left those out.",
    ]);
    expect(setupMergeRequestDescription(plan)).toContain(
      '⚠️ Your agent config runs flows on its own image',
    );
  });

  it("leaves an agent config it can't merge into, with what to add by hand", () => {
    const plan = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: { _tag: 'Text', content: 'network_policy: [' },
      agentInstructions: [],
    });
    expect(plan.files.map(({ path }) => path)).not.toContain('.gitlab/duo/agent-config.yml');
    expect(plan.untouched[0]).toMatchObject({
      path: '.gitlab/duo/agent-config.yml',
      reason: "it isn't valid YAML",
    });
    expect(setupMergeRequestDescription(plan)).toContain(
      "- `.gitlab/duo/agent-config.yml`: not updated, as it isn't valid YAML. Add CodeTinder's settings to it yourself:",
    );
    const notUtf8 = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: { _tag: 'NotUtf8' },
      agentInstructions: [],
    });
    expect(notUtf8.untouched[0]?.reason).toBe(
      "it isn't UTF-8 text, so changing it could garble it",
    );
  });

  it('adds nothing to an agent config that already has it all', () => {
    const first = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: MISSING,
      agentInstructions: [],
    });
    const content = first.files[0]?.content ?? '';
    const again = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: { _tag: 'Text', content },
      agentInstructions: [],
    });
    expect(again.files.map(({ path }) => path)).not.toContain('.gitlab/duo/agent-config.yml');
    expect(again.untouched).toEqual([]);
  });

  it('formats .gitlab/duo/agent-config.yml with allowed domains, id_tokens and the libatomic setup_script', () => {
    const { files } = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: MISSING,
      agentInstructions: [],
    });
    const agentConfig = files.find(f => f.path === '.gitlab/duo/agent-config.yml')?.content;
    expect(agentConfig).toBe(`id_tokens:
  CODETINDER_ID_TOKEN:
    aud: https://codetinder.dev
setup_script:
  # Node 25 and later link libatomic, which Duo's default image lacks. Projects move
  # Node versions later, so it is installed whatever the repo pins today.
  - microdnf install -y libatomic
network_policy:
  allowed_domains:
    - registry.npmjs.org
    - codetinder.dev
`);
  });

  it('formats .codetinder/config.json matching ProjectConfigSchema with 2 spaces', () => {
    const { files } = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: MISSING,
      agentInstructions: [],
    });
    const configContent = files.find(f => f.path === '.codetinder/config.json')?.content;
    expect(configContent).toBeDefined();

    const decoded = Schema.decodeSync(Schema.fromJsonString(ProjectConfigSchema))(
      configContent ?? '',
    );
    expect(decoded).toEqual({
      version: 1,
      ...PNPM_COMMANDS,
      proposal: 'merge-request',
      tone: 'mischievous',
    });
  });

  it('formats .codetinder/principles.md as an empty principles doc in the current format, with the project swipes link', () => {
    const { files } = setupPlan({
      toolchain: pnpmToolchain,
      agentConfig: MISSING,
      agentInstructions: [],
    });
    const principlesDoc = files.find(f => f.path === '.codetinder/principles.md')?.content;
    expect(principlesDoc).toBeDefined();
    expect(principlesDoc).toContain("Learned from this project's swipes on https://codetinder.dev");
    const parsed = parsePrinciplesDoc(principlesDoc ?? '');
    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed)) {
      expect(parsed.success).toEqual([]);
    }
  });
});

describe('setupMergeRequestDescription', () => {
  it('returns non-empty description containing key setup information', () => {
    const description = setupMergeRequestDescription(
      setupPlan({
        toolchain: guessToolchain([]),
        agentConfig: MISSING,
        agentInstructions: [{ path: 'CLAUDE.md', file: { _tag: 'Text', content: '# Claude\n' } }],
      }),
    );
    expect(description).toContain('.gitlab/duo/agent-config.yml');
    expect(description).toContain('.codetinder/config.json');
    expect(description).toContain('.codetinder/principles.md');
    expect(description).toContain(
      '- `CLAUDE.md`: adds a short section telling your coding agents to follow the principles doc, ahead of any other style guide here.',
    );
    // The pointer is in the MR itself, so the description no longer asks for one.
    expect(description).not.toContain('link the principles doc');
  });

  it('says what a round is: small changes to one function, swiped on by preference', () => {
    const description = setupMergeRequestDescription(
      setupPlan({ toolchain: guessToolchain([]), agentConfig: MISSING, agentInstructions: [] }),
    );
    expect(description).toContain(
      'Once merged, CodeTinder will pick a function on each new merge request, try small changes on it, and ask you to swipe on the ones you prefer!',
    );
    expect(description).toContain('your package registry to run tests on every card');
    expect(description).not.toContain('variant');
  });

  it('says it creates AGENTS.md when the repo has no agent instruction file', () => {
    const description = setupMergeRequestDescription(
      setupPlan({ toolchain: guessToolchain([]), agentConfig: MISSING, agentInstructions: [] }),
    );
    expect(description).toContain('- `AGENTS.md`: created with a short section');
  });
});
