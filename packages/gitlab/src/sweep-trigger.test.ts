import { describe, expect, it } from '@effect/vitest';
import { roundTrigger } from './round-triggers';
import { isSweepAutomatic, isSweepGoal, isSweepTrigger, sweepTrigger } from './sweep-trigger';

const DEFAULT_BRANCH_SUCCESS = [
  { field: 'object_attributes.ref', operator: 'eq', value: 'main' },
  { field: 'object_attributes.status', operator: 'eq', value: 'success' },
];
const SWEEP_NOW_ONLY = { field: 'object_attributes.source', operator: 'eq', value: 'api' };

describe('sweepTrigger', () => {
  it('hears every passing pipeline on the default branch when sweeping is automatic', () => {
    expect(sweepTrigger({ isAutomatic: true, defaultBranch: 'main' })).toEqual({
      eventTypes: [3],
      filter: { pipeline_hooks: { match: 'all', rules: DEFAULT_BRANCH_SUCCESS } },
    });
  });

  it('hears only the API’s pipeline, Sweep now’s, when it is off', () => {
    expect(sweepTrigger({ isAutomatic: false, defaultBranch: 'main' })).toEqual({
      eventTypes: [3],
      filter: {
        pipeline_hooks: { match: 'all', rules: [...DEFAULT_BRANCH_SUCCESS, SWEEP_NOW_ONLY] },
      },
    });
  });

  it('writes JSON GitLab takes: lowercase, keyed by the event', () => {
    expect(
      JSON.stringify(sweepTrigger({ isAutomatic: false, defaultBranch: 'trunk' }).filter),
    ).toBe(
      '{"pipeline_hooks":{"match":"all","rules":[' +
        '{"field":"object_attributes.ref","operator":"eq","value":"trunk"},' +
        '{"field":"object_attributes.status","operator":"eq","value":"success"},' +
        '{"field":"object_attributes.source","operator":"eq","value":"api"}]}}',
    );
  });
});

describe('isSweepAutomatic', () => {
  it('reads back both settings it writes', () => {
    for (const isAutomatic of [true, false]) {
      const { filter } = sweepTrigger({ isAutomatic, defaultBranch: 'main' });
      expect(isSweepAutomatic(filter)).toBe(isAutomatic);
    }
  });

  it('reads a filter GitLab added its own keys to', () => {
    expect(
      isSweepAutomatic({
        pipeline_hooks: { rules: [...DEFAULT_BRANCH_SUCCESS, SWEEP_NOW_ONLY] },
      }),
    ).toBe(false);
  });
});

describe('isSweepTrigger', () => {
  it('is the trigger with the pipeline event alone, never a round trigger', () => {
    expect(
      isSweepTrigger(sweepTrigger({ isAutomatic: true, defaultBranch: 'main' }).eventTypes),
    ).toBe(true);
    expect(
      isSweepTrigger(roundTrigger({ starts: new Set(['push']), defaultBranch: 'main' }).eventTypes),
    ).toBe(false);
    expect(isSweepTrigger([6, 4, 2, 0])).toBe(false);
    expect(isSweepTrigger([1, 0])).toBe(false);
  });
});

describe('isSweepGoal', () => {
  const pipelineGoal = (ref: string, status: string) =>
    JSON.stringify({
      object_kind: 'pipeline',
      object_attributes: { id: 1, ref, source: 'api', status },
      merge_request: null,
    });

  it('is a session started by a pipeline that passed on the default branch', () => {
    expect(isSweepGoal({ goal: pipelineGoal('main', 'success'), defaultBranch: 'main' })).toBe(
      true,
    );
  });

  it('is never a round’s: its pipeline on an MR’s branch, its MR or its mention', () => {
    const notSweeps = [
      pipelineGoal('feat/x', 'running'),
      pipelineGoal('main', 'running'),
      '136',
      'Input: @codetinder round',
    ];
    for (const goal of notSweeps) expect(isSweepGoal({ goal, defaultBranch: 'main' })).toBe(false);
  });
});
