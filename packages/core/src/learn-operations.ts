import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { WrittenRuleEditSchema } from './agent-instructions';
import type { PrincipleEvidence } from './principle-evidence';
import {
  type CurrentPrinciples,
  describedStatement,
  type Exception,
  type Principle,
  PrincipleIdSchema,
  PrinciplesSchema,
  rulesOf,
  SectionSchema,
  type Strength,
  StrengthSchema,
} from './principles';
import type { CardTally } from './swipes';

/** The most operations one round makes: a round moves the doc a little, never rewrites it. */
export const MAX_OPERATIONS = 4;

/**
 * The most principles a doc holds, exceptions included: past it, a round drops or merges one before
 * it adds one. An agent reads the whole doc; this one's dogfooded doc settled near 16.
 */
export const MAX_RULES = 20;

/** The swipes an exception needs behind it, so one stray swipe never makes one. */
export const MIN_EXCEPTION_SWIPES = 2;

const existingId = (description: string) =>
  PrincipleIdSchema.annotate({ description: `The id of a principle in the doc ${description}` });

const sectionField = SectionSchema.annotate({
  description:
    '"General" for a principle that holds in any language; a language for one that only makes ' +
    "sense in that language's code",
});

const AddSchema = Schema.Struct({
  op: Schema.Literal('add'),
  id: PrincipleIdSchema.annotate({
    description:
      'A new kebab-case id naming the general idea, not this function, unused in the doc, e.g. "early-returns"',
  }),
  section: sectionField,
  statement: describedStatement('One plain instruction a coding agent can follow, on one line'),
});

const StrengthenSchema = Schema.Struct({
  op: Schema.Literal('strengthen'),
  id: existingId('the swipes confirm'),
});

const WeakenSchema = Schema.Struct({
  op: Schema.Literal('weaken'),
  id: existingId('the swipes contradict'),
});

const DropSchema = Schema.Struct({
  op: Schema.Literal('drop'),
  id: existingId('to remove: the swipes refute it, or another principle says the same'),
});

const MergeSchema = Schema.Struct({
  op: Schema.Literal('merge'),
  id: existingId('that stays, with its strength, stating them all'),
  merged: Schema.Array(existingId('that says the same idea, removed into the one that stays'))
    .annotate({ description: 'The principles merged into it, at least one' })
    .check(Schema.isMinLength(1)),
  statement: describedStatement('The one statement that now covers them all, on one line'),
});

const NarrowSchema = Schema.Struct({
  op: Schema.Literal('narrow'),
  id: existingId(
    'that some cards confirm and others contradict: a principle, not an exception, holding no exception yet',
  ),
  exception: Schema.Struct({
    id: PrincipleIdSchema.annotate({
      description: 'A new kebab-case id for the exception, unused in the doc',
    }),
    statement: describedStatement(
      'Where the principle does not hold and what to do there instead, on one line',
    ),
  }),
  difference: Schema.NonEmptyString.annotate({
    description:
      'What the contradicting cards share that the confirming ones lack, in one sentence',
  }),
  confirming: Schema.Array(Schema.String).annotate({
    description:
      'The cards that confirm the principle: this round\'s by id ("c2"), an earlier round\'s by its reference ("<round>/<card>")',
  }),
  contradicting: Schema.Array(Schema.String).annotate({
    description: `The cards that show the exception, cited the same way; their swipes, less those that cancel out on a card, must add up to at least ${MIN_EXCEPTION_SWIPES}`,
  }),
});

const RewordSchema = Schema.Struct({
  op: Schema.Literal('reword'),
  id: existingId('whose statement the swipes show is worded wrong'),
  section: sectionField,
  statement: describedStatement('Its new statement, on one line'),
});

export const OperationSchema = Schema.Union([
  AddSchema,
  StrengthenSchema,
  WeakenSchema,
  DropSchema,
  MergeSchema,
  NarrowSchema,
  RewordSchema,
]);
export type Operation = typeof OperationSchema.Type;

/** An operation `applyOperations` didn't apply, and why. */
export const SkippedOperationSchema = Schema.Struct({
  operation: OperationSchema,
  reason: Schema.String,
});
export type SkippedOperation = typeof SkippedOperationSchema.Type;

/** The ids an operation acts on: a principle gets one operation a round. */
const idsOf = (operation: Operation): string[] => {
  if (operation.op === 'merge') return [operation.id, ...operation.merged];
  if (operation.op === 'narrow') return [operation.id, operation.exception.id];
  return [operation.id];
};

const STRENGTHS = StrengthSchema.literals;

/** The next strength up or down; undefined below tentative. */
const shift = (strength: Strength, by: 1 | -1): Strength | undefined =>
  STRENGTHS[Math.min(STRENGTHS.indexOf(strength) + by, STRENGTHS.length - 1)];

/** The order operations apply in: removals first, so a narrow or an add finds the room they free. */
const ORDER: Record<Operation['op'], number> = {
  drop: 0,
  merge: 1,
  weaken: 2,
  strengthen: 3,
  reword: 4,
  narrow: 5,
  add: 6,
};

type Statement = Pick<Exception, 'id' | 'strength' | 'statement'>;

/**
 * The doc with the rule `id` updated: a principle or an exception. Updated to undefined, it is
 * removed, a principle with its exception.
 */
const updateRule = (
  principles: readonly Principle[],
  id: string,
  update: <R extends Statement>(rule: R) => R | undefined,
): Principle[] =>
  principles.flatMap(principle => {
    if (principle.id === id) {
      const updated = update(principle);
      return updated === undefined ? [] : [updated];
    }
    if (principle.exception?.id !== id) return [principle];
    const { exception: _, ...withoutException } = principle;
    const exception = update(principle.exception);
    return [exception === undefined ? withoutException : { ...principle, exception }];
  });

const removeRules = (principles: readonly Principle[], ids: readonly string[]) =>
  ids.reduce<Principle[]>((doc, id) => updateRule(doc, id, () => undefined), [...principles]);

type Applied = { readonly principles: Principle[] } | { readonly skipped: string };

const isFull = (principles: readonly Principle[]) => rulesOf(principles).length >= MAX_RULES;

const full = (principles: readonly Principle[]) =>
  `the doc holds ${rulesOf(principles).length} principles, and ${MAX_RULES} at most: drop or merge to make room first`;

const applyOne = (principles: readonly Principle[], operation: Operation): Applied => {
  // An exception goes with its principle: an operation on it after a drop, merge or weaken took
  // the principle this round has nothing left to act on.
  const isGone =
    operation.op !== 'add' && !rulesOf(principles).some(({ id }) => id === operation.id);
  if (isGone) return { skipped: `"${operation.id}" went with its principle, removed this round` };
  switch (operation.op) {
    case 'add': {
      if (isFull(principles)) return { skipped: full(principles) };
      const { id, section, statement } = operation;
      return { principles: [...principles, { id, section, strength: 'tentative', statement }] };
    }
    case 'narrow': {
      if (isFull(principles)) return { skipped: full(principles) };
      const { id, exception } = operation;
      return {
        principles: principles.map(principle =>
          principle.id === id
            ? { ...principle, exception: { ...exception, strength: 'tentative' } }
            : principle,
        ),
      };
    }
    case 'strengthen':
      return {
        principles: updateRule(principles, operation.id, rule => ({
          ...rule,
          strength: shift(rule.strength, 1) ?? rule.strength,
        })),
      };
    case 'weaken':
      return {
        principles: updateRule(principles, operation.id, rule => {
          const strength = shift(rule.strength, -1);
          return strength === undefined ? undefined : { ...rule, strength };
        }),
      };
    case 'drop':
      return { principles: removeRules(principles, [operation.id]) };
    case 'merge': {
      const { id, merged, statement } = operation;
      return {
        principles: removeRules(principles, merged).map(principle =>
          principle.id === id ? { ...principle, statement } : principle,
        ),
      };
    }
    case 'reword': {
      const { id, section, statement } = operation;
      return {
        principles: principles.map(principle => {
          if (principle.id === id) return { ...principle, section, statement };
          if (principle.exception?.id !== id) return principle;
          return { ...principle, exception: { ...principle.exception, statement } };
        }),
      };
    }
  }
};

/**
 * Why a narrow can't apply, if it can't: it must cite a card each way, every card one learn was
 * shown, and the contradicting cards must hold enough swipes to make an exception.
 */
const narrowRefusal = (
  { confirming, contradicting }: Extract<Operation, { readonly op: 'narrow' }>,
  citations: ReadonlyMap<string, number>,
): string | undefined => {
  const unknown = [...confirming, ...contradicting].find(ref => !citations.has(ref));
  if (unknown !== undefined) return `it cites "${unknown}", which is no card learn was shown`;
  if (confirming.length === 0) return 'it cites no card that confirms the principle';
  const bothWays = contradicting.find(ref => confirming.includes(ref));
  if (bothWays !== undefined) return `it cites "${bothWays}" both for and against the principle`;
  // Each card once: citing a card twice doesn't double its swipes.
  const swipes = sum([...new Set(contradicting)].map(ref => citations.get(ref) ?? 0));
  if (swipes < MIN_EXCEPTION_SWIPES) {
    const swipeNoun = swipes === 1 ? 'swipe' : 'swipes';
    return `the cards it cites against the principle hold ${swipes} ${swipeNoun}; an exception needs ${MIN_EXCEPTION_SWIPES}`;
  }
  return undefined;
};

/** Why `operation` can't apply to the doc as the round found it, if it can't. */
const refusal = (
  doc: readonly Principle[],
  operation: Operation,
  {
    touched,
    index,
    citations,
  }: {
    readonly touched: ReadonlySet<string>;
    readonly index: number;
    readonly citations: ReadonlyMap<string, number>;
  },
): string | undefined => {
  if (index >= MAX_OPERATIONS) return `a round makes at most ${MAX_OPERATIONS} operations`;
  const ids = idsOf(operation);
  const repeated = ids.find((id, position) => touched.has(id) || ids.indexOf(id) !== position);
  if (repeated !== undefined) return `"${repeated}" already has an operation this round`;
  const rules = rulesOf(doc);
  const ruleOf = (id: string) => rules.find(rule => rule.id === id);
  const newIds = (() => {
    if (operation.op === 'add') return [operation.id];
    if (operation.op === 'narrow') return [operation.exception.id];
    return [];
  })();
  const taken = newIds.find(id => ruleOf(id) !== undefined);
  if (taken !== undefined) return `"${taken}" is already in the doc`;
  const missing = ids.find(id => !newIds.includes(id) && ruleOf(id) === undefined);
  if (missing !== undefined) return `"${missing}" is not in the doc`;

  const parentId = ruleOf(operation.id)?.parentId;
  if (operation.op === 'merge' && parentId !== undefined) {
    return `"${operation.id}" is an exception: merge into its principle`;
  }
  if (operation.op === 'merge') {
    // Only a principle's own exception merges into it; one merged away takes its exception along.
    const foreign = operation.merged.find(id => {
      const mergedParent = ruleOf(id)?.parentId;
      return (
        mergedParent !== undefined &&
        mergedParent !== operation.id &&
        !operation.merged.includes(mergedParent)
      );
    });
    if (foreign !== undefined) return `"${foreign}" is another principle's exception`;
    const orphaned = operation.merged.find(id => {
      const exceptionId = doc.find(principle => principle.id === id)?.exception?.id;
      return exceptionId !== undefined && !operation.merged.includes(exceptionId);
    });
    if (orphaned !== undefined) {
      return `"${orphaned}" holds an exception: merge that into it, restated, first`;
    }
  }
  if (operation.op === 'reword' && parentId !== undefined) {
    const parent = ruleOf(parentId);
    return parent?.section === operation.section
      ? undefined
      : `"${operation.id}" is an exception: it stays in its principle's section`;
  }
  if (operation.op !== 'narrow') return undefined;
  if (parentId !== undefined) {
    return `"${operation.id}" is an exception: restate its principle instead`;
  }
  const hasException = doc.find(({ id }) => id === operation.id)?.exception !== undefined;
  if (hasException) {
    return `"${operation.id}" holds an exception already: merge it into the principle, restated, first`;
  }
  return narrowRefusal(operation, citations);
};

/**
 * The doc after a learn round's operations, and those it skipped with why. `citations` are the
 * cards learn was shown, each with its swipes, by how it cites them. The checks run in the answer's
 * order (the first 4, one per principle); the operations then apply in `ORDER`, and an add or a
 * narrow that would take the doc past `MAX_RULES` is skipped. A principle no operation names stays
 * as it is.
 */
export const applyOperations = (
  doc: readonly Principle[],
  operations: readonly Operation[],
  citations: ReadonlyMap<string, number>,
): { readonly principles: Principle[]; readonly skipped: SkippedOperation[] } => {
  const { accepted, skipped } = operations.reduce(
    (checked, operation, index) => {
      const reason = refusal(doc, operation, { touched: checked.touched, index, citations });
      if (reason !== undefined) {
        return { ...checked, skipped: [...checked.skipped, { operation, reason }] };
      }
      return {
        accepted: [...checked.accepted, operation],
        skipped: checked.skipped,
        touched: checked.touched.union(new Set(idsOf(operation))),
      };
    },
    {
      accepted: [] as Operation[],
      skipped: [] as SkippedOperation[],
      touched: new Set<string>(),
    },
  );
  return accepted
    .toSorted((left, right) => ORDER[left.op] - ORDER[right.op])
    .reduce(
      ({ principles, skipped: skippedSoFar }, operation) => {
        const applied = applyOne(principles, operation);
        if ('skipped' in applied) {
          return { principles, skipped: [...skippedSoFar, { operation, reason: applied.skipped }] };
        }
        return { principles: applied.principles, skipped: skippedSoFar };
      },
      { principles: [...doc], skipped },
    );
};

/** The evidence learn is shown: on the doc's principles and exceptions, none on a doc to convert. */
export const evidenceOnDoc = (
  current: CurrentPrinciples,
  evidence: readonly PrincipleEvidence[],
): PrincipleEvidence[] => {
  if (current._tag !== 'Parsed') return [];
  const ids = new Set(rulesOf(current.principles).map(({ id }) => id));
  return evidence.filter(({ id }) => ids.has(id));
};

/** A card's swipes less those that cancel out: a like and a dislike on one card say nothing. */
const decisiveSwipes = ({
  likes,
  dislikes,
}: {
  readonly likes: number;
  readonly dislikes: number;
}) => Math.abs(likes - dislikes);

/**
 * The cards a learn task shows, by how learn cites them, each with its swipes: this round's swiped
 * cards by id, and the evidence's earlier cards by reference.
 */
export const citationsOf = ({
  tallies,
  evidence,
}: {
  readonly tallies: readonly CardTally[];
  readonly evidence: readonly PrincipleEvidence[];
}): Map<string, number> =>
  new Map([
    ...tallies
      .filter(({ likes, dislikes }) => likes + dislikes > 0)
      .map(({ card, likes, dislikes }) => [card.id, decisiveSwipes({ likes, dislikes })] as const),
    ...evidence
      .flatMap(({ confirming, contradicting }) => [confirming, contradicting])
      .filter(card => card !== null)
      .map(({ ref, likes, dislikes }) => [ref, decisiveSwipes({ likes, dislikes })] as const),
  ]);

/** The cards learn could cite, as `task learn` keeps them for `render`. */
export const CitationsSchema = Schema.Record(Schema.String, Schema.Int);

const sum = (numbers: readonly number[]) => numbers.reduce((total, number) => total + number, 0);

/** What a learn run learned, as `render` applied it: what `propose` commits and reports. */
export const LearnedSchema = Schema.Struct({
  principles: PrinciplesSchema,
  skipped: Schema.Array(SkippedOperationSchema),
  writtenRuleEdits: Schema.Array(WrittenRuleEditSchema),
});
export type Learned = typeof LearnedSchema.Type;

/**
 * The learn agent's answer applied to the doc the run started from: to its principles, or to
 * those the agent converted from a doc out of CodeTinder's format.
 */
export const applyLearnAnswer = (
  current: CurrentPrinciples,
  {
    converted,
    operations,
    writtenRuleEdits,
  }: {
    readonly converted?: readonly Principle[];
    readonly operations: readonly Operation[];
    readonly writtenRuleEdits: Learned['writtenRuleEdits'];
  },
  citations: ReadonlyMap<string, number>,
): Result.Result<Learned, string> => {
  const doc = current._tag === 'Parsed' ? current.principles : converted;
  if (doc === undefined) {
    return Result.fail('the doc was out of format, and the answer converted none of its rules');
  }
  return Result.succeed({ ...applyOperations(doc, operations, citations), writtenRuleEdits });
};
