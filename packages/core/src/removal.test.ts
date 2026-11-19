import { describe, expect, it } from 'vitest';
import { removalMergeRequestDescription } from './removal';

describe('removalMergeRequestDescription', () => {
  const description = removalMergeRequestDescription();

  it('says what was turned off, and that only the config is deleted', () => {
    expect(description).toContain('the `codetinder` flow');
    expect(description).toContain('Closed:** the "Add CodeTinder 💘" setup merge request');
    expect(description).toContain('`.codetinder/config.json`');
  });

  it('keeps the learned principles and the agent config for the developer to delete', () => {
    expect(description).toContain('`.codetinder/principles.md`');
    expect(description).toContain('`.gitlab/duo/agent-config.yml`');
    expect(description).toContain('yours to delete if you want');
  });

  it('keeps the rounds on codetinder.dev', () => {
    expect(description).toContain('Your rounds on codetinder.dev stay there.');
  });
});
