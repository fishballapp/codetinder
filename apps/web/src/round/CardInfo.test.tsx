import type { Card } from '@codetinder/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardInfo, cardInfoContent } from './CardInfo';
import { INITIAL_PEEK_STATE, isTouch, nextPeekState } from './Peek';

const sampleCard: Card = {
  id: 'c1',
  operation: 'Remove Redundant Condition',
  change:
    "Drop the `prediction !== 'none'` check from the correct count, since a truth is never 'none' and equality already excludes it.",
  principle: {
    id: 'skip-redundant-conditions',
    statement: 'Do not test a condition that another check in the same expression already implies.',
  },
  stance: 'supports',
  kind: 'explore',
  after: 'const isCorrect = prediction === truth;',
};

describe('CardInfo', () => {
  it('renders an accessible info button and never includes principle, stance or kind', () => {
    const triggerMarkup = renderToStaticMarkup(
      <CardInfo operation={sampleCard.operation} change={sampleCard.change} />,
    );
    const { head, body } = cardInfoContent({
      operation: sampleCard.operation,
      change: sampleCard.change,
    });
    const contentMarkup = renderToStaticMarkup(
      <div>
        {head}
        {body}
      </div>,
    );

    expect(triggerMarkup).toContain('aria-label="What this card changes"');
    expect(contentMarkup).toContain('Remove Redundant Condition');
    expect(contentMarkup).toContain('<code');
    expect(contentMarkup).toContain('prediction !== &#x27;none&#x27;');
    expect(contentMarkup).toContain('equality already excludes it.');

    for (const markup of [triggerMarkup, contentMarkup]) {
      expect(markup).not.toContain(sampleCard.principle.id);
      expect(markup).not.toContain(sampleCard.principle.statement);
      expect(markup).not.toContain(sampleCard.stance);
      expect(markup).not.toContain(sampleCard.kind);
    }
  });
});

describe('nextPeekState', () => {
  it('opens unpinned on hover and closes when hover leaves', () => {
    const hovered = nextPeekState(INITIAL_PEEK_STATE, { next: true, reason: 'trigger-hover' });
    expect(hovered).toEqual({ isOpen: true, isPinned: false });

    const left = nextPeekState(hovered, { next: false, reason: 'trigger-hover' });
    expect(left).toEqual({ isOpen: false, isPinned: false });
  });

  it('pins a hovered peek on press, ignores hover-leave while pinned, and closes on a second press', () => {
    const hovered = nextPeekState(INITIAL_PEEK_STATE, { next: true, reason: 'trigger-hover' });
    const pinned = nextPeekState(hovered, { next: false, reason: 'trigger-press' });
    expect(pinned).toEqual({ isOpen: true, isPinned: true });

    const afterHoverLeave = nextPeekState(pinned, { next: false, reason: 'trigger-hover' });
    expect(afterHoverLeave).toEqual({ isOpen: true, isPinned: true });

    const closed = nextPeekState(afterHoverLeave, { next: false, reason: 'trigger-press' });
    expect(closed).toEqual({ isOpen: false, isPinned: false });
  });

  it('opens and pins on a direct press (click or Enter) and unpins on Escape or outside press', () => {
    const opened = nextPeekState(INITIAL_PEEK_STATE, { next: true, reason: 'trigger-press' });
    expect(opened).toEqual({ isOpen: true, isPinned: true });

    const escaped = nextPeekState(opened, { next: false, reason: 'escape-key' });
    expect(escaped).toEqual({ isOpen: false, isPinned: false });
  });
});

describe('isTouch', () => {
  it('treats touch and pen pointers as touch, and mouse or keyboard presses as desktop', () => {
    expect(isTouch('touch')).toBe(true);
    expect(isTouch('pen')).toBe(true);
    expect(isTouch('mouse')).toBe(false);
    expect(isTouch('')).toBe(false);
  });
});
