import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import {
  EVENT_CODES,
  type StoredTriggerFilter,
  type TriggerFilter,
  type TriggerFilterRule,
} from './flow-triggers';

/**
 * How a project's sweep starts, as its second trigger on the flow's consumer holds it: a pipeline
 * that passes on the default branch. Whether every such pipeline sweeps, or only Sweep now's, lives
 * on the trigger and nowhere else.
 */

/** What the sweep trigger is called in GitLab's list of the project's triggers. */
export const SWEEP_TRIGGER_DESCRIPTION = 'CodeTinder sweep';

/** The sweep trigger's one event. The round trigger never holds it alone: it always has the mention. */
const SWEEP_EVENT_TYPES: readonly number[] = [EVENT_CODES.pipeline_hooks];

/** Sweep now's pipeline is the one the API starts: off, the trigger hears only it. */
const SWEEP_NOW_ONLY_RULE = {
  field: 'object_attributes.source',
  operator: 'eq',
  value: 'api',
} as const satisfies TriggerFilterRule;

/** Whether one of the consumer's triggers is the sweep's: its events are exactly the pipeline's. */
export const isSweepTrigger = (eventTypes: readonly number[]): boolean =>
  eventTypes.length === SWEEP_EVENT_TYPES.length &&
  SWEEP_EVENT_TYPES.every(code => eventTypes.includes(code));

/**
 * The sweep trigger, written whole: a pipeline that passed on the default branch, from any source
 * when sweeping is automatic (each merge's), else only from the API (Sweep now's).
 */
export const sweepTrigger = ({
  isAutomatic,
  defaultBranch,
}: {
  readonly isAutomatic: boolean;
  readonly defaultBranch: string;
}): { readonly eventTypes: readonly number[]; readonly filter: TriggerFilter } => ({
  eventTypes: SWEEP_EVENT_TYPES,
  filter: {
    pipeline_hooks: {
      match: 'all',
      rules: [
        { field: 'object_attributes.ref', operator: 'eq', value: defaultBranch },
        { field: 'object_attributes.status', operator: 'eq', value: 'success' },
        ...(isAutomatic ? [] : [SWEEP_NOW_ONLY_RULE]),
      ],
    },
  },
});

/** Whether the sweep trigger sweeps after every merge: it doesn't hold Sweep now's rule. */
export const isSweepAutomatic = (filter: StoredTriggerFilter): boolean =>
  !(filter.pipeline_hooks?.rules ?? []).some(
    ({ field, operator, value }) =>
      field === SWEEP_NOW_ONLY_RULE.field &&
      operator === SWEEP_NOW_ONLY_RULE.operator &&
      value === SWEEP_NOW_ONLY_RULE.value,
  );

const PipelineGoalSchema = Schema.fromJsonString(
  Schema.Struct({
    object_kind: Schema.Literal('pipeline'),
    object_attributes: Schema.Struct({ ref: Schema.String, status: Schema.String }),
  }),
);

/**
 * Whether a session's goal is a pipeline the sweep trigger hears: one that passed on the default
 * branch. A round's goal never is: its pipelines run on an MR's branch, its other goals are an MR
 * or a mention.
 */
export const isSweepGoal = ({
  goal,
  defaultBranch,
}: {
  readonly goal: string;
  readonly defaultBranch: string;
}): boolean =>
  Option.match(Schema.decodeUnknownOption(PipelineGoalSchema)(goal), {
    onNone: () => false,
    onSome: ({ object_attributes: { ref, status } }) =>
      ref === defaultBranch && status === 'success',
  });
