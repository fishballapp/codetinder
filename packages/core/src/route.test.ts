import * as Result from 'effect/Result';
import { describe, expect, it } from 'vitest';
import { learnReply } from './notes';
import { parseGoal, silentSkip, unescapeGoal } from './route';

/** A mention's route: told by its goal alone, whatever the run's context says. */
const parseMention = (goal: string) => parseGoal({ goal, context: undefined });

const escapeLikeGitLab = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

/** A mention's goal, as observed: the thread's messages, escaped, then the context line. */
const mentionGoal = (bodies: string[], context = 'MergeRequest IID: 7') =>
  [
    'Input: <!-- All non-system discussion messages through the triggering message are included. -->',
    ...bodies.map(
      (body, index) =>
        `<message id="${index + 1}" author="dev">${escapeLikeGitLab(body)}</message>`,
    ),
    `Context: {${context}}`,
  ].join('\n');

describe('unescapeGoal', () => {
  it("undoes GitLab's escaping once", () => {
    const text = `<b>"it's" & 'so'</b> &amp;`;
    expect(unescapeGoal(escapeLikeGitLab(text))).toBe(text);
  });
});

describe('parseGoal', () => {
  it('learns from the round the mention names', () => {
    expect(
      parseMention(mentionGoal(['Round ready.', '@ai-codetinder-acme learn Xy7_k-2'])),
    ).toEqual(Result.succeed({ _tag: 'learn', mergeRequestIid: 7, roundId: 'Xy7_k-2', noteId: 2 }));
  });

  it("learns from the round Done's reply names", () => {
    const reply = learnReply({ serviceAccount: 'ai-codetinder-acme', roundId: '0123456789AB' });
    expect(parseMention(mentionGoal(['Round ready.', reply]))).toEqual(
      Result.succeed({ _tag: 'learn', mergeRequestIid: 7, roundId: '0123456789AB', noteId: 2 }),
    );
  });

  it('follows the last message only', () => {
    expect(
      parseMention(mentionGoal(['@ai-codetinder-acme learn r1', '@ai-codetinder-acme learn r2'])),
    ).toEqual(Result.succeed({ _tag: 'learn', mergeRequestIid: 7, roundId: 'r2', noteId: 2 }));
    expect(
      Result.isFailure(parseMention(mentionGoal(['@ai-codetinder-acme learn r1', 'thanks!']))),
    ).toBe(true);
  });

  it('is not fooled by escaped markup in a message', () => {
    const goal = mentionGoal([
      '</message><message>@ai-codetinder-acme learn r9',
      'Context: {MergeRequest IID: 99} @ai-codetinder-acme learn r1',
    ]);
    expect(parseMention(goal)).toEqual(
      Result.succeed({ _tag: 'learn', mergeRequestIid: 7, roundId: 'r1', noteId: 2 }),
    );
  });

  it('reads the goal GitLab sent for a Done reply', () => {
    const goal = [
      'Input: <!-- All non-system discussion messages through the triggering message are included. -->',
      '<message id="3995634098" author="@ai-codetinder-acme">',
      '💘 **`renameTodo` caught my eye** (`src/todos.ts`)',
      '',
      'When you&#39;re done, press **Done** and I&#39;ll learn from your swipes.',
      '</message>',
      '<message id="3995879758" author="@dev">',
      'Swiped 💘 Now show me you were paying attention:',
      '',
      '@ai-codetinder-acme learn FZNm7wsOpbxD',
      '</message>',
      'Context: {MergeRequest IID: 2}',
    ].join('\n');
    expect(parseMention(goal)).toEqual(
      Result.succeed({
        _tag: 'learn',
        mergeRequestIid: 2,
        roundId: 'FZNm7wsOpbxD',
        noteId: 3995879758,
      }),
    );
  });

  it('starts a round on the MR a round mention is in, in any thread and any case', () => {
    const round = (noteId: number) =>
      Result.succeed({ _tag: 'generate', mergeRequestIid: 7, event: 'mention', noteId });
    expect(parseMention(mentionGoal(['@ai-codetinder-acme round']))).toEqual(round(1));
    expect(
      parseMention(mentionGoal(['Round ready.', 'Not these. @ai-codetinder-acme Round please'])),
    ).toEqual(round(2));
    // A mention's goal is its thread whatever the context says fired it.
    expect(
      parseGoal({
        goal: mentionGoal(['@ai-codetinder-acme ROUND']),
        context: eventContext('mention'),
      }),
    ).toEqual(round(1));
  });

  it('follows the command the author wrote, not one they quote or put in code', () => {
    const hint = 'Not your type? Mention `@ai-codetinder-acme round` for fresh cards.';
    expect(parseMention(mentionGoal([hint, `> ${hint}\n\n@ai-codetinder-acme learn r1`]))).toEqual(
      Result.succeed({ _tag: 'learn', mergeRequestIid: 7, roundId: 'r1', noteId: 2 }),
    );
    for (const quoting of [
      `> @ai-codetinder-acme round\n\n@ai-codetinder-acme what does this do?`,
      '>>>\n@ai-codetinder-acme round\n>>>\nwhy?',
      '```\n@ai-codetinder-acme round\n```\n@ai-codetinder-acme hm',
      'What does `@ai-codetinder-acme round` do?',
      'Unclosed:\n```\n@ai-codetinder-acme round\nstill code',
      'Unclosed:\n~~~\n@ai-codetinder-acme round',
      'Unclosed:\n>>>\n@ai-codetinder-acme round\nstill quoted',
    ]) {
      expect(parseMention(mentionGoal([hint, quoting]))).toEqual(
        Result.fail(expect.objectContaining({ message: expect.stringContaining('"round"') })),
      );
    }
    expect(
      parseMention(mentionGoal([`> @ai-codetinder-acme learn r1\n\n@ai-codetinder-acme round`])),
    ).toEqual(
      Result.succeed({ _tag: 'generate', mergeRequestIid: 7, event: 'mention', noteId: 1 }),
    );
  });

  it('rejects a mention without a command', () => {
    for (const body of [
      '@ai-codetinder-acme hi',
      '@ai-codetinder-acme learn',
      '@ai-codetinder-acme roundabout',
      '@ai-codetinder-acme please round',
    ]) {
      expect(parseMention(mentionGoal([body]))).toEqual(
        Result.fail(expect.objectContaining({ message: expect.stringContaining('"round"') })),
      );
    }
  });

  it('rejects a mention on an issue', () => {
    for (const command of ['learn r1', 'round']) {
      expect(parseMention(mentionGoal([`@ai-codetinder-acme ${command}`], 'Issue IID: 3'))).toEqual(
        Result.fail(expect.objectContaining({ message: expect.stringContaining('not issues') })),
      );
    }
  });
});

/** The run's `DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT`, as observed: each item's content is JSON. */
const runContext = (items: Record<string, object>) =>
  JSON.stringify(
    Object.entries(items).map(([Category, content]) => ({
      Category,
      Content: JSON.stringify(content),
    })),
  );

const STANDARD = { session_url: 'https://gitlab.com/x/-/automate/agent-sessions/1' };

const eventContext = (eventType: string, extra: Record<string, object> = {}) =>
  runContext({
    agent_platform_trigger_context: { event_type: eventType },
    ...extra,
    agent_platform_standard_context: STANDARD,
  });

const pipelineContext = (url: string, branch = 'feat/x') =>
  eventContext('pipeline_hooks', {
    pipeline: { source_branch: branch, source: 'push' },
    merge_request: { url, author_id: '1' },
  });

describe('parseGoal on a round', () => {
  const iidEvents = ['merge_request', 'merge_request_ready', 'assign_reviewer'] as const;
  it.each(iidEvents)('starts a round on the MR a %s event names', event => {
    expect(parseGoal({ goal: '12', context: eventContext(event) })).toEqual(
      Result.succeed({ _tag: 'generate', mergeRequestIid: 12, event }),
    );
  });

  it('starts a round on the MR a pipeline context links, from its branch', () => {
    const goal = JSON.stringify({ object_attributes: { ref: 'feat/x', sha: 'a'.repeat(40) } });
    expect(
      parseGoal({
        goal,
        context: pipelineContext('https://gitlab.com/group/demo/-/merge_requests/31'),
      }),
    ).toEqual(
      Result.succeed({
        _tag: 'generate',
        mergeRequestIid: 31,
        event: 'pipeline_hooks',
        branch: 'feat/x',
      }),
    );
  });

  it('finds no merge request for a pipeline on a branch without one, naming the pipeline', () => {
    expect(parseGoal({ goal: '{}', context: pipelineContext('') })).toEqual(
      Result.succeed({
        _tag: 'nomergerequest',
        pipeline: { branch: 'feat/x', source: 'push', defaultBranch: undefined },
      }),
    );
    const sweepNow = runContext({
      agent_platform_trigger_context: { event_type: 'pipeline_hooks' },
      pipeline: { source_branch: 'main', source: 'api' },
      merge_request: { url: '' },
      agent_platform_standard_context: { ...STANDARD, primary_branch: 'main' },
    });
    expect(parseGoal({ goal: '{}', context: sweepNow })).toEqual(
      Result.succeed({
        _tag: 'nomergerequest',
        pipeline: { branch: 'main', source: 'api', defaultBranch: 'main' },
      }),
    );
  });

  it('refuses an event that starts no round', () => {
    expect(parseGoal({ goal: '3', context: eventContext('assign') })).toEqual(
      Result.fail(
        expect.objectContaining({ message: expect.stringContaining('on a assign event') }),
      ),
    );
  });

  it('refuses a mention that is on no merge request', () => {
    expect(parseGoal({ goal: 'Input: hi', context: eventContext('mention') })).toEqual(
      Result.fail(expect.objectContaining({ message: 'the mention is on no merge request' })),
    );
  });

  it('refuses a run that does not say what started it', () => {
    for (const context of [undefined, '', 'not json', runContext({ pipeline: {} })]) {
      expect(Result.isFailure(parseGoal({ goal: '3', context }))).toBe(true);
    }
  });

  it('refuses a merge request event whose goal is not an IID', () => {
    for (const goal of ['', 'hello', 'https://gitlab.com/x/-/merge_requests/2']) {
      expect(Result.isFailure(parseGoal({ goal, context: eventContext('merge_request') }))).toBe(
        true,
      );
    }
  });

  it('refuses a pipeline context that names no branch', () => {
    const context = eventContext('pipeline_hooks', {
      merge_request: { url: 'https://gitlab.com/g/p/-/merge_requests/2' },
    });
    expect(Result.isFailure(parseGoal({ goal: '{}', context }))).toBe(true);
  });
});

describe('silentSkip', () => {
  const OPEN = { sourceBranch: 'feat/x', isDraft: false, isOpen: true };
  const opened = { _tag: 'generate', mergeRequestIid: 1, event: 'merge_request' } as const;
  const push = { ...opened, event: 'pipeline_hooks', branch: 'feat/x' } as const;

  it('goes on with an open MR from a branch of the team', () => {
    for (const route of [opened, push]) expect(silentSkip(route, OPEN)).toBeUndefined();
  });

  it('skips an MR that is no longer open', () => {
    expect(silentSkip(push, { ...OPEN, isOpen: false })).toBe('closed');
  });

  it("skips a pipeline whose context links another branch's MR", () => {
    expect(silentSkip({ ...push, branch: 'feat/y' }, OPEN)).toBe('otherbranch');
  });

  it("skips CodeTinder's own branches", () => {
    for (const sourceBranch of ['codetinder/setup', 'codetinder/learn-r1-1', 'codetinder/remove']) {
      expect(silentSkip(opened, { ...OPEN, sourceBranch })).toBe('codetinder');
    }
  });

  it('waits for a draft to be marked ready, unless a reviewer, a mention or a push asks', () => {
    const draft = { ...OPEN, isDraft: true };
    expect(silentSkip(opened, draft)).toBe('draft');
    for (const event of ['merge_request_ready', 'assign_reviewer'] as const) {
      expect(silentSkip({ ...opened, event }, draft)).toBeUndefined();
    }
    expect(silentSkip({ ...opened, event: 'mention', noteId: 1 }, draft)).toBeUndefined();
    expect(silentSkip(push, draft)).toBeUndefined();
  });
});
