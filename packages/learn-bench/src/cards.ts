import { type Card, fence, type Round, unifiedDiff } from '@codetinder/core';

/** The unchanged lines either side of a change, as learn shows a card. */
const DIFF_CONTEXT_LINES = 3;

/** The round's original, then each card as a unified diff against it, as learn shows them. */
export const cardsSection = (
  round: Round,
  cards: readonly Card[],
) => `The original, from \`${round.target.file}\`:

${fence(round.target.text)}

Each card is shown as a unified diff against the original: \`-\` lines are the original's, \`+\`
lines the card's.

${cards
  .map(
    card =>
      `### ${card.id}\n\n${fence(unifiedDiff(round.target.text, card.after, { context: DIFF_CONTEXT_LINES }))}`,
  )
  .join('\n\n')}`;
