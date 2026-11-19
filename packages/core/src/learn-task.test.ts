import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { LearnAnswerSchema, learnTask } from './learn-task';
import type { Principle } from './principles';
import type { Card, Round } from './round';
import { tallyVerdicts, type Verdicts } from './swipes';
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

const c1: Card = {
  id: 'c1',
  operation: 'Function Declaration to Arrow Function',
  change: 'Turned the declaration into an arrow function.',
  principle: { id: 'arrow-functions', statement: 'Write functions as arrow functions.' },
  stance: 'supports',
  kind: 'explore',
  after: 'const f = () => 1;',
};

const round: Round = {
  version: 2,
  target: { file: 'src/f.ts', symbol: 'f', text: 'function f() { return 1; }' },
  reason: 'It branches.',
  context: [],
  imports: [],
  cards: [c1],
};

const swipes = (verdicts: Verdicts) => [{ verdicts }];

describe('learnTask', () => {
  const learn = (overrides: Partial<Parameters<typeof learnTask>[0]> = {}) =>
    renderTask(
      learnTask({
        current: { _tag: 'Parsed', principles, isNormalised: true },
        writtenRules: [],
        round,
        tallies: tallyVerdicts(round, swipes({ c1: 'like' })),
        evidence: [],
        ...overrides,
      }),
    );

  it('fences code with a backtick run longer than any in it', () => {
    const withCode = {
      ...round,
      cards: round.cards.map(card => ({ ...card, after: "f = '```';" })),
    };
    const printed = learn({
      round: withCode,
      tallies: tallyVerdicts(withCode, swipes({ c1: 'like' })),
    });
    expect(printed).toContain(
      "````\n@@ -1,1 +1,1 @@\n-function f() { return 1; }\n+f = '```';\n````",
    );
  });

  it('asks to convert back a doc edited out of shape, keeping every rule', () => {
    const printed = learn({
      current: { _tag: 'Unconverted', text: '# Style\n\n- Never use `var`.' },
    });
    expect(oneLine(printed)).toContain(
      "`.codetinder/principles.md`, was edited out of CodeTinder's format, so convert it back as you learn.",
    );
    expect(printed).toContain('```\n# Style\n\n- Never use `var`.\n```');
    expect(printed).toContain('Turn every rule it states into a principle in `converted`');
    expect(printed).not.toContain('- early-returns (strong)');
  });

  it("names the team's written rules to read, and none when there are none", () => {
    const printed = learn({ writtenRules: ['AGENTS.md', 'CONTRIBUTING.md'] });
    expect(printed).toContain("## The team's written rules");
    expect(printed).toContain('in `AGENTS.md`, `CONTRIBUTING.md`.');
    expect(learn()).not.toContain("## The team's written rules");
  });

  it('lets the swipes win: a rule a principle contradicts is rewritten or removed, nothing else', () => {
    const printed = oneLine(learn({ writtenRules: ['CONTRIBUTING.md'] }));
    expect(printed).toContain("The swipes are the developers' taste, and they win.");
    expect(printed).toContain(
      'When a principle you add, strengthen or keep contradicts one of those rules, add an edit to `writtenRuleEdits` that rewrites the rule to agree with the principle, or removes it',
    );
    expect(printed).toContain(
      "`rule` is the rule's exact current text, copied from `read_file`: one rule, at most 20 lines, found exactly once in its file. Only that text changes.",
    );
    expect(printed).toContain(
      'Change nothing else: not another rule, not the wording or formatting around it, and never the CodeTinder section between `<!-- codetinder:principles -->` markers.',
    );
    expect(printed).not.toContain('never add or strengthen');
  });

  it('shows the principles, the original once, and each swiped card as a diff with its verdicts', () => {
    const original = ['function f(a) {', '  const b = a + 1;', '  return b;', '}'].join('\n');
    const inlined = { ...c1, after: ['function f(a) {', '  return a + 1;', '}'].join('\n') };
    const named = {
      ...c1,
      id: 'c2',
      after: ['function f(a) {', '  const b = a + 1;', '  const c = b;', '  return c;', '}'].join(
        '\n',
      ),
    };
    const twoCards: Round = {
      ...round,
      target: { ...round.target, text: original },
      cards: [inlined, named],
    };
    const printed = learn({
      round: twoCards,
      tallies: tallyVerdicts(twoCards, [
        { verdicts: { c1: 'like', c2: 'dislike' } },
        { verdicts: { c1: 'like' } },
      ]),
    });
    expect(printed).toContain('- early-returns (strong): Return early.');
    expect(printed).toContain(`The original, from \`src/f.ts\`:\n\n\`\`\`\n${original}\n\`\`\``);
    expect(printed).toContain(
      [
        '### c1: 2 like, 0 dislike',
        '',
        'Function Declaration to Arrow Function: Turned the declaration into an arrow function.',
        '',
        '```',
        '@@ -1,4 +1,3 @@',
        ' function f(a) {',
        '-  const b = a + 1;',
        '-  return b;',
        '+  return a + 1;',
        ' }',
        '```',
      ].join('\n'),
    );
    expect(printed).toContain(
      [
        '### c2: 0 like, 1 dislike',
        '',
        'Function Declaration to Arrow Function: Turned the declaration into an arrow function.',
        '',
        '```',
        '@@ -1,4 +1,5 @@',
        ' function f(a) {',
        '   const b = a + 1;',
        '-  return b;',
        '+  const c = b;',
        '+  return c;',
        ' }',
        '```',
      ].join('\n'),
    );
  });

  it("shows a card's operation and change, as the developer saw them, never its principle, stance or kind", () => {
    const printed = learn({
      round: { ...round, cards: [{ ...c1, stance: 'opposes', kind: 'challenge' }] },
    });
    expect(printed).toContain(
      'Function Declaration to Arrow Function: Turned the declaration into an arrow function.',
    );
    expect(printed).not.toContain('arrow-functions');
    expect(printed).not.toContain('Write functions as arrow functions.');
    expect(printed).not.toMatch(/\b(opposes|supports|challenge|explore)\b/);
    expect(printed).not.toContain('Evidence');
  });

  it('leaves out a card nobody swiped, since it teaches nothing', () => {
    const twoCards: Round = {
      ...round,
      cards: [c1, { ...c1, id: 'c2', after: 'const g = () => 2;' }],
    };
    const printed = learn({
      round: twoCards,
      tallies: tallyVerdicts(twoCards, swipes({ c1: 'like' })),
    });
    expect(printed).toContain('### c1:');
    expect(printed).not.toContain('### c2:');
    expect(printed).not.toContain('const g = () => 2;');
  });

  it('says a round nobody swiped teaches nothing, and shows no card', () => {
    const printed = oneLine(learn({ tallies: tallyVerdicts(round, []) }));
    expect(printed).toContain(
      'Nobody swiped a card, so this round teaches nothing: answer no operations and no written-rule edit.',
    );
    expect(printed).not.toContain('### c1');
  });

  it("shows every section, and puts a new principle under General or the round's language", () => {
    const printed = learn({
      current: { _tag: 'Parsed', principles: languagePrinciples, isNormalised: true },
    });
    expect(printed).toContain('### TypeScript\n\n- readonly-fields (moderate): Readonly.');
    expect(printed).toContain('### Python\n\n- comprehensions (tentative): Comprehend.');
    expect(oneLine(printed)).toContain(
      'The round\'s function is TypeScript, so a new principle goes under "General" if it would hold in any language, and under "TypeScript" if it would not.',
    );
    expect(printed).not.toContain("isn't laid out as CodeTinder writes it");
  });

  it('puts a new principle under General for a file in a language without a section', () => {
    const elm = { ...round, target: { ...round.target, file: 'src/Main.elm' } };
    expect(oneLine(learn({ round: elm }))).toContain(
      'in a language without a section of its own, so a new principle goes under "General"',
    );
  });

  it('lets the agent tell C from C++ for a .h target', () => {
    const header = { ...round, target: { ...round.target, file: 'include/x.h' } };
    expect(oneLine(learn({ round: header }))).toContain(
      'The round\'s function is C++ or C, whichever the code is, so a new principle goes under "General" if it would hold in any language, and under that language\'s section if it would not.',
    );
  });

  it('asks to check every section of a doc that is not normalised', () => {
    const printed = learn({
      current: { _tag: 'Parsed', principles, isNormalised: false },
    });
    expect(printed).toContain('- early-returns (strong): Return early.');
    expect(oneLine(printed)).toContain(
      "`.codetinder/principles.md`, isn't laid out as CodeTinder writes it: it is in an older format, without language sections, or was edited by hand.",
    );
    expect(oneLine(printed)).toContain(
      'A principle filed under the wrong section can move with a `reword` that keeps its statement',
    );
  });

  it('tells the agent a like prefers the after, and to judge the code and its change, not a principle', () => {
    const printed = oneLine(learn());
    expect(printed).toContain(
      'Nothing says which principle a change was meant to test: the developers judged the code and its change, and so do you.',
    );
    expect(printed).toContain(
      "A like means the developer prefers the card's after; a dislike, the original.",
    );
  });

  it('asks for the preferences the swipes show, across cards too, weighed by their backing', () => {
    const printed = oneLine(learn());
    expect(printed).toContain(
      'several cards can share a preference that no one of them shows alone.',
    );
    expect(printed).toContain(
      "Weigh each preference by how many swipes and cards back it, earlier rounds' included. Don't read a rule into one card further than it shows",
    );
  });

  it('cancels swipes pointing both ways on one idea, and counts opposite cards one way', () => {
    const printed = oneLine(learn());
    expect(printed).toContain(
      'Swipes pointing both ways on one idea cancel out: a liked card that names a value and a liked card that inlines one say nothing about naming values, and neither does a card liked and disliked equally.',
    );
    expect(printed).toContain(
      'A disliked card that names a value and a liked one that inlines a value both point the same way, to inlining.',
    );
  });

  it('maps a preference onto the principle it matches, acting on its id', () => {
    expect(oneLine(learn())).toContain(
      'When a preference is the same idea as an existing principle, even in other words, it is that principle: act on its id.',
    );
  });

  it('asks for operations on the doc, a principle no operation names staying as it is', () => {
    const printed = oneLine(learn());
    expect(printed).toContain(
      'You answer with operations on the doc, not the doc: code applies them, and every principle no operation names stays exactly as it is.',
    );
    expect(printed).toContain(
      '`strengthen` a principle the round confirms: tentative to moderate, moderate to strong.',
    );
    expect(printed).toContain('A tentative one weakened is dropped.');
    expect(printed).toContain(
      'Make at most 4 operations, and at most one per principle. Consider `drop` and `merge` first. Add a principle for a preference the swipes back that no principle states, never one that restates a principle in the doc.',
    );
  });

  it('adds a new preference as a tentative principle with a new general id, worded as generally as the swipes support', () => {
    const printed = oneLine(learn());
    expect(printed).toContain(
      '`add` a preference no principle states, as a new principle (it starts tentative), with a new id: kebab-case, naming the general idea, not this function.',
    );
    expect(printed).toContain(
      'Word each new or reworded principle as generally as the swipes support. A first guess that turns out wrong is fine: it is tentative, and later rounds refine it.',
    );
  });

  it("shows earlier rounds' evidence on the doc's principles only, citing each card", () => {
    const earlierCard = {
      ref: 'ABCDEFGHIJKL/c3',
      file: 'src/g.ts',
      operation: 'Rename Function',
      change: 'Calls h instead of g.',
      diff: '@@ -1,1 +1,1 @@\n-g()\n+h()',
      likes: 0,
      dislikes: 1,
    };
    const printed = learn({
      evidence: [
        { id: 'early-returns', for: 4, against: 1, confirming: null, contradicting: earlierCard },
        { id: 'arrow-functions', for: 1, against: 0, confirming: earlierCard, contradicting: null },
      ],
    });
    expect(printed).toContain(`### early-returns: 4 swipes for, 1 against

A card that contradicted it: \`ABCDEFGHIJKL/c3\`, in \`src/g.ts\`, 0 like, 1 dislike

Rename Function: Calls h instead of g.

\`\`\`
@@ -1,1 +1,1 @@
-g()
+h()
\`\`\``);
    expect(printed).not.toContain('### arrow-functions:');
    expect(oneLine(printed)).toContain(
      'A card confirms a principle when its swipes agree with it: a like on a card that follows the principle, or a dislike on one that breaks it.',
    );
    expect(learn()).not.toContain('## What earlier rounds showed');
  });

  it('decodes the agent answer against the operation schema', () => {
    const decode = Schema.decodeUnknownResult(LearnAnswerSchema);
    const answer = (overrides: Record<string, unknown>) =>
      decode({
        operations: [{ op: 'strengthen', id: 'early-returns' }],
        writtenRuleEdits: [],
        ...overrides,
      });
    expect(Result.isSuccess(answer({}))).toBe(true);
    expect(Result.isFailure(decode({ operations: [] }))).toBe(true);
    expect(
      Result.isFailure(answer({ operations: [{ op: 'strengthen', id: 'Early Returns' }] })),
    ).toBe(true);
    expect(
      Result.isFailure(
        answer({ operations: [{ op: 'add', id: 'x', section: 'Haskell', statement: 'X.' }] }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        answer({ operations: [{ op: 'merge', id: 'early-returns', merged: [], statement: 'X.' }] }),
      ),
    ).toBe(true);
    expect(Result.isSuccess(answer({ converted: principles }))).toBe(true);
    const ruleEdit = {
      path: 'CONTRIBUTING.md',
      rule: 'Always write else.',
      replacement: '',
      principleId: 'early-returns',
    };
    expect(Result.isSuccess(answer({ writtenRuleEdits: [ruleEdit] }))).toBe(true);
    expect(
      Result.isFailure(answer({ writtenRuleEdits: [{ ...ruleEdit, path: 'src/f.ts' }] })),
    ).toBe(true);
  });
});
