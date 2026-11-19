import { GitLabMergeRequests, GitLabSweeps } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Stdio from 'effect/Stdio';
import * as TestConsole from 'effect/testing/TestConsole';
import { CLAIM_FILE } from './claim';
import { memoryFileSystem } from './memory-file-system';
import { projectConfigFile } from './project-config-fixture';
import { runRoute } from './route';
import { scriptedFetch, withScriptedFetch } from './scripted-fetch';
import { scriptedSpawner } from './scripted-spawner';
import { SESSION_LOG_FILE } from './session-log';
import { ID_TOKEN, MERGE_REQUEST_CONTEXT, triggerContext } from './trigger-context-fixture';

const PROJECT_ID = '87434709';
const FORK_PROJECT_ID = 99;
const MERGE_REQUEST_PATH = `/api/v4/projects/${PROJECT_ID}/merge_requests/7`;
const NOTES_PATH = `${MERGE_REQUEST_PATH}/notes`;
const HEAD_SHA = 'c0ffee'.padEnd(40, '0');
const SERVICE_ACCOUNT = 'ai-codetinder-acme';
const ROUND_ID = '0123456789AB';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const escapeLikeGitLab = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const mentionGoal = (body: string, context = 'MergeRequest IID: 7') =>
  [
    'Input: <!-- All non-system discussion messages through the triggering message are included. -->',
    `<message id="1" author="dev">${escapeLikeGitLab(body)}</message>`,
    `Context: {${context}}`,
  ].join('\n');

const LEARN_GOAL = mentionGoal(`@${SERVICE_ACCOUNT} learn r1`);
const ROUND_GOAL = mentionGoal(`@${SERVICE_ACCOUNT} round`);
// The note `mentionGoal`'s message is.
const MENTION_NOTE_ID = 1;

/** The MR's notes when CodeTinder's review was requested twice, newest first. */
const REVIEW_REQUESTED = [
  { id: 40, system: false, body: 'Looks good' },
  { id: 31, system: true, body: `requested review from @${SERVICE_ACCOUNT}` },
  { id: 30, system: true, body: `requested review from @dev and @${SERVICE_ACCOUNT}` },
];

/** The context of a pipeline run on `branch`, whose open MR, if any, `url` links. */
const pipelineContext = (url: string, branch = 'feat/x') =>
  triggerContext('pipeline_hooks', {
    pipeline: { source_branch: branch, source: 'push' },
    merge_request: { url, author_id: '1' },
    agent_platform_standard_context: { primary_branch: 'main' },
  });
const PIPELINE_GOAL = JSON.stringify({ object_attributes: { ref: 'feat/x', sha: HEAD_SHA } });

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * Runs the route on merge request 7 and returns what it printed and what it asked of GitLab and
 * codetinder.dev: the notes it posted, the claims it made and gave up, the reviews it finished.
 */
const runRouteOn = (args: {
  readonly goal: string;
  readonly context?: string;
  readonly sourceProjectId?: number | null;
  readonly mergeRequest?: {
    readonly draft?: boolean;
    readonly state?: string;
    readonly source_branch?: string;
  };
  /** What codetinder.dev answers the claim. */
  readonly claim?: object;
  /** The MR's notes, newest first, as GitLab lists them. */
  readonly notes?: readonly {
    readonly id: number;
    readonly system: boolean;
    readonly body: string;
  }[];
  /** The MR's reviewers and their states. */
  readonly reviewers?: readonly { readonly username: string; readonly state: string }[];
  readonly hasIdToken?: boolean;
  /** Whether codetinder.dev refuses the learn run's report. */
  readonly isReportRefused?: boolean;
  readonly files?: Record<string, string>;
  /** What git says the merge request changes; `undefined` is a git that fails. */
  readonly changed?: readonly string[] | undefined;
}) => {
  const notes: { readonly path: string; readonly body: string }[] = [];
  const claims: unknown[] = [];
  const ended: unknown[] = [];
  const finished: unknown[] = [];
  const reports: unknown[] = [];
  const answer = (body: unknown, status = 200) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: JSON_HEADERS });
  const fetch = scriptedFetch(async request => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.host}${url.pathname}`;
    switch (route) {
      case 'POST codetinder.dev/api/claims':
        claims.push(await request.json());
        return answer(args.claim ?? { _tag: 'Claimed' });
      case 'POST codetinder.dev/api/claims/end':
        ended.push(await request.json());
        return answer(null, 204);
      case `POST codetinder.dev/api/rounds/${ROUND_ID}/learn`:
        reports.push(await request.json());
        return args.isReportRefused
          ? answer({ _tag: 'Forbidden', message: 'not your round' }, 403)
          : answer(null, 204);
      case `GET gitlab.com${MERGE_REQUEST_PATH}`:
        return answer({
          source_branch: 'feat/x',
          target_branch: 'main',
          web_url: 'https://gitlab.com/group/demo/-/merge_requests/7',
          draft: false,
          state: 'opened',
          source_project_id:
            args.sourceProjectId === undefined ? Number(PROJECT_ID) : args.sourceProjectId,
          target_project_id: Number(PROJECT_ID),
          ...args.mergeRequest,
        });
      case `GET gitlab.com${NOTES_PATH}`:
        return answer(args.notes ?? []);
      case `POST gitlab.com${NOTES_PATH}`: {
        const { body } = (await request.json()) as { body: string };
        notes.push({ path: url.pathname, body });
        return answer({ id: 1, author: { username: SERVICE_ACCOUNT } }, 201);
      }
      case `GET gitlab.com${MERGE_REQUEST_PATH}/reviewers`:
        return answer(
          (args.reviewers ?? []).map(({ username, state }) => ({
            user: { id: 1, username },
            state,
          })),
        );
      case `POST gitlab.com${MERGE_REQUEST_PATH}/draft_notes/bulk_publish`:
        finished.push(await request.json());
        return answer(null, 204);
      default:
        throw new Error(`unexpected request: ${route}`);
    }
  });
  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DUO_WORKFLOW_GOAL: args.goal,
      DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT: args.context ?? MERGE_REQUEST_CONTEXT,
      DUO_WORKFLOW_PROJECT_ID: PROJECT_ID,
      GITLAB_TOKEN: 'test-gitlab-token',
      ...(args.hasIdToken === false ? {} : { CODETINDER_ID_TOKEN: ID_TOKEN }),
    }),
  );
  const changed = 'changed' in args ? args.changed : ['src/f.ts'];
  const spawner = scriptedSpawner({
    'git rev-parse HEAD': { exitCode: 0, stdout: `${HEAD_SHA}\n` },
    'git diff --name-only -z origin/main...HEAD':
      changed === undefined
        ? { exitCode: 128 }
        : { exitCode: 0, stdout: changed.map(file => `${file}\0`).join('') },
  });
  const fs = memoryFileSystem(args.files ?? projectConfigFile());
  const env = Layer.mergeAll(
    TestConsole.layer,
    spawner.layer,
    Stdio.layerTest({}),
    fs.layer,
    Path.layer,
    config,
    withScriptedFetch(fetch),
    Layer.mergeAll(GitLabMergeRequests.layer, GitLabSweeps.layer).pipe(
      Layer.provide(withScriptedFetch(fetch)),
      Layer.provide(config),
    ),
  );
  return Effect.gen(function* () {
    yield* runRoute();
    const claimFile = fs.read(CLAIM_FILE);
    return {
      printed: yield* TestConsole.logLines,
      notes,
      claims,
      ended,
      finished,
      reports,
      runClaim: claimFile === undefined ? undefined : JSON.parse(claimFile),
      sessionLog: fs.read(SESSION_LOG_FILE),
    };
  }).pipe(Effect.provide(env));
};

describe('runRoute', () => {
  const roundEvents = ['merge_request', 'merge_request_ready', 'assign_reviewer'] as const;
  it.effect.each(roundEvents)('claims the checked-out commit and starts a round on %s', event =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({ goal: '7', context: triggerContext(event) });
      expect(result).toMatchObject({
        printed: ['generate'],
        notes: [],
        claims: [
          { mergeRequestIid: 7, headSha: HEAD_SHA, runId: expect.stringMatching(UUID), event },
        ],
      });
    }),
  );

  it.effect('logs the round it starts for the session page', () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({ goal: '7' });
      expect(result.sessionLog).toBe(
        `- Started a round for !7 at commit ${HEAD_SHA.slice(0, 8)}.\n`,
      );
    }),
  );

  it.effect("writes the run's claim down for the round step, with the run id it sent", () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({ goal: '7' });
      expect(result.runClaim).toEqual({ headSha: HEAD_SHA, runId: expect.stringMatching(UUID) });
      expect(result.claims).toEqual([expect.objectContaining({ runId: result.runClaim.runId })]);
    }),
  );

  it.effect("starts a round on a push to an MR's branch, on the MR the context links", () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({
        goal: PIPELINE_GOAL,
        context: pipelineContext('https://gitlab.com/group/demo/-/merge_requests/7'),
        mergeRequest: { draft: true },
      });
      expect(result).toMatchObject({
        printed: ['generate'],
        claims: [
          {
            mergeRequestIid: 7,
            headSha: HEAD_SHA,
            runId: expect.stringMatching(UUID),
            event: 'pipeline_hooks',
          },
        ],
      });
    }),
  );

  it.effect('ends a push to a branch with no MR at once, asking no one', () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({ goal: PIPELINE_GOAL, context: pipelineContext('') });
      expect(result).toEqual({
        printed: ['nomergerequest'],
        notes: [],
        claims: [],
        ended: [],
        finished: [],
        reports: [],
        sessionLog: '- Skipped: this pipeline is on a branch with no merge request.\n',
      });
    }),
  );

  const silentCases: [
    name: string,
    word: string,
    args: Partial<Parameters<typeof runRouteOn>[0]>,
  ][] = [
    ['an MR opened as a draft', 'draft', { mergeRequest: { draft: true } }],
    [
      "CodeTinder's own setup MR",
      'codetinder',
      { mergeRequest: { source_branch: 'codetinder/setup' } },
    ],
    [
      'a learn proposal pushed to',
      'codetinder',
      {
        goal: PIPELINE_GOAL,
        context: pipelineContext(
          'https://gitlab.com/g/p/-/merge_requests/7',
          'codetinder/learn-r1-1',
        ),
        mergeRequest: { source_branch: 'codetinder/learn-r1-1' },
      },
    ],
    ['a merged MR', 'closed', { mergeRequest: { state: 'merged' } }],
    [
      "another branch's MR",
      'otherbranch',
      {
        goal: PIPELINE_GOAL,
        context: pipelineContext('https://gitlab.com/g/p/-/merge_requests/7', 'feat/y'),
      },
    ],
  ];
  it.effect.each(silentCases)('ends %s silently, before claiming', ([, word, args]) =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({ goal: '7', ...args });
      expect(result).toMatchObject({
        printed: [word],
        notes: [],
        claims: [],
        sessionLog: expect.stringMatching(/^- Skipped: !7 .+\.\n$/),
      });
    }),
  );

  it.effect('runs on a draft when a reviewer asks', () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({
        goal: '7',
        context: triggerContext('assign_reviewer'),
        mergeRequest: { draft: true },
      });
      expect(result.printed).toEqual(['generate']);
    }),
  );

  const lostCases: [answer: object, word: string][] = [
    [{ _tag: 'Busy' }, 'busy'],
    [{ _tag: 'Tried' }, 'tried'],
    [{ _tag: 'HasRound', roundId: ROUND_ID }, 'hasround'],
  ];
  const lostRuns: [name: string, goal: string, context: string][] = [
    ['an automatic run', '7', MERGE_REQUEST_CONTEXT],
    ["a reviewer's request", '7', triggerContext('assign_reviewer')],
    ['a round mention', ROUND_GOAL, triggerContext('mention')],
  ];
  it.effect.each(lostCases.flatMap(lost => lostRuns.map(run => [...lost, ...run] as const)))(
    'ends silently when the claim answers %o, on %s',
    ([claim, word, , goal, context]) =>
      Effect.gen(function* () {
        const result = yield* runRouteOn({
          goal,
          context,
          claim,
          reviewers: [{ username: SERVICE_ACCOUNT, state: 'unreviewed' }],
        });
        expect(result).toMatchObject({ printed: [word], notes: [], ended: [], finished: [] });
      }),
  );

  it.effect('claims the checked-out commit and starts a round on a round mention, on a draft', () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({
        goal: ROUND_GOAL,
        context: triggerContext('mention'),
        mergeRequest: { draft: true },
      });
      expect(result).toMatchObject({
        printed: ['generate'],
        notes: [],
        claims: [
          { mergeRequestIid: 7, headSha: HEAD_SHA, event: 'mention', askNoteId: MENTION_NOTE_ID },
        ],
      });
    }),
  );

  it.effect("names the MR's latest request for CodeTinder's review as the ask, on any event", () =>
    Effect.gen(function* () {
      for (const [event, goal] of [
        ['assign_reviewer', '7'],
        ['merge_request', '7'],
        ['pipeline_hooks', PIPELINE_GOAL],
      ] as const) {
        const result = yield* runRouteOn({
          goal,
          context:
            event === 'pipeline_hooks'
              ? pipelineContext('https://gitlab.com/g/p/-/merge_requests/7')
              : triggerContext(event),
          notes: REVIEW_REQUESTED,
        });
        expect(result.claims).toEqual([expect.objectContaining({ event, askNoteId: 31 })]);
      }
      const unrequested = yield* runRouteOn({
        goal: '7',
        context: triggerContext('assign_reviewer'),
      });
      expect(unrequested.claims).toEqual([
        expect.not.objectContaining({ askNoteId: expect.anything() }),
      ]);
    }),
  );

  it.effect("notes on the run's claim the round its round replaces", () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({
        goal: ROUND_GOAL,
        context: triggerContext('mention'),
        claim: { _tag: 'Claimed', replacedRoundId: ROUND_ID },
      });
      expect(result.printed).toEqual(['generate']);
      expect(result.runClaim).toEqual({
        headSha: HEAD_SHA,
        runId: expect.stringMatching(UUID),
        replacedRoundId: ROUND_ID,
      });
    }),
  );

  it.effect('says why in a note when the project gives the flow no ID token', () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({ goal: '7', hasIdToken: false });
      expect(result).toMatchObject({
        printed: ['skipped'],
        notes: [{ path: NOTES_PATH, body: expect.stringContaining('CODETINDER_ID_TOKEN') }],
        claims: [],
      });
    }),
  );

  it.effect('prints learn for a mention, claiming nothing', () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({ goal: LEARN_GOAL, context: '', changed: ['README.md'] });
      expect(result).toMatchObject({ printed: ['learn'], notes: [], claims: [], reports: [] });
    }),
  );

  it.effect('reports the learn run started, for the reply that asked', () =>
    Effect.gen(function* () {
      const goal = mentionGoal(`@${SERVICE_ACCOUNT} learn ${ROUND_ID}`);
      const result = yield* runRouteOn({ goal, context: '' });
      expect(result).toMatchObject({
        printed: ['learn'],
        reports: [{ noteId: 1, report: 'Started' }],
      });
    }),
  );

  it.effect('still learns when codetinder.dev refuses the report', () =>
    Effect.gen(function* () {
      const goal = mentionGoal(`@${SERVICE_ACCOUNT} learn ${ROUND_ID}`);
      const result = yield* runRouteOn({ goal, context: '', isReportRefused: true });
      expect(result).toMatchObject({ printed: ['learn'], reports: [{ noteId: 1 }] });
    }),
  );

  const forkCases: [goal: string, sourceProjectId: number | null][] = [
    ['7', FORK_PROJECT_ID],
    [LEARN_GOAL, FORK_PROJECT_ID],
    ['7', null],
  ];
  it.effect.each(forkCases)(
    'prints fork and posts one note on a merge request from a fork: %s',
    ([goal, sourceProjectId]) =>
      Effect.gen(function* () {
        const result = yield* runRouteOn({ goal, sourceProjectId, changed: ['README.md'] });
        expect(result).toMatchObject({
          printed: ['fork'],
          notes: [{ path: NOTES_PATH, body: expect.stringContaining("a fork's code") }],
          claims: [],
        });
      }),
  );

  it.effect('prints nocode, posts one note and gives up the claim when a round has no code', () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({
        goal: '7',
        changed: ['README.md', 'docs/a.png', 'pnpm-lock.yaml', 'notes.txt'],
      });
      expect(result).toMatchObject({
        printed: ['nocode'],
        notes: [
          {
            path: NOTES_PATH,
            body: expect.stringContaining(
              'changes no code, only `README.md`, `docs/a.png`, `pnpm-lock.yaml`, and 1 more',
            ),
          },
        ],
        ended: [{ mergeRequestIid: 7, headSha: HEAD_SHA, runId: expect.stringMatching(UUID) }],
        sessionLog: '- Skipped: !7 changes no code. Posted a comment saying so.\n',
      });
    }),
  );

  it.effect("finishes a reviewer's review with the nocode note", () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({
        goal: '7',
        context: triggerContext('assign_reviewer'),
        changed: ['README.md'],
        reviewers: [{ username: SERVICE_ACCOUNT, state: 'unreviewed' }],
      });
      expect(result).toMatchObject({
        printed: ['nocode'],
        finished: [{ reviewer_state: 'reviewed' }],
      });
    }),
  );

  const generateCases: [name: string, changed: readonly string[] | undefined][] = [
    ['code among docs', ['README.md', 'src/f.ts']],
    ['no changed files', []],
    ['a git that fails', undefined],
  ];
  it.effect.each(generateCases)('still prints generate with %s', ([, changed]) =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({ goal: '7', changed });
      expect(result).toMatchObject({ printed: ['generate'], notes: [], ended: [] });
    }),
  );

  it.effect('words the nocode note in the plain tone', () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({
        goal: '7',
        files: projectConfigFile({ tone: 'plain' }),
        changed: ['README.md'],
      });
      expect(result.notes[0]?.body).toContain('**CodeTinder skipped this merge request**');
    }),
  );

  it.effect('words the fork note in the plain tone', () =>
    Effect.gen(function* () {
      const result = yield* runRouteOn({
        goal: '7',
        sourceProjectId: FORK_PROJECT_ID,
        files: projectConfigFile({ tone: 'plain' }),
      });
      expect(result.notes).toEqual([
        {
          path: NOTES_PATH,
          body: expect.stringContaining('CodeTinder only runs on merge requests from branches'),
        },
      ]);
    }),
  );

  it.effect('fails when the goal is not a route, without asking GitLab', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(runRouteOn({ goal: 'hello' }));
      expect(error).toMatchObject({
        _tag: 'UserError',
        userMessage: expect.stringContaining('goal'),
      });
    }),
  );
});
