import { describe, expect, it } from 'vitest';
import type { Principle } from './principles';
import type { SweepFinding } from './sweep';
import { sweepCommitMessage, sweepDescription, sweepTitle } from './sweep-proposal';

const principles: Principle[] = [
  { id: 'early-returns', section: 'General', strength: 'strong', statement: 'Return early.' },
  { id: 'small-functions', section: 'General', strength: 'moderate', statement: 'Keep it short.' },
];

const swept: SweepFinding[] = [
  {
    file: 'src/cart.ts',
    name: 'total',
    principleIds: ['early-returns', 'small-functions'],
    why: 'It nests its happy path, see @all and https://evil.example.',
  },
  { file: 'src/tax.ts', name: 'rate', principleIds: ['early-returns'], why: 'It nests.' },
];

const PRINCIPLES_URL = 'https://gitlab.com/acme/app/-/blob/main/.codetinder/principles.md';

describe('sweepTitle', () => {
  it('counts the functions, in either tone', () => {
    expect(sweepTitle({ tone: 'plain', count: 2 })).toBe(
      'CodeTinder sweep: 2 functions brought in line with your principles',
    );
    expect(sweepTitle({ tone: 'mischievous', count: 1 })).toBe(
      '💘 CodeTinder sweep: 1 function brought in line with your principles',
    );
  });
});

describe('sweepDescription', () => {
  it('lists each function with the principles it now follows and why, and links the doc', () => {
    const description = sweepDescription({
      tone: 'plain',
      functions: swept,
      principles,
      principlesUrl: PRINCIPLES_URL,
      leftCount: 0,
    });
    expect(
      description,
    ).toBe(`This rewrites 2 functions changed since the last sweep to follow [your coding principles](${PRINCIPLES_URL}). Each is meant to behave as before, and the project's tests pass on the rewrite.

- \`total\` in \`src/cart.ts\`: It nests its happy path, see @\u200Ball and https:\u200B//evil.example.
  - \`early-returns\`: Return early.
  - \`small-functions\`: Keep it short.
- \`rate\` in \`src/tax.ts\`: It nests.
  - \`early-returns\`: Return early.`);
  });

  it('says how many functions wait for the next sweep', () => {
    const args = { functions: swept, principles, principlesUrl: PRINCIPLES_URL, leftCount: 3 };
    expect(sweepDescription({ ...args, tone: 'plain' })).toMatch(
      /\n\n3 functions more left for the next sweep\.$/,
    );
    const mischievous = sweepDescription({ ...args, tone: 'mischievous', leftCount: 1 });
    expect(mischievous).toMatch(/^💘 /);
    expect(mischievous).toContain('1 function more left for the next sweep.');
  });
});

describe('sweepCommitMessage', () => {
  it('names each function it rewrote and its principles', () => {
    expect(sweepCommitMessage(swept)).toBe(
      'style: bring 2 functions in line with the coding principles\n\n- src/cart.ts: total (early-returns, small-functions)\n- src/tax.ts: rate (early-returns)',
    );
  });
});
