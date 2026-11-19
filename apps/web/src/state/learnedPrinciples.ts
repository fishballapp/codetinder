import { type Principle, readCurrentPrinciples } from '@codetinder/core';
import * as Result from 'effect/Result';

/** What a project's principles doc on its default branch says CodeTinder has learned. */
export type LearnedPrinciples =
  /** The doc in CodeTinder's format; no principles until a learn run writes some. */
  | { readonly _tag: 'Learned'; readonly principles: readonly Principle[] }
  /** No doc on the default branch: the setup MR isn't merged, or someone deleted it. */
  | { readonly _tag: 'Missing' }
  /**
   * A doc this page can't show: edited out of CodeTinder's format (`other-format`, which the next
   * learn run converts back) or one a newer CodeTinder wrote (`newer-format`).
   */
  | { readonly _tag: 'Unreadable'; readonly reason: 'other-format' | 'newer-format' };

/** Reads the doc's text, or `undefined` when it isn't there. */
export const learnedPrinciples = (text: string | undefined): LearnedPrinciples => {
  if (text === undefined) return { _tag: 'Missing' };
  const current = readCurrentPrinciples(text);
  if (Result.isFailure(current)) return { _tag: 'Unreadable', reason: 'newer-format' };
  if (current.success._tag === 'Unconverted') return { _tag: 'Unreadable', reason: 'other-format' };
  return { _tag: 'Learned', principles: current.success.principles };
};
