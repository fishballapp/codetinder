import { describe, expect, it } from '@effect/vitest';
import { code } from './fence';
import type { LearnOutcome, PrincipleChange } from './learn';
import {
  learnNote,
  noCodeNote,
  plain,
  proposalCommitMessage,
  proposalDescription,
  proposalTitle,
  roundNote,
  skippedNote,
} from './notes';

const sampleRound = {
  target: { symbol: 'formatSummary', file: 'src/summary.ts', text: 'function formatSummary() {}' },
  cards: ['c1', 'c2', 'c3'].map(id => ({
    id,
    operation: 'Rename Variable',
    change: 'Renamed a variable.',
    principle: { id: 'clear-names', statement: 'Name variables for what they hold.' },
    stance: 'supports' as const,
    kind: 'explore' as const,
    after: `${id} text`,
  })),
  reason: 'it has intricate branching',
};

const sampleUrl = 'https://codetinder.dev/rounds/019345a1b2c3';

describe('code', () => {
  it('wraps text in single backticks when no backticks are present', () => {
    expect(code('formatSummary')).toBe('`formatSummary`');
  });

  it('uses longer backtick fence when text contains backticks', () => {
    expect(code('a`b')).toBe('``a`b``');
  });

  it('pads with spaces when text starts or ends with backticks', () => {
    expect(code('`foo`')).toBe('`` `foo` ``');
    expect(code('`foo')).toBe('`` `foo ``');
    expect(code('foo`')).toBe('`` foo` ``');
  });
});

describe('plain', () => {
  it('collapses whitespace runs and newlines to single spaces', () => {
    expect(plain('  hello \n\n world \t foo   ')).toBe('hello world foo');
  });

  it('neutralises GitLab references by inserting zero-width space before word character', () => {
    expect(plain('ping @all and check #12 and !3 and ~bug and %milestone and $var and &epic')).toBe(
      'ping @\u200Ball and check #\u200B12 and !\u200B3 and ~\u200Bbug and %\u200Bmilestone and $\u200Bvar and &\u200Bepic',
    );
  });

  it('keeps links, images, tags and bare URLs from rendering as links', () => {
    expect(
      plain(
        'See [the review](https://evil.example) and ![x](https://evil.example/p.png), <a href="x">, <https://evil.example>, www.evil.example',
      ),
    ).toBe(
      'See [the review]\u200B(https:\u200B//evil.example) and ![x]\u200B(https:\u200B//evil.example/p.png), <\u200Ba href="x">, <\u200Bhttps:\u200B//evil.example>, www\u200B.evil.example',
    );
  });

  it('leaves code that only looks like markup readable', () => {
    expect(plain('Prefer `Array<T>` over `T[]`.')).toBe('Prefer `Array<\u200BT>` over `T[]`.');
  });

  it('does not insert zero-width space when not preceding a word character', () => {
    expect(plain('done! check & review 100% # @ ~')).toBe('done! check & review 100% # @ ~');
  });
});

describe('roundNote', () => {
  it('formats mischievous note with exact copy', () => {
    expect(
      roundNote({
        tone: 'mischievous',
        round: sampleRound,
        url: sampleUrl,
        serviceAccount: 'ai-codetinder-acme',
        isFresh: false,
      }),
    ).toBe(`💘 **\`formatSummary\` caught my eye** · \`src/summary.ts\`

It has intricate branching. So I tried 3 little changes on it, one per card; each one's meant to behave just like yours, and your tests agree. Like the ones you prefer, and show me your type:

**[Swipe on the round →](https://codetinder.dev/rounds/019345a1b2c3)**

Prefer to swipe on your phone? Scan me 📱💘

![QR code: scan to swipe on your phone](https://codetinder.dev/rounds/019345a1b2c3/qr.png){width=140 height=140}

When you're done, press **Done** and I'll learn from your swipes, then propose this MR rewritten your way. Not your type? Mention \`@ai-codetinder-acme round\` and I'll deal fresh cards.`);
  });

  it('formats plain note with exact copy', () => {
    expect(
      roundNote({
        tone: 'plain',
        round: sampleRound,
        url: sampleUrl,
        serviceAccount: 'ai-codetinder-acme',
        isFresh: false,
      }),
    ).toBe(`**CodeTinder round: \`formatSummary\`** · \`src/summary.ts\`

It has intricate branching. CodeTinder made 3 cards, each one small change to this function, meant to behave like the original, and the project's tests pass on it. Like a card if you prefer the change, dislike it if you prefer the original.

**[Swipe on the round →](https://codetinder.dev/rounds/019345a1b2c3)**

Or scan to open it on your phone:

![QR code: scan to swipe on your phone](https://codetinder.dev/rounds/019345a1b2c3/qr.png){width=140 height=140}

After swiping, press **Done**: CodeTinder learns from the swipes and proposes a rewrite of this MR in that style. For a fresh round on the latest commit, mention \`@ai-codetinder-acme round\`.`);
  });

  it("counts the cards that explore questions outside the project's latest judged rounds, in either tone", () => {
    const sentence = (tone: 'mischievous' | 'plain') =>
      roundNote({
        tone,
        round: sampleRound,
        url: sampleUrl,
        serviceAccount: 'ai-codetinder-acme',
        isFresh: false,
        eligibleCards: 2,
      });
    expect(sentence('mischievous')).toContain(
      "your tests agree. Fresh faces: 2 of these 3 cards explore questions outside the project's last 3 judged rounds. Like the ones you prefer,",
    );
    expect(sentence('plain')).toContain(
      "tests pass on it. 2 of these 3 cards explore questions outside the project's last 3 judged rounds. Like a card if you prefer",
    );
  });

  it('claims nothing about freshness when the questions were not read', () => {
    const note = roundNote({
      tone: 'plain',
      round: sampleRound,
      url: sampleUrl,
      serviceAccount: 'ai-codetinder-acme',
      isFresh: false,
    });
    expect(note).not.toContain('explore questions');
  });

  it("says a round that replaces the commit's earlier one is fresh, in either tone", () => {
    const fresh = (tone: 'mischievous' | 'plain') =>
      roundNote({
        tone,
        round: sampleRound,
        url: sampleUrl,
        serviceAccount: 'ai-codetinder-acme',
        isFresh: true,
      }).split('\n')[0];
    expect(fresh('mischievous')).toBe(
      '💘 **Fresh round: `formatSummary` caught my eye** · `src/summary.ts`',
    );
    expect(fresh('plain')).toBe('**CodeTinder fresh round: `formatSummary`** · `src/summary.ts`');
  });

  it('handles backticks in symbol and neutralises pings and newlines in reason', () => {
    const roundWithTrickyContent = {
      target: {
        symbol: '`danger`',
        file: 'src/lib.ts',
        text: 'function danger() {}',
      },
      cards: sampleRound.cards,
      reason: 'check this out:\n@all review #42\nand !100 immediately',
    };

    const note = roundNote({
      tone: 'plain',
      round: roundWithTrickyContent,
      url: sampleUrl,
      serviceAccount: 'ai-codetinder-acme',
      isFresh: false,
    });

    expect(note).toContain('**CodeTinder round: `` `danger` ``** · `src/lib.ts`');
    expect(note).toContain('Check this out: @​all review #​42 and !​100 immediately.');
  });
});

describe('skippedNote', () => {
  it('formats mischievous skipped note, sentence-casing and adding trailing full stop', () => {
    expect(
      skippedNote({
        tone: 'mischievous',
        reason: 'only 2 cards passed the typecheck and tests, and a round needs 3',
      }),
    ).toBe(`💔 **No round this time**

Only 2 cards passed the typecheck and tests, and a round needs 3.

Nothing on this MR changed. I'll try again on your next one.`);
  });

  it('formats plain skipped note without adding extra dot if already present', () => {
    expect(
      skippedNote({
        tone: 'plain',
        reason: 'This project has no .codetinder/config.json.',
      }),
    ).toBe(`**CodeTinder skipped this merge request**

This project has no .codetinder/config.json.

Nothing on this MR was changed.`);
  });

  it.each(['Why would anyone taste a lockfile?', 'The function is one long template literal…'])(
    'adds no full stop after a reason that already ends a sentence: %s',
    reason => {
      expect(skippedNote({ tone: 'plain', reason })).toContain(`\n\n${reason}\n\n`);
    },
  );

  it('neutralises pings and collapses newlines in skipped note reason', () => {
    expect(
      skippedNote({
        tone: 'plain',
        reason: 'failed due to @team\nin #99',
      }),
    ).toBe(`**CodeTinder skipped this merge request**

Failed due to @\u200Bteam in #\u200B99.

Nothing on this MR was changed.`);
  });
});

const sampleChanges: PrincipleChange[] = [
  {
    _tag: 'Added',
    principle: {
      id: 'early-returns',
      section: 'General',
      strength: 'tentative',
      statement: 'Return early instead of nesting conditionals.',
    },
  },
  {
    _tag: 'Strengthened',
    principle: {
      id: 'small-functions',
      section: 'General',
      strength: 'strong',
      statement: 'Keep functions short.',
    },
  },
  {
    _tag: 'Dropped',
    principle: {
      id: 'for-loops',
      section: 'General',
      strength: 'moderate',
      statement: 'Prefer for loops.',
    },
  },
];

const sampleProposed = {
  _tag: 'Proposed',
  skipped: [],
  principles: { _tag: 'Learned', changes: sampleChanges },
  writtenRules: [],
  rewrite: {
    _tag: 'Applied',
    summary: 'flattened the branching with early returns',
    files: ['src/summary.ts', 'src/format.ts'],
    testCommand: 'pnpm test',
  },
  delivery: { _tag: 'MergeRequest', iid: 13 },
} as const satisfies LearnOutcome;

const blockedTests = {
  stage: 'tests',
  diagnosis: { _tag: 'BlockedHosts', hosts: ['api.example.com'] },
  outputTail: 'FAIL src/api.test.ts\nError: getaddrinfo ENOTFOUND api.example.com',
} as const;

describe('skippedNote for the sandbox', () => {
  it('formats a mischievous note for a blocked host, with the allow-list and the output', () => {
    expect(
      skippedNote({
        tone: 'mischievous',
        reason: 'the tests fail in the sandbox before any change',
        environment: blockedTests,
      }),
    ).toBe(
      `💔 **Your tests can't run in my sandbox**

They fail before I change a thing: they tried to reach \`api.example.com\`, which the sandbox blocks. Add it to \`network_policy.allowed_domains\` in \`.gitlab/duo/agent-config.yml\`, or point \`test\` in \`.codetinder/config.json\` at tests that don't need the network.

Nothing on this MR changed. I'll try again on your next one.

<details><summary>Output</summary>

\`\`\`
FAIL src/api.test.ts
Error: getaddrinfo ENOTFOUND api.example.com
\`\`\`

</details>`,
    );
  });

  it('links the MR that fixes the sandbox, new or already open', () => {
    const note = (tone: 'mischievous' | 'plain', isNew: boolean) =>
      skippedNote({
        tone,
        reason: 'the tests fail in the sandbox before any change',
        environment: blockedTests,
        sandboxFix: { iid: 12, isNew },
      });
    expect(note('mischievous', true)).toContain(
      "or point `test` in `.codetinder/config.json` at tests that don't need the network.\n\nI opened **!12** with the fix. Merge it and your next MR gets a round. 🔧\n\nNothing on this MR changed.",
    );
    expect(note('mischievous', false)).toContain(
      'The fix is in **!12**. Merge it and your next MR gets a round. 🔧',
    );
    expect(note('plain', true)).toContain(
      'CodeTinder opened **!12** with the fix: merge it and the next merge request gets a round.',
    );
  });

  it('formats a plain note for a blocked host, neutrally', () => {
    expect(
      skippedNote({
        tone: 'plain',
        reason: 'the tests fail in the sandbox before any change',
        environment: blockedTests,
      }),
    ).toBe(
      `**CodeTinder could not run the tests in its sandbox**

The tests fail before any change: they tried to reach \`api.example.com\`, which the sandbox blocks. Add it to \`network_policy.allowed_domains\` in \`.gitlab/duo/agent-config.yml\`, or point \`test\` in \`.codetinder/config.json\` at tests that don't need the network.

Nothing on this MR was changed.

<details><summary>Output</summary>

\`\`\`
FAIL src/api.test.ts
Error: getaddrinfo ENOTFOUND api.example.com
\`\`\`

</details>`,
    );
  });

  it('points a timed-out install at a faster command, and leaves out an empty output', () => {
    expect(
      skippedNote({
        tone: 'mischievous',
        reason: 'the install fails in the sandbox before any change',
        environment: { stage: 'install', diagnosis: { _tag: 'TimedOut' }, outputTail: '' },
      }),
    ).toBe(
      `💔 **Your install can't run in my sandbox**

It fails before I change a thing: it ran past the sandbox's time limit. Point \`install\` in \`.codetinder/config.json\` at a faster command.

Nothing on this MR changed. I'll try again on your next one.`,
    );
  });

  it('lists the common causes, worded for the install as for the tests', () => {
    const note = (stage: 'install' | 'tests') =>
      skippedNote({
        tone: 'plain',
        reason: 'the stage fails in the sandbox before any change',
        environment: { stage, diagnosis: { _tag: 'Unknown' }, outputTail: 'boom' },
      });
    const causes = (key: string) =>
      "the output doesn't say why. Common causes: a host the sandbox blocks (allow it in `network_policy.allowed_domains` in `.gitlab/duo/agent-config.yml`); a secret or environment variable that isn't set here (CI/CD variables aren't available); a service that isn't running here, such as a database; a command that runs past the time limit (point `" +
      key +
      '` in `.codetinder/config.json` at a faster one).';
    expect(note('tests')).toContain(`The tests fail before any change: ${causes('test')}`);
    expect(note('install')).toContain(`The install fails before any change: ${causes('install')}`);
  });

  it('says so when the output is empty and the cause unknown', () => {
    const note = skippedNote({
      tone: 'plain',
      reason: 'the install fails in the sandbox before any change',
      environment: { stage: 'install', diagnosis: { _tag: 'Unknown' }, outputTail: '  \n' },
    });
    expect(note).toContain('The install fails before any change: it printed no output.');
    expect(note).not.toContain('<details>');
  });

  it('names the read-only path and where a command may write', () => {
    const note = skippedNote({
      tone: 'plain',
      reason: 'the install fails in the sandbox before any change',
      environment: {
        stage: 'install',
        diagnosis: { _tag: 'ReadOnlyPaths', paths: ['/opt/cache/.npm/_cacache/tmp/c6ab6b05'] },
        outputTail: 'npm error code EROFS\nnpm error path /opt/cache/.npm/_cacache/tmp/c6ab6b05',
      },
    });
    expect(note).toContain(
      'The install fails before any change: it tried to write to `/opt/cache/.npm/_cacache/tmp/c6ab6b05`, which the sandbox keeps read-only. The sandbox lets a command write only to the checkout and `/tmp`; point the cache or output it writes elsewhere at `/tmp`, for example with an environment variable in `install` in `.codetinder/config.json`.',
    );
    expect(note).toContain('<details><summary>Output</summary>');
  });

  it('names the missing library and where to install it', () => {
    const note = skippedNote({
      tone: 'plain',
      reason: 'the install fails in the sandbox before any change',
      environment: {
        stage: 'install',
        diagnosis: { _tag: 'MissingLibraries', libraries: ['libatomic.so.1'] },
        outputTail:
          'node: error while loading shared libraries: libatomic.so.1: cannot open shared object file',
      },
    });
    expect(note).toContain(
      "The install fails before any change: it needs `libatomic.so.1`, which the sandbox's image doesn't have. Install it before the sandbox starts, with `setup_script` in `.gitlab/duo/agent-config.yml` (for example `microdnf install -y libatomic`), or point the project's Node at a version that doesn't need it.",
    );
  });

  it('shows the command and its exit code, with the output when there is some', () => {
    const environment = {
      stage: 'install',
      diagnosis: { _tag: 'Unknown' },
      command: "npx --yes -p node@26 -- sh -c 'pnpm install'",
      exitCode: 127,
    } as const;
    const withOutput = skippedNote({
      tone: 'plain',
      reason: 'x',
      environment: { ...environment, outputTail: 'boom' },
    });
    expect(withOutput).toContain(
      "It ran `npx --yes -p node@26 -- sh -c 'pnpm install'` and exited with code 127.\n\n<details><summary>Output</summary>",
    );
    const silent = skippedNote({
      tone: 'mischievous',
      reason: 'x',
      environment: { ...environment, outputTail: '' },
    });
    expect(silent).toContain('it printed no output.');
    expect(silent).toContain(
      "It ran `npx --yes -p node@26 -- sh -c 'pnpm install'` and exited with code 127.",
    );
    expect(silent).not.toContain('<details>');
  });

  it('hides the credentials of a URL in the output', () => {
    const note = skippedNote({
      tone: 'plain',
      reason: 'the install fails in the sandbox before any change',
      environment: {
        stage: 'install',
        diagnosis: { _tag: 'Unknown' },
        outputTail:
          'proxy http://srt.abc:s3cret@localhost:3128/ refused\nGET https://example.test/x',
      },
    });
    expect(note).not.toContain('s3cret');
    expect(note).not.toContain('srt.abc');
    expect(note).toContain('localhost:3128');
    expect(note).toContain('example.test/x');
  });

  it('neutralises pings in the output, which stays in its block', () => {
    const note = skippedNote({
      tone: 'plain',
      reason: 'the tests fail in the sandbox before any change',
      environment: { stage: 'tests', diagnosis: { _tag: 'Unknown' }, outputTail: 'cc @all #12' },
    });
    expect(note).toContain('cc @​all #​12');
  });
});

describe('noCodeNote', () => {
  it('names the files in either tone, a few and then a count', () => {
    expect(noCodeNote({ tone: 'mischievous', files: ['README.md'] })).toBe(
      "💔 **No round this time**\n\nThis merge request changes no code, only `README.md`, so I have no function to rewrite. I'll try again on your next one.",
    );
    expect(noCodeNote({ tone: 'plain', files: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'] })).toBe(
      '**CodeTinder skipped this merge request**\n\nThis merge request changes no code, only `a.md`, `b.md`, `c.md`, and 2 more, so there is no function to make cards from.\n\nNothing on this MR was changed.',
    );
  });
});

describe('learnNote', () => {
  it('formats a mischievous proposal with exact copy', () => {
    expect(
      learnNote({ tone: 'mischievous', outcome: sampleProposed }),
    ).toBe(`💘 **I learned your type from your swipes**

What I learned:

- **Added** \`early-returns\` (tentative): Return early instead of nesting conditionals.
- **Strengthened** \`small-functions\` (strong): Keep functions short.
- **Dropped** \`for-loops\` (moderate): Prefer for loops.

Then I rewrote this MR your way. Flattened the branching with early returns. I ran \`pnpm test\` on it, and it passed. 😌

Files I touched 😏: \`src/summary.ts\`, \`src/format.ts\`

I put it all in **!13**. Merge it and it's a match. 💘`);
  });

  it('formats a plain proposal with exact copy', () => {
    expect(
      learnNote({ tone: 'plain', outcome: sampleProposed }),
    ).toBe(`**CodeTinder learned from this round**

Principles:

- **Added** \`early-returns\` (tentative): Return early instead of nesting conditionals.
- **Strengthened** \`small-functions\` (strong): Keep functions short.
- **Dropped** \`for-loops\` (moderate): Prefer for loops.

Rewrite: Flattened the branching with early returns. CodeTinder ran \`pnpm test\` on it, and it passed.

Files changed: \`src/summary.ts\`, \`src/format.ts\`

Proposed in **!13**: merging it applies the change to this MR's branch.`);
  });

  it('says the principles held when only the code was rewritten', () => {
    const outcome = { ...sampleProposed, principles: { _tag: 'Learned', changes: [] } } as const;
    expect(learnNote({ tone: 'mischievous', outcome })).toContain(
      '**I learned your type from your swipes**\n\nYour swipes confirmed the principles you already had, so nothing new there.\n\nThen I rewrote this MR your way.',
    );
    expect(learnNote({ tone: 'plain', outcome })).toContain(
      '**CodeTinder learned from this round**\n\nThe swipes confirmed the current principles; none changed.\n\nRewrite:',
    );
  });

  it("names a language principle's section, and where a moved one went", () => {
    const readonlyTypes = {
      id: 'readonly-types',
      section: 'TypeScript',
      strength: 'moderate',
      statement: 'Mark fields readonly.',
    } as const;
    const outcome = {
      ...sampleProposed,
      principles: {
        _tag: 'Learned',
        changes: [
          { _tag: 'Added', principle: readonlyTypes },
          { _tag: 'Moved', principle: { ...readonlyTypes, id: 'no-any' } },
        ],
      },
    } as const;
    const note = learnNote({ tone: 'plain', outcome });
    expect(note).toContain(
      '- **Added** `readonly-types` (moderate, TypeScript): Mark fields readonly.',
    );
    expect(note).toContain('- **Moved to TypeScript** `no-any` (moderate, TypeScript):');
  });

  it('says it rewrote a doc that was not in the current format', () => {
    const outcome = {
      ...sampleProposed,
      principles: { _tag: 'Reformatted', changes: [] },
    } as const;
    expect(learnNote({ tone: 'mischievous', outcome })).toContain(
      'Your swipes confirmed the principles you already had, so nothing new there.\n\nI also tidied `.codetinder/principles.md` into my current format: general principles first, then one section per language.',
    );
    expect(learnNote({ tone: 'plain', outcome })).toContain(
      "Rewrote `.codetinder/principles.md` in CodeTinder's current format: general principles, then one section per language.",
    );
  });

  it('names each written rule it rewrote or removed, and one it left, with why', () => {
    const edit = {
      path: 'CONTRIBUTING.md',
      rule: 'Always write an `else` branch.',
      replacement: '',
      principleId: 'early-returns',
    } as const;
    const outcome = {
      ...sampleProposed,
      writtenRules: [
        { _tag: 'Updated', edit },
        { _tag: 'Updated', edit: { ...edit, path: 'AGENTS.md', replacement: 'Return early.' } },
        {
          _tag: 'Skipped',
          edit: { ...edit, path: 'CLAUDE.md' },
          reason: "the rule isn't in the file as quoted",
        },
      ],
    } as const;
    expect(learnNote({ tone: 'plain', outcome })).toContain(`Written rules:

- Updated \`CONTRIBUTING.md\`: removed the rule “Always write an \`else\` branch.”, which \`early-returns\` contradicts.
- Updated \`AGENTS.md\`: the rule “Always write an \`else\` branch.” now reads “Return early.”, as \`early-returns\` has it.
- Couldn't update \`CLAUDE.md\` (the rule isn't in the file as quoted): its rule “Always write an \`else\` branch.” contradicts \`early-returns\`, so it's worth a look.`);
    expect(learnNote({ tone: 'mischievous', outcome })).toContain(
      'Your written rules now agree with your swipes, so your agents hear one story:',
    );
    expect(
      proposalCommitMessage({
        roundId: '019345a1b2c3',
        mergeRequestIid: 12,
        principles: { _tag: 'Learned', changes: [] },
        writtenRules: outcome.writtenRules,
      }),
    ).toBe(`style: apply the coding principles learned in round 019345a1b2c3

The swipes on !12 confirmed the principles as they are.

Brought the written rules in line:
- removed a rule in CONTRIBUTING.md that early-returns contradicts
- reworded a rule in AGENTS.md that early-returns contradicts`);
  });

  it('says the code already follows the principles when the rewrite is unchanged', () => {
    const outcome = { ...sampleProposed, rewrite: { _tag: 'Unchanged' } } as const;
    expect(learnNote({ tone: 'mischievous', outcome })).toContain(
      '\n\nYour code already follows them, so I left it alone. 😌\n\n',
    );
    expect(learnNote({ tone: 'plain', outcome })).toContain(
      '\n\nThe code already follows them, so it was not rewritten.\n\n',
    );
  });

  it('says why the rewrite was dropped, neutralising its reason', () => {
    const outcome = {
      ...sampleProposed,
      rewrite: { _tag: 'Dropped', reason: 'the tests failed twice\nsee #42' },
    } as const;
    expect(learnNote({ tone: 'mischievous', outcome })).toContain(
      "\n\nI tried rewriting this MR your way, but it didn't work out: The tests failed twice see #\u200B42. So it's just the principles this time. 💔\n\n",
    );
    expect(learnNote({ tone: 'plain', outcome })).toContain(
      '\n\nThe rewrite was dropped: The tests failed twice see #\u200B42. Only the principles are proposed.\n\n',
    );
  });

  it('links the commit when the proposal was pushed', () => {
    const outcome = {
      ...sampleProposed,
      delivery: { _tag: 'Pushed', commitUrl: 'https://gitlab.com/acme/shop/-/commit/abc123' },
    } as const;
    const link = '**[See the commit →](https://gitlab.com/acme/shop/-/commit/abc123)**';
    expect(learnNote({ tone: 'mischievous', outcome })).toContain(
      `\n\n${link}\n\nI pushed it onto this MR as its own commit. Not feeling it? It reverts cleanly.`,
    );
    expect(learnNote({ tone: 'plain', outcome })).toContain(
      `\n\n${link}\n\nPushed to this MR's branch as a separate commit, easy to revert.`,
    );
  });

  it('says it opened a merge request because GitLab refused the push', () => {
    const outcome = {
      ...sampleProposed,
      delivery: {
        _tag: 'MergeRequestInsteadOfPush',
        iid: 14,
      },
    } as const;
    expect(learnNote({ tone: 'mischievous', outcome })).toContain(
      '\n\nYou asked me to push, but GitLab turned me down (a file changed while I was learning, or the branch is protected), so I opened **!14** instead. No pushing in on anyone. 😇',
    );
    expect(learnNote({ tone: 'plain', outcome })).toContain(
      '\n\nGitLab refused the push (a file changed since the run started, or the branch is protected), so CodeTinder opened **!14** instead.',
    );
  });

  it("neutralises pings in the agent's statements and summary", () => {
    const note = learnNote({
      tone: 'plain',
      outcome: {
        ...sampleProposed,
        principles: {
          _tag: 'Learned',
          changes: [
            {
              _tag: 'Reworded',
              principle: {
                id: 'naming',
                section: 'General',
                strength: 'moderate',
                statement: 'Ask @all before !3.',
              },
            },
          ],
        },
        rewrite: {
          _tag: 'Applied',
          summary: 'renamed for #7',
          files: ['src/a.ts'],
          testCommand: 'npm test',
        },
      },
    });
    expect(note).toContain('- **Reworded** `naming` (moderate): Ask @\u200Ball before !\u200B3.');
    expect(note).toContain(
      'Rewrite: Renamed for #\u200B7. CodeTinder ran `npm test` on it, and it passed.',
    );
  });

  it('says the rewrite passed the test command, with the command defused', () => {
    const note = learnNote({
      tone: 'plain',
      outcome: {
        ...sampleProposed,
        rewrite: {
          _tag: 'Applied',
          summary: 'renamed the helper',
          files: ['src/a.ts'],
          testCommand: 'npm test @all',
        },
      },
    });
    expect(note).toContain('CodeTinder ran `npm test @\u200Ball` on it, and it passed.');
  });

  it('says a narrowed principle with its exception, and names an exception as one', () => {
    const outcome = {
      _tag: 'Proposed',
      skipped: [],
      writtenRules: [],
      rewrite: { _tag: 'Unchanged' },
      delivery: { _tag: 'MergeRequest', iid: 13 },
      principles: {
        _tag: 'Learned',
        changes: [
          {
            _tag: 'Narrowed',
            principle: {
              id: 'name-values',
              section: 'General',
              strength: 'strong',
              statement: 'Name values.',
            },
            exception: {
              id: 'inline-once',
              section: 'General',
              strength: 'tentative',
              statement: 'Inline a value used once.',
              parentId: 'name-values',
            },
          },
          {
            _tag: 'Weakened',
            principle: {
              id: 'keep-guards',
              section: 'TypeScript',
              strength: 'tentative',
              statement: 'Keep guards.',
              parentId: 'guards',
            },
          },
        ],
      },
    } as const;
    const note = learnNote({ tone: 'plain', outcome });
    expect(note).toContain(
      '- **Narrowed** `name-values` (strong): Name values. Except `inline-once` (tentative): Inline a value used once.',
    );
    expect(note).toContain(
      '- **Weakened** `keep-guards` (tentative, TypeScript, exception to `guards`): Keep guards.',
    );
  });

  it('names each operation learn answered that was not applied, and why', () => {
    const outcome = {
      _tag: 'NothingToPropose',
      skipped: [
        { operation: { op: 'drop', id: 'nowhere' }, reason: '"nowhere" is not in the doc' },
      ],
      writtenRules: [],
      rewrite: { _tag: 'Unchanged' },
    } as const;
    expect(learnNote({ tone: 'plain', outcome })).toContain(
      'Not applied:\n\n- drop `nowhere`: "nowhere" is not in the doc',
    );
    expect(learnNote({ tone: 'mischievous', outcome })).toContain(
      "A few of my ideas didn't make the cut:",
    );
  });

  it('formats nothing to propose with exact copy', () => {
    expect(
      learnNote({
        tone: 'mischievous',
        outcome: {
          _tag: 'NothingToPropose',
          skipped: [],
          writtenRules: [],
          rewrite: { _tag: 'Unchanged' },
        },
      }),
    ).toBe(`💘 **Nothing to change: you were already my type**

Your swipes confirmed the principles as they are, and this MR's code already follows them. No proposal this time.`);
    expect(
      learnNote({
        tone: 'plain',
        outcome: {
          _tag: 'NothingToPropose',
          skipped: [],
          writtenRules: [],
          rewrite: { _tag: 'Unchanged' },
        },
      }),
    ).toBe(`**CodeTinder has nothing to propose**

The swipes confirmed the current principles, and this MR's code already follows them.`);
  });

  it('still names a written rule it could not change when there is nothing to propose', () => {
    const note = learnNote({
      tone: 'plain',
      outcome: {
        _tag: 'NothingToPropose',
        skipped: [],
        rewrite: { _tag: 'Unchanged' },
        writtenRules: [
          {
            _tag: 'Skipped',
            edit: {
              path: 'CONTRIBUTING.md',
              rule: 'Always write else.',
              replacement: '',
              principleId: 'early-returns',
            },
            reason: "the rule isn't in the file as quoted",
          },
        ],
      },
    });
    expect(note).toContain("this MR's code already follows them.\n\nWritten rules:\n\n");
    expect(note).toContain(
      "- Couldn't update `CONTRIBUTING.md` (the rule isn't in the file as quoted): its rule “Always write else.” contradicts `early-returns`, so it's worth a look.",
    );
  });

  it("keeps a dropped rewrite's sandbox cause and fix MR when nothing else is proposed", () => {
    const outcome = {
      _tag: 'NothingToPropose',
      skipped: [],
      writtenRules: [],
      rewrite: {
        _tag: 'Dropped',
        reason: 'the tests fail in the sandbox before any change',
        environment: blockedTests,
        sandboxFix: { iid: 12, isNew: true },
      },
    } as const;
    const note = learnNote({ tone: 'mischievous', outcome });
    expect(note).toContain(
      '💔 **Nothing to propose this time**\n\nYour swipes confirmed the principles as they are.',
    );
    expect(note).toContain(
      'so there was nothing to check it against. 💔\n\nThey tried to reach `api.example.com`',
    );
    expect(note).not.toContain('Just the principles this time');
    expect(note).toContain('I opened **!12** with the fix.');
    expect(learnNote({ tone: 'plain', outcome })).toContain(
      'The rewrite was dropped: the tests fail in the sandbox before any change, so it could not be checked.\n\n',
    );
  });

  it('formats a failure with exact copy', () => {
    const outcome = {
      _tag: 'Failed',
      reason: 'the agent never answered',
      writtenRules: [],
    } as const;
    expect(
      learnNote({ tone: 'mischievous', outcome }),
    ).toBe(`💔 **I couldn't learn from your swipes**

The agent never answered.

Nothing on this MR changed. Press **Done** on the round again and I'll give it another go.`);
    expect(
      learnNote({ tone: 'plain', outcome }),
    ).toBe(`**CodeTinder could not learn from this round**

The agent never answered.

Nothing on this MR was changed. Press **Done** on the round again to retry.`);
  });
});

describe('learnNote for a rewrite the sandbox dropped', () => {
  it('says the rewrite could not be checked, then why, and proposes the principles', () => {
    const note = learnNote({
      tone: 'mischievous',
      outcome: {
        _tag: 'Proposed',
        skipped: [],
        principles: { _tag: 'Learned', changes: [] },
        writtenRules: [],
        rewrite: {
          _tag: 'Dropped',
          reason: 'the tests fail in the sandbox before any change',
          environment: blockedTests,
        },
        delivery: { _tag: 'MergeRequest', iid: 14 },
      },
    });
    expect(note).toContain(
      "I couldn't rewrite this MR your way: the tests fail in my sandbox before any change, so there was nothing to check it against. Just the principles this time. 💔",
    );
    expect(note).toContain(
      'They tried to reach `api.example.com`, which the sandbox blocks. Add it to',
    );
    expect(note).toContain('I put it all in **!14**.');
    expect(note).not.toContain('The rewrite was dropped');
  });

  it('gives the plain tone the same facts', () => {
    const note = learnNote({
      tone: 'plain',
      outcome: {
        _tag: 'Proposed',
        skipped: [],
        principles: { _tag: 'Learned', changes: [] },
        writtenRules: [],
        rewrite: {
          _tag: 'Dropped',
          reason: 'the tests fail in the sandbox before any change',
          environment: blockedTests,
        },
        delivery: { _tag: 'MergeRequest', iid: 14 },
      },
    });
    expect(note).toContain(
      'The rewrite was dropped: the tests fail in the sandbox before any change, so it could not be checked. Only the principles are proposed.',
    );
  });
});

describe('proposalTitle', () => {
  it("references the round's merge request in both tones", () => {
    expect(proposalTitle({ tone: 'mischievous', mergeRequestIid: 12 })).toBe(
      '💘 What I learned from your swipes on !12',
    );
    expect(proposalTitle({ tone: 'plain', mergeRequestIid: 12 })).toBe(
      'Apply the coding principles learned on !12',
    );
  });
});

describe('proposalDescription', () => {
  it('formats a mischievous description with exact copy', () => {
    expect(
      proposalDescription({ tone: 'mischievous', mergeRequestIid: 12, proposal: sampleProposed }),
    ).toBe(`💘 **What I learned from your swipes on !12**

What I learned:

- **Added** \`early-returns\` (tentative): Return early instead of nesting conditionals.
- **Strengthened** \`small-functions\` (strong): Keep functions short.
- **Dropped** \`for-loops\` (moderate): Prefer for loops.

Then I rewrote !12 your way. Flattened the branching with early returns. I ran \`pnpm test\` on it, and it passed. 😌

Files I touched 😏: \`src/summary.ts\`, \`src/format.ts\`

Merge this into !12 and it's a match. 💘`);
  });

  it('formats a plain description with exact copy', () => {
    expect(
      proposalDescription({
        tone: 'plain',
        mergeRequestIid: 12,
        proposal: {
          principles: { _tag: 'Learned', changes: sampleChanges },
          skipped: [],
          writtenRules: [],
          rewrite: { _tag: 'Unchanged' },
        },
      }),
    ).toBe(`**CodeTinder proposal for !12**

Principles:

- **Added** \`early-returns\` (tentative): Return early instead of nesting conditionals.
- **Strengthened** \`small-functions\` (strong): Keep functions short.
- **Dropped** \`for-loops\` (moderate): Prefer for loops.

The code already follows them, so it was not rewritten.

Merging this applies the change to !12.`);
  });
});

describe('proposalCommitMessage', () => {
  it('lists the changed principles', () => {
    expect(
      proposalCommitMessage({
        roundId: '019345a1b2c3',
        mergeRequestIid: 12,
        principles: { _tag: 'Learned', changes: sampleChanges },
        writtenRules: [],
      }),
    ).toBe(`style: apply the coding principles learned in round 019345a1b2c3

Learned from the swipes on !12:
- added early-returns (tentative)
- strengthened small-functions (strong)
- dropped for-loops (moderate)`);
  });

  it('says the principles held when none changed', () => {
    expect(
      proposalCommitMessage({
        roundId: '019345a1b2c3',
        mergeRequestIid: 12,
        principles: { _tag: 'Learned', changes: [] },
        writtenRules: [],
      }),
    ).toBe(`style: apply the coding principles learned in round 019345a1b2c3

The swipes on !12 confirmed the principles as they are.`);
  });

  it('says it rewrote a doc that was not in the current format', () => {
    expect(
      proposalCommitMessage({
        roundId: '019345a1b2c3',
        mergeRequestIid: 12,
        principles: { _tag: 'Reformatted', changes: [] },
        writtenRules: [],
      }),
    ).toBe(`style: apply the coding principles learned in round 019345a1b2c3

The swipes on !12 confirmed the principles as they are.

Rewrote .codetinder/principles.md in CodeTinder's current format.`);
  });
});
