import { describe, expect, it } from '@effect/vitest';
import {
  DEFAULT_TRIGGER_CONDITIONS,
  DEFAULT_TRIGGER_TYPES,
  isRoundTriggerCurrent,
  type RoundStart,
  roundStartsOf,
  roundTrigger,
} from './round-triggers';

const OPENED_FILTER = {
  merge_request: {
    match: 'all',
    rules: [{ field: 'action', operator: 'eq', value: 'created' }],
  },
};

const PUSH_FILTER = {
  pipeline_hooks: {
    match: 'all',
    rules: [
      {
        field: 'object_attributes.source',
        operator: 'in',
        value: ['push', 'merge_request_event'],
      },
      { field: 'object_attributes.status', operator: 'eq', value: 'running' },
      { field: 'object_attributes.ref', operator: 'ne', value: 'main' },
    ],
  },
};

const write = (...starts: RoundStart[]) =>
  roundTrigger({ starts: new Set(starts), defaultBranch: 'main' });

describe('roundTrigger', () => {
  it('writes each way with its events and filter, and the mention always', () => {
    expect(write('opened')).toEqual({ eventTypes: [6, 4, 0], filter: OPENED_FILTER });
    expect(write('reviewer')).toEqual({ eventTypes: [2, 0], filter: {} });
    expect(write('push')).toEqual({ eventTypes: [3, 0], filter: PUSH_FILTER });
    expect(write('push', 'reviewer', 'opened')).toEqual({
      eventTypes: [6, 4, 2, 3, 0],
      filter: { ...OPENED_FILTER, ...PUSH_FILTER },
    });
  });

  it('writes the push filter as JSON GitLab takes: lowercase, the sources an array', () => {
    expect(JSON.stringify(write('push').filter)).toBe(
      '{"pipeline_hooks":{"match":"all","rules":[' +
        '{"field":"object_attributes.source","operator":"in","value":["push","merge_request_event"]},' +
        '{"field":"object_attributes.status","operator":"eq","value":"running"},' +
        '{"field":"object_attributes.ref","operator":"ne","value":"main"}]}}',
    );
  });

  it('leaves out the default branch rule when the project has no branch', () => {
    expect(roundTrigger({ starts: new Set(['push']), defaultBranch: null }).filter).toEqual({
      pipeline_hooks: { match: 'all', rules: PUSH_FILTER.pipeline_hooks.rules.slice(0, 2) },
    });
  });
});

describe('roundStartsOf', () => {
  it('reads back every combination it writes', () => {
    const combinations: RoundStart[][] = [
      ['opened'],
      ['reviewer'],
      ['push'],
      ['opened', 'reviewer'],
      ['opened', 'push'],
      ['reviewer', 'push'],
      ['opened', 'reviewer', 'push'],
    ];
    for (const starts of combinations) {
      expect(roundStartsOf(write(...starts).eventTypes)).toEqual(new Set(starts));
    }
  });

  it('reads a trigger from before the setting, MR created and mention, as opened', () => {
    expect(roundStartsOf([6, 0])).toEqual(new Set(['opened']));
    expect(roundStartsOf([0])).toEqual(new Set());
  });
});

describe('isRoundTriggerCurrent', () => {
  it('tells a trigger written whole from one missing a way’s events', () => {
    expect(isRoundTriggerCurrent([6, 4, 2, 0])).toBe(true);
    expect(isRoundTriggerCurrent([0, 3])).toBe(true);
    expect(isRoundTriggerCurrent([6, 0])).toBe(false);
    expect(isRoundTriggerCurrent([6, 4, 2])).toBe(false);
  });
});

describe('the defaults', () => {
  it('start rounds when an MR opens or is ready, or a reviewer is asked, and on a mention', () => {
    expect(DEFAULT_TRIGGER_TYPES).toEqual([
      'merge_request',
      'merge_request_ready',
      'assign_reviewer',
      'mention',
    ]);
    expect(DEFAULT_TRIGGER_CONDITIONS).toEqual({
      mergeRequest: {
        match: 'ALL',
        rules: [{ field: 'action', operator: 'EQ', value: 'created' }],
      },
    });
  });
});
