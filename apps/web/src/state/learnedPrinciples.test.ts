import { renderPrinciplesDoc } from '@codetinder/core';
import { describe, expect, it } from 'vitest';
import { learnedPrinciples } from './learnedPrinciples';

const principle = {
  id: 'early-returns',
  section: 'General',
  strength: 'strong',
  statement: 'Return early instead of nesting.',
} as const;

describe('learnedPrinciples', () => {
  it("reads the doc's principles", () => {
    expect(learnedPrinciples(renderPrinciplesDoc([principle]))).toEqual({
      _tag: 'Learned',
      principles: [principle],
    });
  });

  it('reads the empty doc setup writes, and an empty file, as nothing learned yet', () => {
    for (const text of [renderPrinciplesDoc([]), '']) {
      expect(learnedPrinciples(text)).toEqual({ _tag: 'Learned', principles: [] });
    }
  });

  it('says when the doc is missing', () => {
    expect(learnedPrinciples(undefined)).toEqual({ _tag: 'Missing' });
  });

  it('says when the doc is edited out of our format, or in a newer one', () => {
    expect(learnedPrinciples('# Our style guide\n\nUse tabs.\n')).toEqual({
      _tag: 'Unreadable',
      reason: 'other-format',
    });
    const newer = renderPrinciplesDoc([principle]).replace('format 3', 'format 4');
    expect(learnedPrinciples(newer)).toEqual({
      _tag: 'Unreadable',
      reason: 'newer-format',
    });
  });
});
