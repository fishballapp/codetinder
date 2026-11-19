import { SweepThresholdSchema } from '@codetinder/api';
import * as Schema from 'effect/Schema';

/** What committing the lines-per-sweep field (Enter, or leaving it) does with what was typed. */
export type LinesPerSweepCommit =
  | { readonly _tag: 'Unchanged' }
  | { readonly _tag: 'Invalid'; readonly message: string }
  | { readonly _tag: 'Save'; readonly threshold: number };

/** `typed` is none when the field is empty; `shown` is the value the field stood at before. */
export const commitLinesPerSweep = ({
  typed,
  shown,
}: {
  readonly typed: number | null;
  readonly shown: number;
}): LinesPerSweepCommit => {
  if (typed === shown) return { _tag: 'Unchanged' };
  if (typed !== null && !Number.isInteger(typed)) {
    return { _tag: 'Invalid', message: 'Whole lines only' };
  }
  if (!Schema.is(SweepThresholdSchema)(typed)) return { _tag: 'Invalid', message: 'At least 100' };
  return { _tag: 'Save', threshold: typed };
};
