import { describe, expect, it } from 'vitest';
import { addability } from './addability';

const addable = {
  isMarkedForDeletion: false,
  canEnableFlow: true,
  hasFlow: false,
  defaultBranch: 'main',
} as const;

describe('addability', () => {
  it('is Addable on the default branch of a project the user can enable the flow in', () => {
    expect(addability(addable)).toEqual({ _tag: 'Addable', defaultBranch: 'main' });
  });

  it('is blocked by a deletion scheduled on the project or an ancestor', () => {
    expect(addability({ ...addable, isMarkedForDeletion: true })).toEqual({
      _tag: 'Blocked',
      reason: 'ScheduledForDeletion',
    });
  });

  it('is blocked when the user cannot enable the flow in the project', () => {
    expect(addability({ ...addable, canEnableFlow: false })).toEqual({
      _tag: 'Blocked',
      reason: 'NoAgentPlatform',
    });
  });

  it('is not blocked on the flow permission once the flow is on', () => {
    expect(addability({ ...addable, canEnableFlow: false, hasFlow: true })).toEqual({
      _tag: 'Addable',
      defaultBranch: 'main',
    });
  });

  it('is blocked by an empty repository', () => {
    expect(addability({ ...addable, defaultBranch: null })).toEqual({
      _tag: 'Blocked',
      reason: 'EmptyRepository',
    });
  });

  it('gives the deletion the precedence over the other reasons', () => {
    expect(
      addability({
        isMarkedForDeletion: true,
        canEnableFlow: false,
        hasFlow: false,
        defaultBranch: null,
      }),
    ).toEqual({ _tag: 'Blocked', reason: 'ScheduledForDeletion' });
  });

  it('gives the missing Agent Platform the precedence over an empty repository', () => {
    expect(addability({ ...addable, canEnableFlow: false, defaultBranch: null })).toEqual({
      _tag: 'Blocked',
      reason: 'NoAgentPlatform',
    });
  });
});
