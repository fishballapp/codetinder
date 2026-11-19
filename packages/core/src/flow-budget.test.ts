import * as Duration from 'effect/Duration';
import { describe, expect, it } from 'vitest';
import { runTimeout } from './flow-budget';

describe('runTimeout', () => {
  it("adds up the steps' timeouts, and a margin for the gaps between them", () => {
    expect(Duration.toMinutes(runTimeout({ commands: 3, agents: 2, testSteps: 2 }))).toBe(81);
    expect(Duration.toMinutes(runTimeout({ commands: 0, agents: 0, testSteps: 0 }))).toBe(5);
  });
});
