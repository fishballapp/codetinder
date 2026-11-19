import { fence } from './fence';
import { describeAge, isResting, REST_ROUNDS } from './freshness';
import { languagesOf } from './languages';
import { type Principle, principlesFor, rulesOf } from './principles';
import type { Question } from './questions';
import { GenerateAnswerSchema, MAX_BOUNDARY_CARDS } from './round';
import { evidence } from './swipes';
import { renderPrinciples, type Task } from './tasks';

/** A question's swipes so far, as evidence for and against its principle. */
const renderTally = ({ supports, opposes }: Question) => {
  const fromSupporting = evidence({ stance: 'supports', ...supports });
  const fromOpposing = evidence({ stance: 'opposes', ...opposes });
  const tally = {
    for: fromSupporting.for + fromOpposing.for,
    against: fromSupporting.against + fromOpposing.against,
  };
  return tally.for + tally.against === 0
    ? 'not swiped yet'
    : `${tally.for} for, ${tally.against} against`;
};

const renderQuestions = (questions: readonly Question[]) =>
  questions.length === 0
    ? '(none)'
    : questions
        .map(
          question =>
            `- ${question.id}: ${question.statement} (${describeAge(question.roundsSinceJudged)}; ${renderTally(question)})`,
        )
        .join('\n');

/** Each principle that holds an exception, with it: the boundaries a round's cards can test. */
const renderExceptions = (principles: readonly Principle[]) => {
  const exceptions = principles.flatMap(({ id, statement, exception }) =>
    exception === undefined
      ? []
      : [
          `- \`${exception.id}\`, the exception to \`${id}\`
  - principle: ${statement}
  - exception: ${exception.statement}`,
        ],
  );
  if (exceptions.length === 0) {
    return 'None of the principles above holds an exception, so there are no boundary cards.';
  }
  return exceptions.join('\n');
};

/**
 * The generate task: pick one function of the merge request and write its one-change cards.
 * `principles` are the project's; it is shown only the general ones and those for the languages of
 * `mergeRequestFiles`. `questions` are every principle the project's cards have tested; those the
 * doc holds are settled, exceptions included, the rest open. Those judged in the project's latest
 * judged rounds rest. A principle's exception is a boundary its cards can test.
 */
export const generateTask = ({
  mergeRequestIid,
  diff,
  mergeRequestFiles,
  principles: allPrinciples,
  questions,
}: {
  mergeRequestIid: number;
  diff: string;
  mergeRequestFiles: readonly string[];
  principles: readonly Principle[];
  questions: readonly Question[];
}): Task<typeof GenerateAnswerSchema> => {
  const principles = principlesFor(allPrinciples, languagesOf(mergeRequestFiles));
  const settledIds = new Set(rulesOf(allPrinciples).map(({ id }) => id));
  const restingQuestions = questions.filter(({ roundsSinceJudged }) =>
    isResting(roundsSinceJudged),
  );
  const openQuestions = questions.filter(
    ({ id, roundsSinceJudged }) => !settledIds.has(id) && !isResting(roundsSinceJudged),
  );
  return {
    instructions: `# Generate a CodeTinder round for merge request !${mergeRequestIid}

CodeTinder learns a developer's code taste from swipes. A round is one function from this merge
request, shown as cards: each card is the function with one small change, and the developer
swipes like ("I prefer the after") or dislike ("I prefer the original"). They judge the code
alone: the principle behind a card is never shown to them.

So each card is a controlled experiment on one question of taste. A card that changes two things
can't tell which one the developer reacted to; a card nobody could hold an opinion on wastes a
swipe; a card that changes behaviour is a bug.

The merge request's source branch is checked out.

## Pick the function

1. Read the merge request's diff below.
2. Pick ONE function the merge request adds or changes whose style is open to taste (branching,
   naming, data flow, error handling) and with room for at least 4 different changes. Skip
   trivial functions and generated code. Among those, prefer the function whose changes can ask
   worthwhile, varied questions that are not resting (see the questions below): a function that
   could only repeat what rested questions ask is a poor pick, and one with a spot on an
   exception's boundary (see where the exceptions stop, below) is a good one. If none qualifies,
   don't pick one from elsewhere: answer with \`declined\` and the reason instead, and stop.
3. Name the function (\`symbol\`) and copy its text verbatim from \`read_file\` output (never from
   the diff): every character, whitespace and line ending. Start at its leading comment (the doc
   comment or comment lines directly above it) and any decorators if it has them, else at its
   first line, and end at its last line. The text must appear exactly once in the file.
4. For TypeScript and JavaScript, list as context every definition the function uses that its
   file declares or imports by a relative path (types, interfaces, constants, helpers), and what
   those use in turn, each copied exactly from its own file with \`read_file\`. What the function
   or its context imports from a package, a third-party one or one of this repository's own
   workspace packages, isn't context: give its import line instead, copied verbatim from the file
   that imports it, the function's or a context snippet's. CodeTinder writes the imports, the
   context and the function into one file beside the function's and typechecks it, so each import
   must resolve from there. For other languages, leave context and imports empty.

## Write the cards

Write 4 to 8 cards. Each card is the original function with ONE change applied on its own: every
card starts from the original, never from another card.

- **One operation.** Name it from Martin Fowler's refactoring catalogue where one fits (Extract
  Function, Inline Variable, Extract Variable, Replace Loop with Pipeline, Replace Nested
  Conditional with Guard Clauses, Decompose Conditional, Consolidate Conditional Expression, Split
  Variable, Replace Temp with Query, …) and plainly where none does (Rename Variable, Arrow
  Function to Function Declaration, Ternary to If/Else, Optional Chaining, Destructure Parameter,
  Switch to Lookup Table, …). An operation may touch several lines, but only for its one idea:
  Rename Variable renames every use and changes nothing else. A change that needs a second
  operation to read well is two cards, or none.
- **Everything else byte-identical.** Every line the operation doesn't need stays exactly as it
  was: whitespace, quotes, semicolons, comments, blank lines. Keep a comment the change doesn't
  make wrong, and move it with its code.
- **Small and local.** Change one spot (a condition, a loop, an expression, a block), not the
  whole body; in a long function, pick the spot. Spread the cards over different spots.
- **Behaviour identical.** The after behaves exactly like the original for every input: the same
  results, side effects, errors and error messages, and the same evaluation order where it can
  be observed. It keeps the function's name, parameters, return type and export. It is swapped
  into the file and the project's typecheck and tests run on it; a card that fails is dropped.
- **Natural, and a real question of taste.** The after is code a competent developer could write
  and defend, on branching, naming, data flow, mutation, decomposition, error handling, or
  expression versus statement. Never a strawman made worse to invite a dislike. Never a change a
  formatter or linter would settle: whitespace, indentation, quotes, semicolons, trailing commas,
  braces around a one-line body, import order. CodeTinder can't learn taste from those.
- **A helper goes above.** An operation that extracts a helper (Extract Function, a constant moved
  out of the function) puts its definition at the top of \`after\`, then a blank line, then the
  function from its leading comment on, so the helper lands directly above the function and its
  comment. Use only what the file already imports or declares and the language's standard
  library: no new imports.

## What each card tests

Each card tests one **principle**: an \`id\` (lowercase kebab-case, a name from the code in
lowercase words too: \`over-is-some\`, never \`over-isSome\`) and a one-line \`statement\` a
coding agent could follow, worded to hold in any function ("Name a compound condition before
branching on it"), not only in this one. Its \`stance\` says how the after relates to it: \`supports\` when the after
follows it where the original doesn't, \`opposes\` when the after breaks it where the original
follows it. A like counts for the principle on a supporting card and against it on an opposing
one.

**Reuse ids.** One idea keeps one id in every round, or its swipes never add up. Before you name
a principle, look for the same idea among the project's principles and the questions below,
resting ones included; if one tests it, even in other words, use its id and its statement
exactly. Only a new idea gets a new id, and then a general one (\`name-intermediate-values\`, not
\`name-the-overdue-check\`), the id another round would give it too.

**Keep the round fresh.** A question judged in one of the project's last ${REST_ROUNDS} judged rounds
(age 0 to ${REST_ROUNDS - 1}) is resting: the developer has just answered it. At least half of your
cards must ask questions that are not resting (a new id counts), and CodeTinder drops the cards on
resting questions beyond as many as the others, the most recently judged first. So re-ask a
resting question only where this function offers a natural change for it, and never relabel a
resting idea under a new id: a card on the same idea as a resting question, under any id, counts
as resting, so reuse its id. Among the resting questions you do re-ask, prefer the longest-rested
(the highest age) and the most split.

Each card's \`kind\`:

- \`confirm\`: the after supports one of the project's principles, under its id, where the
  original breaks it.
- \`challenge\`: the after opposes one of the project's principles, under its id, where the
  original follows it, still as natural code a developer could prefer.
- \`explore\`: the after tests an open question, one the project holds no principle on. Never a
  settled question, one a principle below already covers, under its id or in other words: test
  that with a confirm or challenge card instead.
- \`consistency\`: one half of a pair. The two halves test the same principle, under one id, with
  opposite stances, at different spots: one supports it where the original breaks it, the other
  opposes it where the original follows it. A developer who likes both, or dislikes both, has no
  preference between them, and their two votes cancel out.
- \`boundary\`: the after changes a spot right on the line between one of the project's
  exceptions (listed below) and its principle. It tests the rule that governs that spot as the
  doc words it, under that rule's id and statement exactly: the exception's at a spot the
  exception only just covers, the principle's at a spot it only just misses. Its stance is toward
  that rule, as on any card.

The round's mix is yours to choose from what this function offers. A consistency pair is
optional: write one only where two natural spots exist for the same principle, and then never
always the same kind of idea (naming a value versus inlining it, guard clauses versus nesting, a
pipeline versus a loop, a helper versus inline logic, a lookup table versus a branch chain,
destructuring versus property access, a ternary versus \`if\`/\`else\`). Confirm and challenge cards
are welcome where the code allows, and a challenge card is how a strong principle gets checked for
drift, but none is required. So is a boundary card: deal one only where the function has a spot
for it. Apart from the pair, never two cards on one principle. Order the cards for swiping: vary the
kind of change from one card to the next, and keep the pair's halves apart.

## Check each card before you answer

Apply its operation to the original: is the result exactly its after, every other line
byte-identical? Does it behave the same for every input? Is it one idea, not two? Is it more than
a formatter or linter would do? Does its kind fit its principle: explore only on an open
question, confirm or challenge only on one of the project's principles, boundary only on an
exception listed below or its principle, whichever governs the spot, one per exception? Does it
reuse the id an existing principle or question has for its idea? Do at least half of the cards
ask questions that are not resting? Fix or drop a card that fails, and keep at least 4.

## The project's coding principles

${
  principles.length === 0
    ? 'None yet, so there are no confirm or challenge cards.'
    : `Only the General ones and those in the function's language's section apply to it. One that
is also listed among the resting questions below is resting.

${renderPrinciples(principles)}`
}

## Where the exceptions stop

An exception says where its principle doesn't hold and what to do there instead. Where this
function has a natural spot right on the line between an exception and its principle, deal a
\`boundary\` card there: at most one per exception and ${MAX_BOUNDARY_CARDS} in the round. Read the
exception's words closely and find a case it only just covers or only just misses. For "a value
used once that is a single call stays inline", a value used once that is one call with a long
argument list is just inside, so the card tests the exception; one that combines two calls is
just outside, so it tests the principle. Change the spot either way: name the value where the
original inlines it, or inline it where the original names it. A swipe that agrees with the doc's
wording counts for the rule the card tests; one that disagrees shows the exception should widen
or shrink. A spot well inside the exception, or well outside it, is a confirm or challenge card
instead. Where the function has such a spot, deal the boundary card before any other card on that
principle or exception, a consistency pair included: the rest ask what the doc already says. A
boundary card counts toward the freshness budget like any other card: it rests when the id it
tests does. Where the function has no such spot, deal none.

${renderExceptions(principles)}

## The project's resting questions

Principles earlier rounds' cards tested, whether or not the project holds a principle on them,
that were judged in one of its last ${REST_ROUNDS} judged rounds. Age counts the judged rounds since:
0 is the latest. Their swipes: "for" counts the swipes that preferred the code following the
principle, "against" those that preferred the code breaking it.

${renderQuestions(restingQuestions)}

## The project's open questions

Principles earlier rounds' cards tested that the project holds no view on yet and that are not
resting, newest first, with their age and swipes.

${renderQuestions(openQuestions)}

## The diff

${fence(diff)}`,
    answerSchema: GenerateAnswerSchema,
  };
};
