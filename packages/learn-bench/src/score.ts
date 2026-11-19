import { type Principle, renderPrinciplesDoc, rulesOf, type Strength } from '@codetinder/core';
import type { JudgedCard, RunRecord } from './record';

/**
 * Words that carve a case out of a principle. A statement's count of them, plus its exception if it
 * has one, is how many exceptions it has collected, whatever form learn gave them.
 */
const QUALIFIER = /\b(unless|except|but not|only when|only if|other than|apart from)\b/gi;

const RANK: Record<Strength, number> = { tentative: 0, moderate: 1, strong: 2 };

export type PredictionScore = {
  /** Cards predicted right, wrong, and not at all (no principle applied). */
  readonly correct: number;
  readonly wrong: number;
  readonly abstained: number;
  /** Right among the cards it predicted. */
  readonly accuracy: number;
  /** The share of cards it predicted. */
  readonly coverage: number;
  /** Right minus wrong over every card: a guess costs what it might win. */
  readonly net: number;
};

export const scorePredictions = (cards: readonly JudgedCard[]): PredictionScore => {
  const correct = cards.filter(
    ({ prediction, truth }) => prediction !== 'none' && prediction === truth,
  ).length;
  const abstained = cards.filter(({ prediction }) => prediction === 'none').length;
  const wrong = cards.length - correct - abstained;
  const answered = correct + wrong;
  return {
    correct,
    wrong,
    abstained,
    accuracy: answered === 0 ? 0 : correct / answered,
    coverage: cards.length === 0 ? 0 : answered / cards.length,
    net: cards.length === 0 ? 0 : (correct - wrong) / cards.length,
  };
};

export type Churn = {
  /** A principle's strength turning back: up then down, or down then up. */
  readonly flipFlops: number;
  /** A principle dropped, then added again under its id. */
  readonly readded: number;
  /** A principle's statement rewritten. */
  readonly rewordings: number;
};

/** Each item with the one after it. */
const consecutive = <T>(items: readonly T[]): (readonly [T, T])[] =>
  items.slice(1).flatMap((item, index) => {
    const previous = items[index];
    return previous === undefined ? [] : [[previous, item] as const];
  });

/** How unsettled the doc was across the replay, from each doc in turn. */
export const churnOf = (docs: readonly (readonly Principle[])[]): Churn => {
  const ruleDocs = docs.map(rulesOf);
  const ids = new Set(ruleDocs.flatMap(rules => rules.map(({ id }) => id)));
  const counts = [...ids].map(id => {
    // Absent is null, not undefined, so `consecutive` keeps the gaps.
    const history = ruleDocs.map(rules => rules.find(rule => rule.id === id) ?? null);
    const present = history.filter(principle => principle !== null);
    const moves = consecutive(present)
      .map(([before, after]) => RANK[after.strength] - RANK[before.strength])
      .filter(move => move !== 0);
    const sinceAdded = history.slice(history.findIndex(principle => principle !== null));
    return {
      flipFlops: consecutive(moves).filter(
        ([before, after]) => Math.sign(before) !== Math.sign(after),
      ).length,
      readded: consecutive(sinceAdded).filter(
        ([before, after]) => before === null && after !== null,
      ).length,
      rewordings: consecutive(present).filter(
        ([before, after]) => before.statement !== after.statement,
      ).length,
    };
  });
  return {
    flipFlops: sum(counts.map(({ flipFlops }) => flipFlops)),
    readded: sum(counts.map(({ readded }) => readded)),
    rewordings: sum(counts.map(({ rewordings }) => rewordings)),
  };
};

export type DocSize = {
  readonly principles: number;
  readonly lines: number;
  /** Exceptions over principles, exception principles counted: how much each rule is carved up. */
  readonly qualifiersPerPrinciple: number;
  /** The most exceptions any one principle holds. */
  readonly maxQualifiers: number;
};

export const sizeOf = (principles: readonly Principle[]): DocSize => {
  const qualifiers = principles.map(
    ({ statement, exception }) =>
      (statement.match(QUALIFIER)?.length ?? 0) + (exception === undefined ? 0 : 1),
  );
  return {
    principles: rulesOf(principles).length,
    lines: renderPrinciplesDoc(principles).trimEnd().split('\n').length,
    qualifiersPerPrinciple: principles.length === 0 ? 0 : sum(qualifiers) / principles.length,
    maxQualifiers: Math.max(0, ...qualifiers),
  };
};

export type RunScore = {
  readonly prediction: PredictionScore;
  /** On a simulated developer: only the cards their hidden rule decides. */
  readonly ruleCards: PredictionScore;
  readonly finalDoc: DocSize;
  readonly churn: Churn;
  readonly learnFailures: number;
};

/**
 * A replay's score. The first round is judged from an empty doc, the same for every learner, so
 * it is left out.
 */
export const scoreRun = ({ steps }: RunRecord): RunScore => {
  const judged = steps.slice(1).flatMap(({ judged }) => judged);
  return {
    prediction: scorePredictions(judged),
    ruleCards: scorePredictions(judged.filter(({ isRuleCard }) => isRuleCard)),
    finalDoc: sizeOf(steps.at(-1)?.principles ?? []),
    churn: churnOf(steps.map(({ principles }) => principles)),
    learnFailures: steps.filter(({ isLearnFailed }) => isLearnFailed).length,
  };
};

const sum = (numbers: readonly number[]) => numbers.reduce((total, number) => total + number, 0);
