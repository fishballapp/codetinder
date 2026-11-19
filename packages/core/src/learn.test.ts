import { describe, expect, it } from 'vitest';
import { diffPrinciples } from './learn';
import type { Principle } from './principles';

const principle = (
  id: string,
  strength: Principle['strength'],
  statement = `Do ${id}.`,
  section: Principle['section'] = 'General',
): Principle => ({ id, section, strength, statement });

describe('diffPrinciples', () => {
  it('names each change in the new order, then the dropped ones', () => {
    const before = [
      principle('early-returns', 'tentative'),
      principle('lookup-tables', 'strong'),
      principle('no-classes', 'moderate'),
      principle('short-names', 'moderate'),
      principle('kept', 'strong'),
      principle('readonly-types', 'moderate'),
      principle('no-any', 'tentative'),
      principle('as-const', 'moderate'),
    ];
    const after = [
      principle('pipelines', 'tentative'),
      principle('early-returns', 'moderate'),
      principle('kept', 'strong'),
      principle('lookup-tables', 'moderate'),
      principle('short-names', 'moderate', 'Name locals in one word.'),
      principle('readonly-types', 'moderate', 'Do readonly-types.', 'TypeScript'),
      principle('no-any', 'moderate', 'Do no-any.', 'TypeScript'),
      principle('as-const', 'moderate', 'Write `as const`.', 'TypeScript'),
    ];

    expect(diffPrinciples(before, after)).toEqual([
      { _tag: 'Added', principle: principle('pipelines', 'tentative') },
      { _tag: 'Strengthened', principle: principle('early-returns', 'moderate') },
      { _tag: 'Weakened', principle: principle('lookup-tables', 'moderate') },
      {
        _tag: 'Reworded',
        principle: principle('short-names', 'moderate', 'Name locals in one word.'),
      },
      {
        _tag: 'Moved',
        principle: principle('readonly-types', 'moderate', 'Do readonly-types.', 'TypeScript'),
      },
      // A move is named beside a new strength or a rewording, not hidden by it.
      {
        _tag: 'Strengthened',
        principle: principle('no-any', 'moderate', 'Do no-any.', 'TypeScript'),
      },
      { _tag: 'Moved', principle: principle('no-any', 'moderate', 'Do no-any.', 'TypeScript') },
      {
        _tag: 'Reworded',
        principle: principle('as-const', 'moderate', 'Write `as const`.', 'TypeScript'),
      },
      {
        _tag: 'Moved',
        principle: principle('as-const', 'moderate', 'Write `as const`.', 'TypeScript'),
      },
      { _tag: 'Dropped', principle: principle('no-classes', 'moderate') },
    ]);
  });

  it('finds nothing when the principles are unchanged', () => {
    const principles = [principle('early-returns', 'strong')];
    expect(diffPrinciples(principles, principles)).toEqual([]);
  });

  it("names a new exception as its principle narrowed, and an exception's own changes by its id", () => {
    const parent = principle('name-values', 'strong');
    const exception = {
      id: 'inline-once',
      strength: 'tentative',
      statement: 'Inline once.',
    } as const;
    const narrowed = { ...parent, exception };
    expect(diffPrinciples([parent], [narrowed])).toEqual([
      {
        _tag: 'Narrowed',
        principle: { ...parent },
        exception: { ...exception, section: 'General', parentId: 'name-values' },
      },
    ]);
    expect(
      diffPrinciples(
        [narrowed],
        [{ ...parent, exception: { ...exception, strength: 'moderate' } }],
      ),
    ).toEqual([
      {
        _tag: 'Strengthened',
        principle: {
          ...exception,
          strength: 'moderate',
          section: 'General',
          parentId: 'name-values',
        },
      },
    ]);
    expect(diffPrinciples([narrowed], [parent])).toEqual([
      {
        _tag: 'Dropped',
        principle: { ...exception, section: 'General', parentId: 'name-values' },
      },
    ]);
  });
});
