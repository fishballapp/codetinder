import type { GitLabDiscussion } from '@codetinder/gitlab';
import { describe, expect, it } from 'vitest';
import { findRoundThread } from './roundThread';

const discussion = (
  id: string,
  first: { body: string; authorUsername: string; isSystem?: boolean },
): GitLabDiscussion => ({
  id,
  notes: [{ id: 1, isSystem: false, ...first }],
});

const ROUND_NOTE =
  '💘 caught my eye … [Swipe on the round →](https://codetinder.dev/rounds/0123456789AB)';

describe('findRoundThread', () => {
  it("finds the flow's note linking the round, and who posted it", () => {
    const discussions = [
      discussion('a', { body: 'started', authorUsername: 'ai-codetinder-acme', isSystem: true }),
      discussion('b', { body: ROUND_NOTE, authorUsername: 'ai-codetinder-acme' }),
    ];
    expect(findRoundThread(discussions, '0123456789AB')).toEqual({
      discussionId: 'b',
      serviceAccount: 'ai-codetinder-acme',
    });
  });

  it("ignores a developer's comment quoting the link", () => {
    const discussions = [discussion('a', { body: ROUND_NOTE, authorUsername: 'ada' })];
    expect(findRoundThread(discussions, '0123456789AB')).toBeUndefined();
  });

  it('ignores the note of another round', () => {
    const discussions = [
      discussion('a', { body: ROUND_NOTE, authorUsername: 'ai-codetinder-acme' }),
    ];
    expect(findRoundThread(discussions, 'ZZZZZZZZZZZZ')).toBeUndefined();
  });
});
