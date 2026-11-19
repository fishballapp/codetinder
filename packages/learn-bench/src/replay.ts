import {
  type Principle,
  principleEvidence,
  type Round,
  tallyVerdicts,
  testedPrinciples,
  type Verdict,
  type Verdicts,
} from '@codetinder/core';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Random from 'effect/Random';
import type { Dataset, JudgedRound } from './dataset';
import { judgeTask } from './judge';
import { LEARNERS, type Learner } from './learners';
import { ask, MODELS } from './model';
import type { Developer, JudgedCard, RunRecord, Step } from './record';
import type { SimulatedVerdicts } from './simulated';

const FLIPPED: Record<Verdict, Verdict> = { like: 'dislike', dislike: 'like' };

/** Each card's swipe by the developers' majority; a tie says nothing, so it isn't scored. */
const truthOf = (verdicts: readonly Verdicts[]): ReadonlyMap<string, Verdict> => {
  const cardIds = new Set(verdicts.flatMap(Object.keys));
  return new Map(
    [...cardIds].flatMap(cardId => {
      const given = verdicts.map(byCard => byCard[cardId]);
      const lead =
        given.filter(verdict => verdict === 'like').length -
        given.filter(verdict => verdict === 'dislike').length;
      if (lead === 0) return [];
      return [[cardId, lead > 0 ? 'like' : 'dislike'] as const];
    }),
  );
};

/** Each swipe flipped with probability `noise`, from the run's seeded random. */
const withNoise = (verdicts: readonly Verdicts[], noise: number) =>
  Effect.forEach(
    verdicts,
    byCard =>
      Effect.forEach(
        Object.entries(byCard),
        ([cardId, verdict]) =>
          Random.next.pipe(
            Effect.map(draw => [cardId, draw < noise ? FLIPPED[verdict] : verdict] as const),
          ),
        { concurrency: 1 },
      ).pipe(Effect.map(entries => Object.fromEntries(entries))),
    { concurrency: 1 },
  );

/** A round as learn saw its swipes, which later rounds' evidence reads. */
type LearnedRound = {
  readonly id: string;
  readonly round: Round;
  readonly swipes: readonly { readonly verdicts: Verdicts }[];
};

/**
 * One round: judged from the doc so far, then learned into the next doc, with the evidence
 * codetinder.dev would give from the rounds learned before it, newest first.
 */
const step = Effect.fn('replay.step')(function* ({
  principles,
  earlier,
  judgedRound,
  learner,
  developer,
  noise,
  simulated,
}: {
  principles: readonly Principle[];
  earlier: readonly LearnedRound[];
  judgedRound: JudgedRound;
  learner: Learner;
  developer: Developer;
  noise: number;
  simulated: SimulatedVerdicts;
}) {
  const { round } = judgedRound;
  const decided = developer === 'simulated' ? (simulated[judgedRound.id] ?? {}) : {};
  const verdicts = judgedRound.verdicts.map(byCard => ({ ...byCard, ...decided }));
  const truth = truthOf(verdicts);
  const cards = round.cards.filter(({ id }) => truth.has(id));
  const learnVerdicts = yield* withNoise(verdicts, noise);
  const learnSwipes = learnVerdicts.map(byCard => ({ verdicts: byCard }));
  const tallies = tallyVerdicts(round, learnSwipes);
  const evidence = principleEvidence({ principleIds: testedPrinciples(round), rounds: earlier });

  const [answer, learned] = yield* Effect.all(
    [
      ask(MODELS.judge, judgeTask({ principles, round, cards })),
      LEARNERS[learner].learn({ principles, round, tallies, evidence }).pipe(Effect.option),
    ],
    { concurrency: 2 },
  );

  const judged = cards.flatMap((card): JudgedCard[] => {
    const verdict = truth.get(card.id);
    if (verdict === undefined) return [];
    const predicted = answer.cards.find(({ id }) => id === card.id);
    return [
      {
        cardId: card.id,
        truth: verdict,
        prediction: predicted?.prediction ?? 'none',
        principleId: predicted?.principleId ?? null,
        isRuleCard: card.id in decided,
      },
    ];
  });
  return {
    step: {
      roundId: judgedRound.id,
      judged,
      principles: Option.getOrElse(learned, () => principles),
      isLearnFailed: Option.isNone(learned),
    } satisfies Step,
    learnedRound: { id: judgedRound.id, round, swipes: learnSwipes } satisfies LearnedRound,
  };
});

/**
 * Replays a project's judged rounds in order, from an empty doc. Learn and the judge see each
 * round at once: the judge with the doc learned before it, learn to make the next one.
 */
export const replay = Effect.fn('replay')(function* ({
  dataset,
  label,
  learner,
  developer,
  noise,
  seed,
  simulated,
}: {
  dataset: Dataset;
  label: string;
  learner: Learner;
  developer: Developer;
  noise: number;
  seed: number;
  simulated: SimulatedVerdicts;
}) {
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const { steps } = yield* Effect.reduce(
    dataset.rounds,
    (): { steps: Step[]; earlier: LearnedRound[] } => ({ steps: [], earlier: [] }),
    ({ steps, earlier }, judgedRound, index) =>
      step({
        principles: steps.at(-1)?.principles ?? [],
        earlier,
        judgedRound,
        learner,
        developer,
        noise,
        simulated,
      }).pipe(
        Effect.tap(() =>
          Effect.logInfo(`${label} ${learner}: round ${index + 1} of ${dataset.rounds.length}`),
        ),
        Effect.map(({ step, learnedRound }) => ({
          steps: [...steps, step],
          earlier: [learnedRound, ...earlier],
        })),
      ),
  ).pipe(Random.withSeed(seed));
  return { label, learner, developer, noise, seed, startedAt, steps } satisfies RunRecord;
});
