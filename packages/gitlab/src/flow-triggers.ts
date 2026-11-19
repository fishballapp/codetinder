import * as Schema from 'effect/Schema';

/**
 * What every CodeTinder trigger is made of: GitLab's events and the raw filter it reads them
 * through. The round trigger (`round-triggers.ts`) and the sweep trigger (`sweep-trigger.ts`) are
 * two uses of it on one consumer.
 */

/** The trigger events CodeTinder uses, by `triggerTypes` name, with their `eventTypes` codes. */
export const EVENT_CODES = {
  mention: 0,
  assign_reviewer: 2,
  pipeline_hooks: 3,
  merge_request_ready: 4,
  merge_request: 6,
} as const;
export type TriggerEvent = keyof typeof EVENT_CODES;

/** One event's filter, as the trigger's raw `filter` JSON holds it: lowercase throughout. */
export type TriggerFilterRule = {
  readonly field: string;
  readonly operator: 'eq' | 'ne' | 'in';
  readonly value: string | readonly string[];
};
export type TriggerFilter = Partial<
  Record<TriggerEvent, { readonly match: 'all'; readonly rules: readonly TriggerFilterRule[] }>
>;

/**
 * A trigger's filter as GitLab reads it back: each event's rules, whatever their operators. GitLab
 * may add keys of its own (`type`), and a trigger set up in GitLab may hold any rule.
 */
export const StoredTriggerFilterSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    rules: Schema.Array(
      Schema.Struct({ field: Schema.String, operator: Schema.String, value: Schema.Unknown }),
    ),
  }),
);
export type StoredTriggerFilter = typeof StoredTriggerFilterSchema.Type;
