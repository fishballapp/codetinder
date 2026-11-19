import * as Schema from 'effect/Schema';
import { MAX_RULE_LINES, WrittenRuleEditSchema } from './agent-instructions';
import { unifiedDiff } from './diff';
import { fence } from './fence';
import { languagesOf } from './languages';
import {
  evidenceOnDoc,
  MAX_OPERATIONS,
  MAX_RULES,
  MIN_EXCEPTION_SWIPES,
  OperationSchema,
} from './learn-operations';
import { DIFF_CONTEXT_LINES, type EarlierCard, type PrincipleEvidence } from './principle-evidence';
import { type CurrentPrinciples, PRINCIPLES_PATH, PrinciplesSchema, rulesOf } from './principles';
import type { Round } from './round';
import type { CardTally } from './swipes';
import { renderPrinciples, type Task } from './tasks';

export const LearnAnswerSchema = Schema.Struct({
  converted: Schema.optionalKey(
    PrinciplesSchema.annotate({
      description:
        "Only when the doc was edited out of CodeTinder's format: every rule it states, as a principle, before this round's swipes. The operations apply to these",
    }),
  ),
  operations: Schema.Array(OperationSchema).annotate({
    description: `What the swipes change in the doc, at most ${MAX_OPERATIONS}, at most one per principle; [] keeps every principle as it is`,
  }),
  writtenRuleEdits: Schema.Array(WrittenRuleEditSchema).annotate({
    description:
      "Each rule in the team's written rules that a principle contradicts, rewritten to agree or removed; [] when none does",
  }),
});
export type LearnAnswer = typeof LearnAnswerSchema.Type;

const currentPrinciplesSection = (current: CurrentPrinciples) => {
  if (current._tag === 'Unconverted') {
    return `The project's principles doc, \`${PRINCIPLES_PATH}\`, was edited out of CodeTinder's
format, so convert it back as you learn. Its text:

${fence(current.text)}

Turn every rule it states into a principle in \`converted\`, with a strength that matches how
firmly the doc puts it: "strong" for a must, "moderate" for a preference, and a section as below.
Leave out only what isn't a rule: titles, explanations and examples. Your operations then apply to
those principles, by their ids.`;
  }
  const principles = renderPrinciples(current.principles);
  if (current.isNormalised) return principles;
  return `${principles}

The project's principles doc, \`${PRINCIPLES_PATH}\`, isn't laid out as CodeTinder writes it: it is
in an older format, without language sections, or was edited by hand. It is read as above and
rewritten in the current layout. A principle filed under the wrong section can move with a
\`reword\` that keeps its statement: one that only makes sense in one language belongs in that
language's section.`;
};

/** How many rules the doc holds now, so learn knows how close it is to the cap. */
const sizeNote = (current: CurrentPrinciples) =>
  current._tag === 'Parsed' ? `; it holds ${rulesOf(current.principles).length} now` : '';

/** Where a principle the round teaches goes: its function's language, unless it holds in any. */
const sectionGuide = (targetFile: string) => {
  const languages = [...languagesOf([targetFile])];
  const general =
    '"General" holds a principle that applies in any language: naming, branching, data flow, ' +
    'error handling.';
  if (languages.length === 0) {
    return `- Each principle has a section. ${general} The round's function is in a language
  without a section of its own, so a new principle goes under "General".`;
  }
  // A `.h` file is C or C++: the agent tells which from the code.
  const [language] = languages;
  const placement =
    languages.length === 1
      ? `${language}, so a new principle goes under "General" if it would hold in any language, and under "${language}" if it would not.`
      : `${languages.join(' or ')}, whichever the code is, so a new principle goes under "General" if it would hold in any language, and under that language's section if it would not.`;
  return `- Each principle has a section. ${general} A language's section holds one that only makes
  sense in that language's code: its type system, idioms or standard library. The round's
  function is ${placement}`;
};

const writtenRulesSection = (writtenRules: readonly string[]) =>
  writtenRules.length === 0
    ? ''
    : `
## The team's written rules

The team keeps rules for working on this code in ${writtenRules.map(file => `\`${file}\``).join(', ')}.
Read them with \`read_file\`. They already apply, so don't copy them into the principles.

The swipes are the developers' taste, and they win. When a principle you add, strengthen or keep
contradicts one of those rules, add an edit to \`writtenRuleEdits\` that rewrites the rule to agree
with the principle, or removes it, so the repo never tells agents two opposite things:

- \`rule\` is the rule's exact current text, copied from \`read_file\`: one rule, at most
  ${MAX_RULE_LINES} lines, found exactly once in its file. Only that text changes.
- \`replacement\` takes its place: the rule reworded to agree, or "" to remove it.
- Change nothing else: not another rule, not the wording or formatting around it, and never the
  CodeTinder section between \`<!-- codetinder:principles -->\` markers.
- A rule that only differs from the principles, without contradicting one, stays as it is.
`;

/**
 * One card, as the developer judged it: its change to the original, named as the round page names
 * it, and its verdicts, without the principle, stance or kind generate meant it to test.
 */
const cardSection = (original: string, { card, likes, dislikes }: CardTally) =>
  `### ${card.id}: ${likes} like, ${dislikes} dislike

${card.operation}: ${card.change}

${fence(unifiedDiff(original, card.after, { context: DIFF_CONTEXT_LINES }))}`;

/** The swiped cards. One nobody swiped teaches nothing, so it is left out. */
const cardsSection = (original: string, tallies: readonly CardTally[]) => {
  const swiped = tallies.filter(({ likes, dislikes }) => likes + dislikes > 0);
  if (swiped.length === 0) {
    return 'Nobody swiped a card, so this round teaches nothing: answer no operations and no written-rule edit.';
  }
  return `Each card is the original with one change applied, shown as a unified diff against it: \`-\` lines are the original's, \`+\` lines the card's, the rest unchanged context. Cards nobody swiped aren't listed: they teach nothing.

${swiped.map(tally => cardSection(original, tally)).join('\n\n')}`;
};

const earlierCardLines = (
  side: string,
  { ref, file, operation, change, diff, likes, dislikes }: EarlierCard,
) =>
  `${side}: \`${ref}\`, in \`${file}\`, ${likes} like, ${dislikes} dislike

${operation}: ${change}

${fence(diff)}`;

/**
 * What earlier rounds showed about the doc's principles this round may bear on. It doesn't say
 * which card of this round tested what: learn still judges this round's cards blind.
 */
const evidenceSection = (evidence: readonly PrincipleEvidence[]) => {
  if (evidence.length === 0) return '';
  const principles = evidence.map(({ id, for: confirmed, against, confirming, contradicting }) =>
    [
      `### ${id}: ${confirmed} swipes for, ${against} against`,
      ...(confirming === null ? [] : [earlierCardLines('A card that confirmed it', confirming)]),
      ...(contradicting === null
        ? []
        : [earlierCardLines('A card that contradicted it', contradicting)]),
    ].join('\n\n'),
  );
  return `
## What earlier rounds showed

Some of the doc's principles have been swiped on before. For each, every verdict earlier rounds'
cards got on it, for and against, and the newest earlier card that confirmed it and that
contradicted it, each cited as \`<round>/<card>\`. A card confirms a principle when its swipes
agree with it: a like on a card that follows the principle, or a dislike on one that breaks it.
Weigh this round's swipes against them: a
principle many earlier swipes back isn't refuted by one card here, and one already contradicted
before is weaker than its strength says.

${principles.join('\n\n')}
`;
};

/**
 * The learn task. `writtenRules` are the files of `WRITTEN_RULES_FILES` the project has, which the
 * agent reads itself.
 */
export const learnTask = ({
  current,
  writtenRules,
  round,
  tallies,
  evidence,
}: {
  current: CurrentPrinciples;
  writtenRules: readonly string[];
  round: Round;
  tallies: readonly CardTally[];
  /** Earlier rounds' evidence on the principles this round's cards test. */
  evidence: readonly PrincipleEvidence[];
}): Task<typeof LearnAnswerSchema> => ({
  instructions: `# Learn coding principles from a CodeTinder round

Developers swiped on the cards of one function: like ("I prefer the after") or dislike ("I prefer
the original"). Each card applies one change to it, named as the developers saw it: the
refactoring, and a sentence saying what it changes. Nothing says which principle a change was meant
to test: the developers judged the code and its change, and so do you. Update the project's coding
principles to match their taste.

## The current principles

${currentPrinciplesSection(current)}
${writtenRulesSection(writtenRules)}
## The round

The original, from \`${round.target.file}\`:

${fence(round.target.text)}

${cardsSection(round.target.text, tallies)}
${evidenceSection(evidenceOnDoc(current, evidence))}
## How to update them

You answer with operations on the doc, not the doc: code applies them, and every principle no
operation names stays exactly as it is.

- A like means the developer prefers the card's after; a dislike, the original.
- Find the preferences the swipes show. Read each card's change, and read the cards together too:
  several cards can share a preference that no one of them shows alone.
- Weigh each preference by how many swipes and cards back it, earlier rounds' included. Don't read
  a rule into one card further than it shows: one liked change backs that kind of change, not
  every change near it.
- Swipes pointing both ways on one idea cancel out: a liked card that names a value and a liked
  card that inlines one say nothing about naming values, and neither does a card liked and
  disliked equally. A disliked card that names a value and a liked one that inlines a value both
  point the same way, to inlining.
- When a preference is the same idea as an existing principle, even in other words, it is that
  principle: act on its id.
- When a card contradicts a principle, first ask whether it marks where the principle stops.
  Compare it with the cards that confirm the principle, this round's and the earlier ones above:
  when the contradicting cards share something the confirming ones lack (a value used once, a
  single call, a test file), \`narrow\` the principle. Name that difference, cite the cards on
  each side, and state the exception: where the principle doesn't hold, and what to do there.
  The principle keeps its strength, firm within its scope.
- A narrow needs the cards it cites against the principle to hold at least
  ${MIN_EXCEPTION_SWIPES} swipes, a card's likes and dislikes cancelling out, so one stray swipe
  never makes an exception. A card is cited on one side only. With fewer, \`weaken\` the
  principle instead.
- An exception is its own principle, listed as "except" under its principle: strengthen, weaken,
  reword or drop it by its id like any other, and a tentative one weakened is dropped. A principle
  holds one exception at most: when one that has an exception is contradicted again, \`merge\`
  the exception into it with a statement restating where it holds, or weaken it.
- The operations:
  - \`strengthen\` a principle the round confirms: tentative to moderate, moderate to strong. A
    strong one stays strong.
  - \`weaken\` one the round contradicts: strong to moderate, moderate to tentative. A tentative
    one weakened is dropped.
  - \`drop\` one the swipes clearly refute, or one another principle duplicates.
  - \`merge\` principles that say the same idea into one, under one of their ids, with one
    statement covering them.
  - \`reword\` one whose statement the swipes show is worded wrong: too broad (it claims cases
    the swipes went against), too narrow, or unclear. A reword changes what an agent would do;
    it never just polishes the wording.
  - \`narrow\` a principle to where it holds, adding its exception (it starts tentative).
  - \`add\` a preference no principle states, as a new principle (it starts tentative), with a new
    id: kebab-case, naming the general idea, not this function.
- Make at most ${MAX_OPERATIONS} operations, and at most one per principle. Consider \`drop\`
  and \`merge\` first. Add a principle for a preference the swipes back that no principle states,
  never one that restates a principle in the doc. Operations past the ${MAX_OPERATIONS}th, a
  second one on a principle, or one naming an id the doc doesn't have are not applied.
- The doc holds at most ${MAX_RULES} principles, exceptions included${sizeNote(current)}. When it
  is full, drop or merge enough in the same round to make room before you narrow or add, or the
  narrow or add is not applied.
- Word each new or reworded principle as generally as the swipes support. A first guess that
  turns out wrong is fine: it is tentative, and later rounds refine it.
${sectionGuide(round.target.file)}
- Each statement is one plain instruction a coding agent can follow when writing code, not a
  description of this round.`,
  answerSchema: LearnAnswerSchema,
});
