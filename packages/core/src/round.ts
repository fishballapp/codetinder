import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describedStatement, PrincipleIdSchema } from './principles';
import { type ContextSnippet, ContextSnippetSchema, TargetSchema } from './snippet';

export const StanceSchema = Schema.Literals(['supports', 'opposes']);
export type Stance = typeof StanceSchema.Type;

export const CardKindSchema = Schema.Literals([
  'explore',
  'confirm',
  'challenge',
  'consistency',
  'boundary',
]);
export type CardKind = typeof CardKindSchema.Type;

const CardFields = {
  operation: Schema.NonEmptyString.annotate({
    description:
      "The one operation it applies, named from Fowler's refactoring catalogue where one fits " +
      '("Replace Loop with Pipeline", "Replace Nested Conditional with Guard Clauses") and plainly ' +
      'where none does ("Rename Variable")',
  }),
  change: Schema.NonEmptyString.annotate({
    description: 'What it changed in this function, in one sentence',
  }),
  principle: Schema.Struct({
    id: PrincipleIdSchema.annotate({
      description:
        'A kebab-case id: lowercase letters and digits in words joined by single hyphens, so a name from the code goes in as lowercase words too ("over-is-some", never "over-isSome"). Reuse the id of a project principle or question that tests the same idea, so swipes on different rounds add up',
    }),
    statement: describedStatement(
      'The principle, as one plain instruction a coding agent can follow, on one line',
    ),
  }).annotate({ description: 'The one principle the change tests' }),
  stance: StanceSchema.annotate({
    description: '"supports" when the after follows the principle, "opposes" when it breaks it',
  }),
  kind: CardKindSchema.annotate({
    description:
      '"explore": a principle the project has no view on; "confirm": supports one of its principles ' +
      'the original breaks; "challenge": opposes one the original follows; "consistency": one half ' +
      "of the round's pair, two cards on the same principle with opposite stances, at different spots; " +
      '"boundary": a change right on the line between one of its principles and its exception, ' +
      'under the id of the one that governs that spot',
  }),
  after: Schema.NonEmptyString.annotate({
    description:
      'The whole function with this one change and nothing else, every other line byte-identical, ' +
      'behaving exactly like the original. A helper it extracts goes directly above the function ' +
      'and its leading comment.',
  }),
};

const RoundFields = {
  target: TargetSchema.annotate({ description: 'The picked function, exactly as in its file' }),
  reason: Schema.NonEmptyString.annotate({
    description: "Why this function shows the developer's taste best, in one sentence",
  }),
  context: Schema.Array(ContextSnippetSchema).annotate({
    description:
      'For TypeScript and JavaScript: every definition the function depends on that its file ' +
      'declares or imports by a relative path (types, constants, helpers), and what those use in ' +
      'turn, each exactly as in its file. Empty for other languages.',
  }),
  imports: Schema.Array(Schema.NonEmptyString).annotate({
    description:
      "The import lines for the packages the function and its context use, third-party and the repository's own workspace packages alike, each copied verbatim from the function's file or a context snippet's. Each must resolve from the function's file",
  }),
};

/**
 * The consistency cards, if any, are one pair: two cards on one principle with opposite stances.
 * A round without one still goes ahead; the task asks for it.
 */
const checkConsistencyPair = (
  cards: readonly { kind: CardKind; principle: { id: string }; stance: Stance }[],
) => {
  const [first, second, ...rest] = cards.filter(({ kind }) => kind === 'consistency');
  if (first === undefined) return undefined;
  const isPair =
    second !== undefined &&
    rest.length === 0 &&
    first.principle.id === second.principle.id &&
    first.stance !== second.stance;
  return isPair
    ? undefined
    : 'the consistency cards must be one pair: two cards on one principle, with opposite stances';
};

/** A round tests at most this many exceptions' boundaries, so most of its cards ask something else. */
export const MAX_BOUNDARY_CARDS = 2;

/** At most `MAX_BOUNDARY_CARDS` boundary cards, each on its own rule. */
const checkBoundaryCards = (cards: readonly { kind: CardKind; principle: { id: string } }[]) => {
  const ids = cards.filter(({ kind }) => kind === 'boundary').map(({ principle }) => principle.id);
  if (ids.length > MAX_BOUNDARY_CARDS) {
    return `a round has at most ${MAX_BOUNDARY_CARDS} boundary cards`;
  }
  if (new Set(ids).size !== ids.length) {
    return 'a round has at most one boundary card per principle or exception';
  }
  return undefined;
};

/** The agent's answer to the generate step. */
export const RoundAnswerSchema = Schema.Struct({
  ...RoundFields,
  cards: Schema.Array(Schema.Struct(CardFields))
    // The description goes before the checks: one set after a custom check is lost from the JSON
    // Schema.
    .annotate({
      description:
        "Between 4 and 8 cards, each the original function with one change applied on its own, never on top of another card's",
    })
    .check(
      Schema.isBetweenLength(4, 8),
      Schema.makeFilter(checkConsistencyPair),
      Schema.makeFilter(checkBoundaryCards),
    ),
});
export type RoundAnswer = typeof RoundAnswerSchema.Type;

/** The agent's answer when no function in the merge request qualifies: a decline, with its reason. */
export const DeclinedAnswerSchema = Schema.Struct({
  declined: Schema.NonEmptyString.annotate({
    description: 'Why no function qualifies, in one sentence',
  }),
});

/** What the generate step may answer: a round, or a decline. */
export const GenerateAnswerSchema = Schema.Union([RoundAnswerSchema, DeclinedAnswerSchema]);

const meansToDecline = (answer: unknown): boolean =>
  typeof answer === 'object' && answer !== null && 'declined' in answer;

/**
 * The generate step's answer, from its JSON. It is checked as the one answer it means to be (a
 * decline when it has `declined`, else a round), so an error names only that answer's faults, and
 * all of them, for one correction to fix.
 */
export const decodeGenerateAnswer = (
  json: string,
): Result.Result<typeof GenerateAnswerSchema.Type, Schema.SchemaError> => {
  const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(json);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const answer = parsed.success;
  const schema = meansToDecline(answer) ? DeclinedAnswerSchema : RoundAnswerSchema;
  return Schema.decodeUnknownResult(schema, { errors: 'all' })(answer);
};

/**
 * The generate agents' answers, saved beside `.codetinder/task.md`. Duo's
 * `create_file_with_contents` refuses a file that exists, so the correction answers to its own.
 */
export const ROUND_RUN_FILES = {
  answer: '.codetinder/round-answer.json',
  retryAnswer: '.codetinder/round-retry-answer.json',
} as const;

export const CardSchema = Schema.Struct({ id: Schema.NonEmptyString, ...CardFields });
export type Card = typeof CardSchema.Type;

/** A round needs this many cards that pass the typecheck and tests to be swiped. */
export const MIN_ROUND_CARDS = 3;

/**
 * A round as stored: the answer's cards that passed, with ids. Format 2, one-change cards, is the
 * only one: a stored round of format 1 doesn't decode.
 */
export const RoundSchema = Schema.Struct({
  version: Schema.Literal(2),
  ...RoundFields,
  cards: Schema.Array(CardSchema),
});
export type Round = typeof RoundSchema.Type;

/** `c1`, `c2`, … in order. */
export const assignCardIds = (cards: RoundAnswer['cards']): Card[] =>
  cards.map((card, index) => ({ id: `c${index + 1}`, ...card }));

/**
 * `items` in their order, except that an item moves after those it depends on. Items in a cycle
 * can't all follow each other, so they keep their order among themselves.
 */
const dependenciesFirst = <T>(
  items: readonly T[],
  dependsOn: (item: T, other: T) => boolean,
): T[] => {
  const dependencies = new Map(
    items.map(item => [item, items.filter(other => other !== item && dependsOn(item, other))]),
  );
  const dependenciesOf = (item: T) => dependencies.get(item) ?? [];
  const ordered: T[] = [];
  const isPlaced = (item: T) => ordered.includes(item);
  const isOnCycle = (item: T) => {
    const reached = new Set<T>();
    const reach = (from: T): boolean =>
      dependenciesOf(from)
        .filter(other => !isPlaced(other) && !reached.has(other))
        .some(other => {
          reached.add(other);
          return other === item || reach(other);
        });
    return reach(item);
  };
  while (ordered.length < items.length) {
    const remaining = items.filter(item => !isPlaced(item));
    // When nothing is free to go, the items left wait on a cycle: its first item goes first.
    const next =
      remaining.find(item => dependenciesOf(item).every(isPlaced)) ?? remaining.find(isOnCycle);
    if (next === undefined) throw new Error('no item is free to go, nor on a cycle');
    ordered.push(next);
  }
  return ordered;
};

/** A comment, a string, or a template literal: text the code doesn't reference names in. */
const LITERAL =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g;

/**
 * `text` with its comments, strings and template text blanked out, a template's `${…}` kept.
 * ponytail: a `${…}` holding a brace or a template is cut short; a context snippet's top level
 * rarely holds one.
 */
const codeOf = (text: string): string =>
  text.replaceAll(LITERAL, literal =>
    literal.startsWith('`')
      ? literal.replaceAll(/\$\{([^}]*)\}|[^\n]/g, (_, expression?: string) =>
          expression === undefined ? ' ' : ` ${expression} `,
        )
      : literal.replaceAll(/[^\n]/g, ' '),
  );

/** Whether the name at `index` of `code` is an object literal's key or a parameter's name. */
const isKey = (code: string, index: number, name: string): boolean =>
  /[{,]\s*$/.test(code.slice(0, index)) && /^\s*:/.test(code.slice(index + name.length));

/**
 * Whether `snippet`'s code references `other`'s symbol: the name on its own, not a property after
 * a `.`, not a key, not in a comment or a string.
 * ponytail: a local that shadows the name counts too; it can only move a snippet earlier, which
 * breaks nothing outside a cycle.
 */
const references = (snippet: ContextSnippet, other: ContextSnippet): boolean => {
  const code = codeOf(snippet.text);
  const name = RegExp.escape(other.symbol);
  return code
    .matchAll(new RegExp(`(?<![\\w$])(?<!(?<!\\.)\\.\\s*)${name}(?![\\w$])`, 'g'))
    .some(({ index }) => !isKey(code, index, other.symbol));
};

/**
 * The one file the CLI typechecks for a function: its imports, its context, then the function,
 * separated by blank lines. The context is put in dependency order, whatever order the agent
 * collected it in: a constant used before its declaration fails the typecheck.
 */
export const buildTypecheckFile = ({
  imports,
  context,
  functionText,
}: {
  imports: readonly string[];
  context: readonly ContextSnippet[];
  functionText: string;
}): string =>
  [
    imports.join('\n'),
    ...dependenciesFirst(context, references).map(snippet => snippet.text),
    functionText,
  ]
    .filter(section => section !== '')
    .join('\n\n');
