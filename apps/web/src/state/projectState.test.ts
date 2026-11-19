import type { GitLabProjectSetup } from '@codetinder/gitlab';
import { describe, expect, it } from 'vitest';
import { projectState } from './projectState';

const consumer = { id: 'gid://gitlab/Ai::Catalog::ItemConsumer/1', pinnedVersion: '1.1.0' };
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

describe('projectState', () => {
  it('is NotAdded with no flow, no setup MR and no config', () => {
    expect(projectState(setup({}), '1.1.0')).toEqual({ _tag: 'NotAdded' });
  });

  it('is Live, up to date, with the flow on and the config merged', () => {
    expect(projectState(setup({ consumer, hasConfig: true }), '1.1.0')).toEqual({
      _tag: 'Live',
      consumerId: consumer.id,
      version: '1.1.0',
      updateTo: null,
    });
  });

  it('offers the latest version to a Live project pinned to an older one', () => {
    expect(projectState(setup({ consumer, hasConfig: true }), '1.2.0')).toMatchObject({
      _tag: 'Live',
      updateTo: '1.2.0',
    });
  });

  it('offers no update to a Live project with no pin', () => {
    const unpinned = { ...consumer, pinnedVersion: null };
    expect(projectState(setup({ consumer: unpinned, hasConfig: true }), '1.2.0')).toMatchObject({
      _tag: 'Live',
      updateTo: null,
    });
  });

  it('is SetupOpen with the flow on and the setup MR open', () => {
    expect(projectState(setup({ consumer, setupMergeRequestUrl }), '1.1.0')).toEqual({
      _tag: 'SetupOpen',
      setupMergeRequestUrl,
    });
  });

  it('needs the setup MR again when the flow is on but the MR was closed', () => {
    expect(projectState(setup({ consumer }), '1.1.0')).toEqual({
      _tag: 'Unfinished',
      needsFlow: false,
      needsSetupMergeRequest: true,
      setupMergeRequestUrl: null,
    });
  });

  it('needs only the flow when the config is merged but the flow is off', () => {
    expect(projectState(setup({ hasConfig: true }), '1.1.0')).toEqual({
      _tag: 'Unfinished',
      needsFlow: true,
      needsSetupMergeRequest: false,
      setupMergeRequestUrl: null,
    });
  });

  it('needs only the flow when the setup MR is open but the flow is off', () => {
    expect(projectState(setup({ setupMergeRequestUrl }), '1.1.0')).toEqual({
      _tag: 'Unfinished',
      needsFlow: true,
      needsSetupMergeRequest: false,
      setupMergeRequestUrl,
    });
  });

  it('is Removing once the flow is off and the removal MR is open', () => {
    expect(projectState(setup({ hasConfig: true, removalMergeRequest }), '1.1.0')).toEqual({
      _tag: 'Removing',
      removalMergeRequest,
    });
  });

  it('is Unfinished, not Removing, while a setup MR is still open beside the removal MR', () => {
    expect(projectState(setup({ setupMergeRequestUrl, removalMergeRequest }), '1.1.0')).toEqual({
      _tag: 'Unfinished',
      needsFlow: true,
      needsSetupMergeRequest: false,
      setupMergeRequestUrl,
    });
  });

  it('is Removing even when the config is already gone, until the removal MR merges', () => {
    expect(projectState(setup({ removalMergeRequest }), '1.1.0')).toEqual({
      _tag: 'Removing',
      removalMergeRequest,
    });
  });
});
