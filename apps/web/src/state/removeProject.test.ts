import {
  GitLabCatalog,
  type GitLabProjectSetup,
  GitLabRemoval,
  GitLabSetup,
} from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { removeProject } from './atoms';

const consumer = { id: 'gid://gitlab/Ai::Catalog::ItemConsumer/1', pinnedVersion: '1.2.0' };
const setupMergeRequestUrl = 'https://gitlab.com/g/p/-/merge_requests/3';
const removalMergeRequest = { iid: '4', url: 'https://gitlab.com/g/p/-/merge_requests/4' };

const setup = (overrides: Partial<GitLabProjectSetup>): GitLabProjectSetup => ({
  fullPath: 'g/p',
  consumer: null,
  setupMergeRequestUrl: null,
  removalMergeRequest: null,
  hasConfig: false,
  isMarkedForDeletion: false,
  canEnableFlow: true,
  ...overrides,
});

/** GitLab's services for one project, each step recorded in `calls` as it runs. */
const recordingServices = (calls: string[], project: GitLabProjectSetup) =>
  Layer.mergeAll(
    Layer.succeed(
      GitLabCatalog,
      GitLabCatalog.of({
        setupStatuses: () => Effect.succeed({ latestVersion: '1.2.0', projects: [project] }),
        enable: () => Effect.die(new Error('not used by removal')),
        update: () => Effect.die(new Error('not used by removal')),
        flowTriggers: () => Effect.die(new Error('not used by removal')),
        createTrigger: () => Effect.die(new Error('not used by removal')),
        updateTrigger: () => Effect.die(new Error('not used by removal')),
        deleteTrigger: () => Effect.die(new Error('not used by removal')),
        disable: ({ consumerId }) =>
          Effect.sync(() => {
            calls.push(`disable ${consumerId}`);
          }),
      }),
    ),
    Layer.succeed(
      GitLabRemoval,
      GitLabRemoval.of({
        closeSetupMergeRequest: ({ projectId, defaultBranch }) =>
          Effect.sync(() => {
            calls.push(`close setup MR in ${projectId} from ${defaultBranch}`);
          }),
        deleteSetupBranch: () =>
          Effect.sync(() => {
            calls.push('delete setup branch');
          }),
        openRemovalMergeRequest: ({ defaultBranch, configPath }) =>
          Effect.sync(() => {
            calls.push(`open removal MR from ${defaultBranch} deleting ${configPath}`);
            return removalMergeRequest.url;
          }),
      }),
    ),
    Layer.succeed(
      GitLabSetup,
      GitLabSetup.of({
        defaultBranch: () =>
          Effect.sync(() => {
            calls.push('read default branch');
            return 'main';
          }),
        branchHead: () => Effect.die(new Error('not used by removal')),
        rootFileNames: () => Effect.die(new Error('not used by removal')),
        openSetupMergeRequest: () => Effect.die(new Error('not used by removal')),
      }),
    ),
  );

/** The steps GitLab was asked for, in order, when removing this project. */
const stepsFor = (project: GitLabProjectSetup) =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* removeProject({
      token: Redacted.make('oauth-token'),
      projectId: 87,
      fullPath: project.fullPath,
    }).pipe(Effect.provide(recordingServices(calls, project)));
    return calls;
  });

describe('removeProject', () => {
  it.effect('turns the flow off and opens the removal MR for a Live project', () =>
    Effect.gen(function* () {
      expect(yield* stepsFor(setup({ consumer, hasConfig: true }))).toEqual([
        'read default branch',
        `disable ${consumer.id}`,
        'delete setup branch',
        'open removal MR from main deleting .codetinder/config.json',
      ]);
    }),
  );

  it.effect('turns the flow off and closes the setup MR when the config is not merged yet', () =>
    Effect.gen(function* () {
      expect(yield* stepsFor(setup({ consumer, setupMergeRequestUrl }))).toEqual([
        'read default branch',
        `disable ${consumer.id}`,
        'close setup MR in 87 from main',
        'delete setup branch',
      ]);
    }),
  );

  it.effect('finishes a removal that stopped after the flow was turned off', () =>
    Effect.gen(function* () {
      expect(yield* stepsFor(setup({ hasConfig: true }))).toEqual([
        'read default branch',
        'delete setup branch',
        'open removal MR from main deleting .codetinder/config.json',
      ]);
    }),
  );

  it.effect('deletes the setup branch on a retry whose setup MR was already closed', () =>
    Effect.gen(function* () {
      expect(yield* stepsFor(setup({ hasConfig: true, removalMergeRequest }))).toEqual([
        'read default branch',
        'delete setup branch',
      ]);
    }),
  );

  it.effect('leaves a setup MR open beside a removal MR for the next Remove to close', () =>
    Effect.gen(function* () {
      expect(
        yield* stepsFor(setup({ setupMergeRequestUrl, removalMergeRequest, hasConfig: true })),
      ).toEqual(['read default branch', 'close setup MR in 87 from main', 'delete setup branch']);
    }),
  );
});
