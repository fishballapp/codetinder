import { describe, expect, it } from 'vitest';
import { commitLinesPerSweep } from './linesPerSweep';

describe('commitLinesPerSweep', () => {
  it('saves a whole number of lines, 100 or more', () => {
    expect(commitLinesPerSweep({ typed: 3000, shown: 2000 })).toEqual({
      _tag: 'Save',
      threshold: 3000,
    });
    expect(commitLinesPerSweep({ typed: 100, shown: 2000 })).toEqual({
      _tag: 'Save',
      threshold: 100,
    });
  });

  it('saves nothing when the value is what the field showed', () => {
    expect(commitLinesPerSweep({ typed: 2000, shown: 2000 })).toEqual({ _tag: 'Unchanged' });
  });

  it('refuses fewer than 100 lines, or none', () => {
    const refusal = { _tag: 'Invalid', message: 'At least 100' };
    expect(commitLinesPerSweep({ typed: 99, shown: 2000 })).toEqual(refusal);
    expect(commitLinesPerSweep({ typed: 0, shown: 2000 })).toEqual(refusal);
    expect(commitLinesPerSweep({ typed: -500, shown: 2000 })).toEqual(refusal);
    expect(commitLinesPerSweep({ typed: null, shown: 2000 })).toEqual(refusal);
  });

  it('refuses part of a line', () => {
    expect(commitLinesPerSweep({ typed: 150.5, shown: 2000 })).toEqual({
      _tag: 'Invalid',
      message: 'Whole lines only',
    });
  });
});
