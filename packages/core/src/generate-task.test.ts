import { describe, expect, it } from 'vitest';
import { generateTask } from './generate-task';
import type { Principle } from './principles';
import type { Question } from './questions';
import { renderTask } from './tasks';
import { oneLine } from './verify';

const principles: Principle[] = [
  { id: 'early-returns', section: 'General', strength: 'strong', statement: 'Return early.' },
];

const languagePrinciples: Principle[] = [
  ...principles,
  { id: 'readonly-fields', section: 'TypeScript', strength: 'moderate', statement: 'Readonly.' },
  { id: 'comprehensions', section: 'Python', strength: 'tentative', statement: 'Comprehend.' },
];

const questions: Question[] = [
  {
    id: 'name-intermediate-values',
    statement: 'Name an intermediate value before using it.',
    supports: { likes: 3, dislikes: 1 },
    opposes: { likes: 0, dislikes: 2 },
    roundsSinceJudged: 3,
  },
  {
    id: 'early-returns',
    statement: 'Return early.',
    supports: { likes: 4, dislikes: 0 },
    opposes: { likes: 0, dislikes: 0 },
    roundsSinceJudged: 0,
  },
  {
    id: 'lookup-tables',
    statement: 'Map a fixed set of cases with a lookup table.',
    supports: { likes: 0, dislikes: 0 },
    opposes: { likes: 0, dislikes: 0 },
    roundsSinceJudged: null,
  },
  {
    id: 'ternary-over-if',
    statement: 'Choose a value with a ternary.',
    supports: { likes: 1, dislikes: 1 },
    opposes: { likes: 0, dislikes: 0 },
    roundsSinceJudged: 2,
  },
];

const mergeRequestFiles = ['src/f.ts', 'README.md'];

const sampleDiff = 'diff --git a/src/f.ts b/src/f.ts\n+function f() { return 1; }';

const printTask = (
  args: { principles?: readonly Principle[]; questions?: readonly Question[] } = {},
) =>
  renderTask(
    generateTask({
      mergeRequestIid: 42,
      diff: sampleDiff,
      mergeRequestFiles,
      principles: args.principles ?? [],
      questions: args.questions ?? [],
    }),
  );

describe('renderTask', () => {
  it('prints the instructions with the diff, then a standalone JSON Schema of the answer', () => {
    const [instructions, schema] = printTask().split(
      'One JSON document matching this JSON Schema:',
    );
    expect(instructions).toContain('merge request !42');
    expect(instructions).toContain('## The diff');
    expect(instructions).toContain(sampleDiff);
    expect(instructions).toContain('read_file');
    expect(instructions).toMatch(/never from\s+the diff/);
    expect(JSON.parse(schema!)).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      anyOf: [
        { type: 'object', required: expect.arrayContaining(['target', 'cards']) },
        { type: 'object', required: ['declined'] },
      ],
    });
  });
});

describe('generateTask', () => {
  describe('the pick', () => {
    it('lets the agent decline when no function qualifies, instead of picking another', () => {
      expect(oneLine(printTask())).toContain(
        "don't pick one from elsewhere: answer with `declined`",
      );
    });

    it('has the target start at the leading comment, so an extracted helper lands above it', () => {
      const printed = oneLine(printTask());
      expect(printed).toContain('Start at its leading comment');
      expect(printed).toContain(
        'puts its definition at the top of `after`, then a blank line, then the function from its leading comment on',
      );
    });

    it('asks for context and imports in TypeScript and JavaScript only', () => {
      const printed = oneLine(printTask());
      expect(printed).toContain('For TypeScript and JavaScript, list as context');
      expect(printed).toContain('For other languages, leave context and imports empty.');
    });

    it("imports what comes from a package, the repository's own included, instead of copying it", () => {
      const printed = oneLine(printTask());
      expect(printed).toContain('its file declares or imports by a relative path');
      expect(printed).toContain(
        "one of this repository's own workspace packages, isn't context: give its import line instead, copied verbatim from the file that imports it, the function's or a context snippet's",
      );
      expect(printed).toContain('each import must resolve from there');
    });
  });

  describe('the cards', () => {
    it('asks for 4 to 8 cards, each one change applied to the original on its own', () => {
      const printed = oneLine(printTask());
      expect(printed).toContain('Write 4 to 8 cards.');
      expect(printed).toContain('keep at least 4');
      expect(printed).toContain('every card starts from the original, never from another card');
    });

    it("names each change as one operation, from Fowler's catalogue where one fits", () => {
      const printed = oneLine(printTask());
      expect(printed).toContain(
        "Name it from Martin Fowler's refactoring catalogue where one fits",
      );
      expect(printed).toContain(
        'A change that needs a second operation to read well is two cards, or none.',
      );
    });

    it('keeps every other line byte-identical and the behaviour exactly the same', () => {
      const printed = oneLine(printTask());
      expect(printed).toContain("Every line the operation doesn't need stays exactly as it was");
      expect(printed).toContain('The after behaves exactly like the original for every input');
    });

    it('never makes a card of what a formatter or linter settles', () => {
      expect(oneLine(printTask())).toContain(
        'Never a change a formatter or linter would settle: whitespace, indentation, quotes, semicolons, trailing commas, braces around a one-line body, import order.',
      );
    });

    it('gives each card a general principle and a stance', () => {
      const printed = oneLine(printTask());
      expect(printed).toContain('worded to hold in any function');
      expect(printed).toContain("`supports` when the after follows it where the original doesn't");
      expect(printed).toContain('`opposes` when the after breaks it where the original follows it');
    });

    it('spells out the id format, a name from the code in lowercase words too', () => {
      expect(oneLine(printTask())).toContain(
        'an `id` (lowercase kebab-case, a name from the code in lowercase words too: `over-is-some`, never `over-isSome`)',
      );
    });

    it('reuses the id of a principle or question that tests the same idea', () => {
      const printed = oneLine(printTask());
      expect(printed).toContain('One idea keeps one id in every round');
      expect(printed).toContain('use its id and its statement exactly');
    });
  });

  describe('the kinds', () => {
    it('keeps explore cards off settled questions, which confirm and challenge cards test', () => {
      expect(oneLine(printTask())).toContain(
        'Never a settled question, one a principle below already covers, under its id or in other words: test that with a confirm or challenge card instead.',
      );
    });

    it('makes a consistency pair optional, on one principle with opposite stances at different spots', () => {
      const printed = oneLine(printTask());
      expect(printed).toContain(
        'The two halves test the same principle, under one id, with opposite stances, at different spots',
      );
      expect(printed).toContain(
        'A consistency pair is optional: write one only where two natural spots exist for the same principle',
      );
    });

    it('requires no confirm or challenge card, though they are welcome', () => {
      const printed = oneLine(printTask());
      expect(printed).toContain('Confirm and challenge cards are welcome where the code allows');
      expect(printed).toContain('but none is required');
      expect(printed).not.toContain('a confirm and a challenge card wherever the code allows');
    });
  });

  describe('freshness', () => {
    it('picks the function partly for questions that are not resting', () => {
      expect(oneLine(printTask())).toContain(
        'prefer the function whose changes can ask worthwhile, varied questions that are not resting',
      );
    });

    it('asks for at least half of the cards on questions that are not resting', () => {
      const printed = oneLine(printTask());
      expect(printed).toContain("A question judged in one of the project's last 3 judged rounds");
      expect(printed).toContain(
        'At least half of your cards must ask questions that are not resting',
      );
    });

    it('counts a card on the same idea as a resting question as resting, under any id', () => {
      expect(oneLine(printTask())).toContain(
        'a card on the same idea as a resting question, under any id, counts as resting, so reuse its id',
      );
    });

    it('prefers the longest-rested and the most split among the re-asks', () => {
      expect(oneLine(printTask())).toContain(
        'prefer the longest-rested (the highest age) and the most split',
      );
    });
  });

  describe('the principles', () => {
    it('shows them', () => {
      const printed = printTask({ principles });
      expect(printed).toContain("## The project's coding principles");
      expect(printed).toContain('- early-returns (strong): Return early.');
    });

    it("shows only the General principles and the sections of the merge request's languages", () => {
      const printed = printTask({ principles: languagePrinciples });
      expect(printed).toContain('### General\n\n- early-returns (strong): Return early.');
      expect(printed).toContain('### TypeScript\n\n- readonly-fields (moderate): Readonly.');
      expect(printed).not.toContain('comprehensions');
      expect(oneLine(printed)).toContain(
        "Only the General ones and those in the function's language's section apply to it.",
      );
    });

    it('shows both the C and C++ sections for an MR that changes only a .h header', () => {
      const printed = renderTask(
        generateTask({
          mergeRequestIid: 42,
          diff: sampleDiff,
          mergeRequestFiles: ['include/x.h'],
          principles: [
            ...principles,
            {
              id: 'raii',
              section: 'C++',
              strength: 'strong',
              statement: 'Own resources with RAII.',
            },
            { id: 'no-vla', section: 'C', strength: 'moderate', statement: 'Avoid VLAs.' },
          ],
          questions: [],
        }),
      );
      expect(printed).toContain('### C++\n\n- raii (strong): Own resources with RAII.');
      expect(printed).toContain('### C\n\n- no-vla (moderate): Avoid VLAs.');
    });

    it('says there are no confirm or challenge cards when the project has no principles', () => {
      expect(printTask()).toContain(
        "## The project's coding principles\n\nNone yet, so there are no confirm or challenge cards.",
      );
    });
  });

  describe('the exceptions', () => {
    const nameValues: Principle = {
      id: 'name-intermediate-values',
      section: 'General',
      strength: 'moderate',
      statement: 'Bind a non-trivial sub-expression to a named const.',
      exception: {
        id: 'inline-single-use-calls',
        strength: 'tentative',
        statement: 'A value used once that is a single call stays inline.',
      },
    };
    const pythonException: Principle = {
      ...languagePrinciples[2]!,
      exception: { id: 'loops-with-side-effects', strength: 'tentative', statement: 'Loop.' },
    };
    const boundaries = (printed: string) =>
      printed.split('## Where the exceptions stop')[1]!.split("## The project's resting")[0]!;

    it('lists each exception with its principle, as the boundaries a card can test', () => {
      expect(boundaries(printTask({ principles: [...languagePrinciples, nameValues] }))).toContain(
        `- \`inline-single-use-calls\`, the exception to \`name-intermediate-values\`
  - principle: Bind a non-trivial sub-expression to a named const.
  - exception: A value used once that is a single call stays inline.`,
      );
    });

    it("lists only the exceptions of the merge request's languages", () => {
      const printed = printTask({
        principles: [...languagePrinciples.slice(0, 2), pythonException],
      });
      expect(printed).not.toContain('loops-with-side-effects');
      expect(oneLine(boundaries(printed))).toContain(
        'None of the principles above holds an exception, so there are no boundary cards.',
      );
    });

    it('deals at most one boundary card per exception and 2 a round, on the line between the two', () => {
      const printed = oneLine(printTask({ principles: [nameValues] }));
      expect(printed).toContain('at most one per exception and 2 in the round');
      expect(printed).toContain(
        'deal the boundary card before any other card on that principle or exception, a consistency pair included',
      );
      expect(printed).toContain('Where the function has no such spot, deal none.');
    });

    it('tests the rule that governs the spot, so a swipe agreeing with the doc counts for it', () => {
      const printed = oneLine(printTask({ principles: [nameValues] }));
      expect(printed).toContain(
        "It tests the rule that governs that spot as the doc words it, under that rule's id and statement exactly: the exception's at a spot the exception only just covers, the principle's at a spot it only just misses.",
      );
      expect(printed).toContain(
        "A swipe that agrees with the doc's wording counts for the rule the card tests",
      );
    });

    it('counts a boundary card toward the freshness budget like any other', () => {
      expect(oneLine(printTask({ principles: [nameValues] }))).toContain(
        'it rests when the id it tests does',
      );
    });

    it('settles a question on an exception, so no explore card asks it', () => {
      const printed = printTask({
        principles: [nameValues],
        questions: [{ ...questions[2]!, id: 'inline-single-use-calls' }],
      });
      expect(printed.split("## The project's open questions")[1]).not.toContain(
        'inline-single-use-calls',
      );
    });
  });

  describe('the questions', () => {
    const [resting, open] = printTask({ principles, questions })
      .split("## The project's resting questions")[1]!
      .split("## The project's open questions");

    it('shows the open ones with their age and swipes as evidence for and against', () => {
      // Likes on supporting cards and dislikes on opposing ones count for the principle.
      expect(printTask({ principles, questions })).toContain(
        '- name-intermediate-values: Name an intermediate value before using it. (age 3; 5 for, 1 against)',
      );
      expect(printTask({ principles, questions })).toContain(
        '- lookup-tables: Map a fixed set of cases with a lookup table. (not judged lately; not swiped yet)',
      );
      expect(resting).not.toContain('lookup-tables');
    });

    it('shows the resting ones, settled or open, under their own heading, not among the open', () => {
      expect(resting).toContain('- early-returns: Return early. (age 0; 4 for, 0 against)');
      expect(resting).toContain(
        '- ternary-over-if: Choose a value with a ternary. (age 2; 1 for, 1 against)',
      );
      expect(open).not.toContain('early-returns');
      expect(open).not.toContain('ternary-over-if');
    });

    it('leaves out of the open a question the doc holds a principle on, when it is not resting', () => {
      const printed = printTask({
        principles,
        questions: [{ ...questions[1]!, roundsSinceJudged: 5 }],
      });
      expect(printed).not.toContain('- early-returns: Return early.');
    });

    it('settles a question on a principle of a section the task leaves out', () => {
      const printed = printTask({
        principles: languagePrinciples,
        questions: [{ ...questions[0]!, id: 'comprehensions' }],
      });
      expect(printed).not.toContain('comprehensions');
    });

    it('says so when there are none', () => {
      const printed = printTask({ principles });
      expect(printed).toMatch(/with their age and swipes\.\n\n\(none\)\n/);
      expect(printed).toMatch(/preferred the code breaking it\.\n\n\(none\)\n/);
    });
  });
});
