import { describe, expect, it } from 'vitest';
import { correctionTask } from './correction';
import { oneLine } from './verify';

describe('correctionTask', () => {
  it('is the task, then the rejected answer and why, to correct rather than redo', () => {
    const task = '# A task\n\nAnswer with JSON.\n';
    const corrected = correctionTask({
      task,
      answer: '{"target":{}}',
      error: 'Missing key at ["reason"]',
    });
    expect(corrected.startsWith(task)).toBe(true);
    const correction = corrected.slice(task.length);
    expect(correction).toContain('## Correct your answer');
    expect(correction).toContain('```\nMissing key at ["reason"]\n```');
    expect(correction).toContain('```\n{"target":{}}\n```');
    expect(oneLine(correction)).toContain('Answer with the whole corrected JSON document');
  });
});
