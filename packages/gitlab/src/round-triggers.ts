import {
  EVENT_CODES,
  type TriggerEvent,
  type TriggerFilter,
  type TriggerFilterRule,
} from './flow-triggers';

/**
 * How a project's rounds start, as its flow trigger holds it: each way is a set of GitLab events
 * and the filter they need. The setting lives on the trigger and nowhere else.
 */

/** The ways a project can start rounds; any combination, at least one. */
export const ROUND_STARTS = ['opened', 'reviewer', 'push'] as const;
export type RoundStart = (typeof ROUND_STARTS)[number];

/** What a new install starts rounds on. */
export const DEFAULT_ROUND_STARTS: readonly RoundStart[] = ['opened', 'reviewer'];

const OPENED_RULES: readonly TriggerFilterRule[] = [
  { field: 'action', operator: 'eq', value: 'created' },
];

/**
 * Each way's events and filter. A push counts once: a pipeline's `running` status, from a push or
 * an MR pipeline, off the default branch (whose pushes are merges). The `in` value is an array,
 * which only the raw `filter` carries.
 */
const ROUND_START_TRIGGERS: Record<
  RoundStart,
  {
    readonly events: readonly TriggerEvent[];
    readonly filter: (defaultBranch: string | null) => TriggerFilter;
  }
> = {
  opened: {
    events: ['merge_request', 'merge_request_ready'],
    filter: () => ({ merge_request: { match: 'all', rules: OPENED_RULES } }),
  },
  reviewer: { events: ['assign_reviewer'], filter: () => ({}) },
  push: {
    events: ['pipeline_hooks'],
    filter: defaultBranch => ({
      pipeline_hooks: {
        match: 'all',
        rules: [
          {
            field: 'object_attributes.source',
            operator: 'in',
            value: ['push', 'merge_request_event'],
          },
          { field: 'object_attributes.status', operator: 'eq', value: 'running' },
          ...(defaultBranch === null
            ? []
            : [{ field: 'object_attributes.ref', operator: 'ne', value: defaultBranch } as const]),
        ],
      },
    }),
  },
};

/** The ways a trigger starts rounds: each whose events it has any of. */
export const roundStartsOf = (eventTypes: readonly number[]): ReadonlySet<RoundStart> =>
  new Set(
    ROUND_STARTS.filter(start =>
      ROUND_START_TRIGGERS[start].events.some(event => eventTypes.includes(EVENT_CODES[event])),
    ),
  );

/**
 * The trigger that starts rounds the ways given, written whole: every way's events and filter,
 * and the mention that Done's reply needs, always.
 */
export const roundTrigger = ({
  starts,
  defaultBranch,
}: {
  readonly starts: ReadonlySet<RoundStart>;
  readonly defaultBranch: string | null;
}): { readonly eventTypes: readonly number[]; readonly filter: TriggerFilter } => {
  const chosen = ROUND_STARTS.filter(start => starts.has(start));
  return {
    eventTypes: [
      ...chosen.flatMap(start => ROUND_START_TRIGGERS[start].events),
      'mention' as const,
    ].map(event => EVENT_CODES[event]),
    filter: Object.assign(
      {},
      ...chosen.map(start => ROUND_START_TRIGGERS[start].filter(defaultBranch)),
    ),
  };
};

/** Whether the trigger has exactly the events `roundTrigger` would write for what it starts on. */
export const isRoundTriggerCurrent = (eventTypes: readonly number[]): boolean => {
  const written = roundTrigger({ starts: roundStartsOf(eventTypes), defaultBranch: null });
  const has = new Set(eventTypes);
  return has.size === written.eventTypes.length && written.eventTypes.every(code => has.has(code));
};

/**
 * What a new install's consumer is created with: the default ways' events and the mention. The
 * consumer's `triggerConditions` can't carry an array, so no default may need one.
 */
export const DEFAULT_TRIGGER_TYPES: readonly TriggerEvent[] = [
  ...DEFAULT_ROUND_STARTS.flatMap(start => ROUND_START_TRIGGERS[start].events),
  'mention',
];

/** The opened way's `created` condition, in `triggerConditions`' uppercase form. */
export const DEFAULT_TRIGGER_CONDITIONS = {
  mergeRequest: {
    match: 'ALL',
    rules: OPENED_RULES.map(({ field, operator, value }) => ({
      field,
      operator: operator.toUpperCase(),
      value,
    })),
  },
};
