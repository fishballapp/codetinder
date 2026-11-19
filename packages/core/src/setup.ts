import * as Schema from 'effect/Schema';
import {
  AGENT_CONFIG_PATH,
  type AgentConfigNeeds,
  mergeAgentConfig,
  renderAgentConfigAdditions,
} from './agent-config';
import { newAgentsFile, pointerSection, withPointer } from './agent-instructions';
import { PRINCIPLES_PATH, renderPrinciplesDoc } from './principles';
import { PROJECT_CONFIG_PATH, type ProjectConfig, ProjectConfigSchema } from './project-config';

export type Toolchain = {
  readonly install: string;
  readonly test: string;
  readonly allowedDomains: readonly string[];
};

type ToolchainCandidate = {
  readonly files: readonly string[];
  readonly toolchain: Toolchain;
};

// The commands are plain: the versions the repo pins are read when they run (see toolchain-pins),
// and the home they cache under is made by the flow (flow-steps `runShell`), so no command carries
// an environment prefix or a cache flag.
// ponytail: Yarn 2+ (needs corepack), Bun, Python and Go are guesses for Duo's default image
// (writable only in the checkout and /tmp, no corepack), which the setup MR asks the developer to check.
const TOOLCHAIN_CANDIDATES: readonly ToolchainCandidate[] = [
  {
    files: ['pnpm-lock.yaml'],
    toolchain: {
      install: 'pnpm install --frozen-lockfile',
      test: 'pnpm test',
      allowedDomains: ['registry.npmjs.org'],
    },
  },
  {
    files: ['package-lock.json'],
    toolchain: {
      install: 'npm ci',
      test: 'npm test',
      allowedDomains: ['registry.npmjs.org'],
    },
  },
  {
    files: ['yarn.lock'],
    toolchain: {
      install: 'yarn install --frozen-lockfile',
      test: 'yarn test',
      allowedDomains: ['registry.yarnpkg.com', 'repo.yarnpkg.com', 'registry.npmjs.org'],
    },
  },
  {
    files: ['bun.lock', 'bun.lockb'],
    toolchain: {
      install: 'npx --yes bun install --frozen-lockfile',
      test: 'npx --yes bun test',
      allowedDomains: ['registry.npmjs.org'],
    },
  },
  {
    files: ['requirements.txt'],
    toolchain: {
      install: 'python3 -m venv /tmp/.venv && /tmp/.venv/bin/pip install -r requirements.txt',
      test: '/tmp/.venv/bin/python -m pytest',
      allowedDomains: ['pypi.org', 'files.pythonhosted.org'],
    },
  },
  {
    files: ['go.mod'],
    toolchain: {
      install: 'go mod download',
      test: 'go test ./...',
      allowedDomains: ['proxy.golang.org', 'sum.golang.org', 'storage.googleapis.com'],
    },
  },
];

const FALLBACK_TOOLCHAIN: Toolchain = {
  install: 'echo "Set install in .codetinder/config.json" && exit 1',
  test: 'echo "Set test in .codetinder/config.json" && exit 1',
  allowedDomains: [],
};

/** Guesses the project's toolchain from the root's file names: the first lockfile that matches wins. */
export const guessToolchain = (fileNames: ReadonlyArray<string>): Toolchain => {
  const fileSet = new Set(fileNames);
  const candidate = TOOLCHAIN_CANDIDATES.find(({ files }) => files.some(file => fileSet.has(file)));
  return candidate?.toolchain ?? FALLBACK_TOOLCHAIN;
};

/** What CodeTinder needs in the project's agent config, for its `toolchain`. */
const agentConfigNeeds = (toolchain: Toolchain): AgentConfigNeeds => ({
  allowedDomains: [...toolchain.allowedDomains, 'codetinder.dev'],
  setupScript: [
    {
      command: 'microdnf install -y libatomic',
      why: "Node 25 and later link libatomic, which Duo's default image lacks. Projects move\nNode versions later, so it is installed whatever the repo pins today.",
      isForDefaultImage: true,
    },
  ],
});

const renderProjectConfig = (toolchain: Toolchain): string => {
  const config: ProjectConfig = {
    version: 1,
    install: toolchain.install,
    test: toolchain.test,
    proposal: 'merge-request',
    tone: 'mischievous',
  };
  return `${Schema.encodeSync(Schema.fromJsonString(ProjectConfigSchema, { space: 2 }))(config)}\n`;
};

export type SetupFile =
  | {
      readonly path: string;
      readonly action: 'create';
      /** The whole new file. */
      readonly content: string;
    }
  | {
      readonly path: string;
      readonly action: 'update';
      /** The whole file once the MR is merged. */
      readonly content: string;
      /** What the MR adds to it, for a person to read: the section, the settings. */
      readonly added: string;
      /** The addition in a word or two: "adds a section". */
      readonly summary: string;
    };

/** A file as the default branch has it: missing, its text, or not UTF-8 text. */
export type RepoFile =
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'Text'; readonly content: string }
  | { readonly _tag: 'NotUtf8' };

/** An agent instruction file the default branch has. */
export type AgentInstructionFile = {
  readonly path: string;
  readonly file: Exclude<RepoFile, { _tag: 'Missing' }>;
};

/**
 * What the setup merge request does: the files it adds or updates, those it leaves (with why, and
 * what to do by hand), and what the developer should know about the result.
 */
export type SetupPlan = {
  readonly files: readonly SetupFile[];
  readonly untouched: readonly {
    readonly path: string;
    readonly reason: string;
    readonly advice: string;
  }[];
  readonly notices: readonly string[];
};

const NOT_UTF8 = "it isn't UTF-8 text, so changing it could garble it";

/** The agent config's part of the plan: created, merged into, or left with why. */
const agentConfigPlan = (agentConfig: RepoFile, needs: AgentConfigNeeds): SetupPlan => {
  const advice = `Add CodeTinder's settings to it yourself:\n\n\`\`\`yaml\n${renderAgentConfigAdditions(
    {
      isIdTokenAdded: true,
      allowedDomains: needs.allowedDomains,
      setupScript: needs.setupScript,
    },
  )}\`\`\``;
  if (agentConfig._tag === 'NotUtf8') {
    return {
      files: [],
      untouched: [{ path: AGENT_CONFIG_PATH, reason: NOT_UTF8, advice }],
      notices: [],
    };
  }
  const merge = mergeAgentConfig(
    agentConfig._tag === 'Text' ? agentConfig.content : undefined,
    needs,
  );
  if (merge._tag === 'Conflict') {
    return {
      files: [],
      untouched: [{ path: AGENT_CONFIG_PATH, reason: merge.reason, advice }],
      notices: [],
    };
  }
  const notices =
    merge.customImage === undefined
      ? []
      : [
          `Your agent config runs flows on its own image, \`${merge.customImage}\`. Without \`srt\` in it, Duo runs commands unsandboxed and ignores \`network_policy\`; without \`microdnf\`, the default image's \`setup_script\` lines can't run, so CodeTinder left those out.`,
        ];
  if (merge._tag === 'Unchanged') return { files: [], untouched: [], notices };
  const file: SetupFile =
    agentConfig._tag === 'Missing'
      ? { path: AGENT_CONFIG_PATH, action: 'create', content: merge.content }
      : {
          path: AGENT_CONFIG_PATH,
          action: 'update',
          content: merge.content,
          added: renderAgentConfigAdditions(merge.added),
          summary: 'adds settings',
        };
  return { files: [file], untouched: [], notices };
};

/**
 * The setup merge request: `.codetinder/config.json`, an empty principles doc, CodeTinder's
 * settings merged into `agentConfig` (the project's `.gitlab/duo/agent-config.yml`, or a new one),
 * and the pointer section in each of `agentInstructions` (the agent instruction files the repo has)
 * that lacks one, or a new `AGENTS.md` when there are none. Every existing file is as the default
 * branch has it; one that isn't UTF-8 text, or an agent config CodeTinder can't merge into, is left
 * as it is, with why. Planned again, a set-up project adds nothing.
 */
export const setupPlan = ({
  toolchain,
  agentConfig,
  agentInstructions,
}: {
  toolchain: Toolchain;
  agentConfig: RepoFile;
  agentInstructions: readonly AgentInstructionFile[];
}): SetupPlan => {
  const created = (path: string, content: string): SetupFile => ({
    path,
    action: 'create',
    content,
  });
  const config = agentConfigPlan(agentConfig, agentConfigNeeds(toolchain));
  const pointers =
    agentInstructions.length === 0
      ? [created('AGENTS.md', newAgentsFile())]
      : agentInstructions.flatMap(({ path, file }): SetupFile[] => {
          if (file._tag === 'NotUtf8') return [];
          const updated = withPointer(file.content);
          if (updated === undefined) return [];
          return [
            {
              path,
              action: 'update',
              content: updated,
              added: pointerSection(),
              summary: 'adds a section',
            },
          ];
        });
  return {
    files: [
      ...config.files,
      created(PROJECT_CONFIG_PATH, renderProjectConfig(toolchain)),
      created(PRINCIPLES_PATH, renderPrinciplesDoc([])),
      ...pointers,
    ],
    untouched: [
      ...config.untouched,
      ...agentInstructions.flatMap(({ path, file }) =>
        file._tag === 'NotUtf8'
          ? [
              {
                path,
                reason: NOT_UTF8,
                advice: `Point your agents at \`${PRINCIPLES_PATH}\` there yourself.`,
              },
            ]
          : [],
      ),
    ],
    notices: config.notices,
  };
};

const FILE_PURPOSE: Readonly<Record<string, string>> = {
  [AGENT_CONFIG_PATH]:
    'grants the Duo flow access to `codetinder.dev` and your package registry to run tests on every card, and installs `libatomic`, which newer Node versions need',
  [PROJECT_CONFIG_PATH]:
    'project settings (how to install dependencies, run tests, and deliver style proposals). Every field here is a guess based on your repository — check and correct them in this MR',
  [PRINCIPLES_PATH]:
    'your coding principles document, where learned style preferences are recorded after you swipe',
};

const POINTER_PURPOSE =
  'a short section telling your coding agents to follow the principles doc, ahead of any other style guide here';

const fileLine = (file: SetupFile): string => {
  const purpose = FILE_PURPOSE[file.path];
  if (purpose === undefined) {
    return `- \`${file.path}\`: ${file.action === 'create' ? 'created with' : 'adds'} ${POINTER_PURPOSE}.`;
  }
  if (file.action === 'create') return `- \`${file.path}\`: ${purpose}.`;
  return `- \`${file.path}\`: adds CodeTinder's settings to yours, keeping everything else:\n\n  \`\`\`yaml\n${file.added.trimEnd().replaceAll(/^/gm, '  ')}\n  \`\`\``;
};

/** The merge request description for adding CodeTinder to a project as `plan` says. */
export const setupMergeRequestDescription = ({ files, untouched, notices }: SetupPlan): string =>
  `💘 **Ready to teach your agents some taste?**

Merging this merge request is the whole install. Here is what it adds:

${[
  ...files.map(fileLine),
  ...untouched.map(
    ({ path, reason, advice }) => `- \`${path}\`: not updated, as ${reason}. ${advice}`,
  ),
].join('\n')}
${notices.map(notice => `\n⚠️ ${notice}\n`).join('')}
CodeTinder runs \`test\` in a locked-down sandbox: no CI/CD variables or secrets, no services, and only the hosts in \`agent-config.yml\`. Point it at fast, self-contained tests. The first merge request will say if something's off.

Once merged, CodeTinder will pick a function on each new merge request, try small changes on it, and ask you to swipe on the ones you prefer!
`;
