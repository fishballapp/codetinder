import {
  type Card,
  fence,
  type Principle,
  type Round,
  renderPrinciplesDoc,
  type Task,
} from '@codetinder/core';
import * as Schema from 'effect/Schema';
import { cardsSection } from './cards';

export const PredictionSchema = Schema.Literals(['like', 'dislike', 'none']);
export const JudgeAnswerSchema = Schema.Struct({
  cards: Schema.Array(
    Schema.Struct({
      id: Schema.String.annotate({ description: "The card's id, as in its heading" }),
      principleId: Schema.NullOr(Schema.String).annotate({
        description: 'The id of the principle that decides the card; null when none applies',
      }),
      prediction: PredictionSchema.annotate({
        description:
          '"like" when the principles prefer the card\'s after, "dislike" when they prefer the original, "none" when no principle bears on the change',
      }),
    }),
  ).annotate({ description: 'One entry per card, in order' }),
});
/**
 * The judge reads the doc a coding agent would and predicts the developer's swipes on cards it has
 * never seen. It may only reason from the doc, so a better doc is the only way to a better score,
 * and it may say no principle applies, so a doc that says nothing scores nothing, not a guess.
 */
export const judgeTask = ({
  principles,
  round,
  cards,
}: {
  principles: readonly Principle[];
  round: Round;
  cards: readonly Card[];
}): Task<typeof JudgeAnswerSchema> => ({
  instructions: `# Predict a developer's swipes from their coding principles

A developer judges cards: each card is one function with one change applied. A like means they
prefer the card's after; a dislike, the original. Below is the doc of coding principles learned
from their earlier swipes. Predict how they swiped each card, from that doc alone.

## The principles doc

${fence(renderPrinciplesDoc(principles))}

## The cards

${cardsSection(round, cards)}

## How to predict

- For each card, find the principle in the doc that the change bears on. Predict "like" if the
  card's after follows it and the original doesn't, "dislike" if the original follows it and the
  after doesn't.
- When two principles bear on a change and point opposite ways, the more specific one decides; if
  neither is more specific, the stronger one does.
- When no principle in the doc bears on the change, predict "none". Don't fall back on what you
  think is good code: only the doc counts.`,
  answerSchema: JudgeAnswerSchema,
});
