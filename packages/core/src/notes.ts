import type { WrittenRuleUpdate } from './agent-instructions';
import { code, fence } from './fence';
import { REST_ROUNDS } from './freshness';
import type {
  Delivery,
  LearnOutcome,
  PrincipleChange,
  PrinciplesUpdate,
  RewriteOutcome,
} from './learn';
import type { SkippedOperation } from './learn-operations';
import { PRINCIPLES_PATH, type Rule, rulesOf } from './principles';
import type { ProjectConfig } from './project-config';
import type { Round } from './round';
import type { Diagnosis, EnvironmentFailure } from './sandbox-diagnosis';
import type { SandboxFixMergeRequest } from './sandbox-fix';
import { oneLine } from './verify';

/**
 * Untrusted text as it can't ping or link: a zero-width space after a GitLab reference sigil
 * (`@all`, `#12`, `!3`, …) defuses it, and one inside each link, image, tag or bare URL keeps it
 * plain text, so a prompt in an MR can't put a link in a note the flow posts. Lines are kept.
 */
const defuse = (text: string): string =>
  text
    .replaceAll(/([@#!~%$&])(?=\w)/g, '$1\u200B')
    .replaceAll('](', ']\u200B(')
    .replaceAll('<', '<\u200B')
    .replaceAll('://', ':\u200B//')
    .replaceAll(/\b(www)\./gi, '$1\u200B.');

/** Untrusted text as one line, defused. */
export const plain = (text: string): string => defuse(oneLine(text));

const formatSentence = (sentence: string): string => {
  const trimmed = sentence.trim();
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  const endsSentence = /[.!?…]$/.test(capitalized);
  return endsSentence ? capitalized : `${capitalized}.`;
};

export const roundNote = ({
  tone,
  round,
  url,
  serviceAccount,
  isFresh,
  eligibleCards,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly round: Pick<Round, 'target' | 'reason' | 'cards'>;
  readonly url: string;
  /** The flow's service account: mentioning it with `round` asks for a fresh round. */
  readonly serviceAccount: string;
  /** Whether the round replaces the commit's earlier one, which a developer asked for. */
  readonly isFresh: boolean;
  /**
   * How many of the round's cards ask a question outside the project's latest judged rounds;
   * absent when the questions couldn't be read, so the note claims nothing.
   */
  readonly eligibleCards?: number;
}): string => {
  const symbol = code(round.target.symbol);
  const file = code(round.target.file);
  const count = round.cards.length;
  const reason = formatSentence(plain(round.reason));
  // Its own paragraph, so GitLab doesn't set the QR on the text's line.
  const qr = `![QR code: scan to swipe on your phone](${url}/qr.png){width=140 height=140}`;
  const command = code(`@${serviceAccount} round`);
  const freshness =
    eligibleCards === undefined
      ? ''
      : `${eligibleCards} of these ${count} cards explore questions outside the project's last ${REST_ROUNDS} judged rounds.`;
  const mischievousFreshness = freshness === '' ? '' : ` Fresh faces: ${freshness}`;
  const plainFreshness = freshness === '' ? '' : ` ${freshness}`;

  if (tone === 'mischievous') {
    return `💘 **${isFresh ? 'Fresh round: ' : ''}${symbol} caught my eye** · ${file}

${reason} So I tried ${count} little changes on it, one per card; each one's meant to behave just like yours, and your tests agree.${mischievousFreshness} Like the ones you prefer, and show me your type:

**[Swipe on the round →](${url})**

Prefer to swipe on your phone? Scan me 📱💘

${qr}

When you're done, press **Done** and I'll learn from your swipes, then propose this MR rewritten your way. Not your type? Mention ${command} and I'll deal fresh cards.`;
  }

  return `**CodeTinder ${isFresh ? 'fresh round' : 'round'}: ${symbol}** · ${file}

${reason} CodeTinder made ${count} cards, each one small change to this function, meant to behave like the original, and the project's tests pass on it.${plainFreshness} Like a card if you prefer the change, dislike it if you prefer the original.

**[Swipe on the round →](${url})**

Or scan to open it on your phone:

${qr}

After swiping, press **Done**: CodeTinder learns from the swipes and proposes a rewrite of this MR in that style. For a fresh round on the latest commit, mention ${command}.`;
};

/** The stage's words: its name, the verb for its failure, the pronoun, and the config key running it. */
const STAGE = {
  install: {
    noun: 'install',
    verb: 'fails',
    pronoun: 'it',
    key: 'install',
    alternative: "an install that doesn't need the network",
  },
  tests: {
    noun: 'tests',
    verb: 'fail',
    pronoun: 'they',
    key: 'test',
    alternative: "tests that don't need the network",
  },
} as const;

const diagnosisCause = (
  pronoun: string,
  { diagnosis, outputTail }: Pick<EnvironmentFailure, 'diagnosis' | 'outputTail'>,
): string => {
  if (diagnosis._tag === 'BlockedHosts') {
    const hosts = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(
      diagnosis.hosts.map(code),
    );
    return `${pronoun} tried to reach ${hosts}, which the sandbox blocks`;
  }
  if (diagnosis._tag === 'ReadOnlyPaths') {
    const paths = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(
      diagnosis.paths.map(code),
    );
    return `${pronoun} tried to write to ${paths}, which the sandbox keeps read-only`;
  }
  if (diagnosis._tag === 'MissingLibraries') {
    const libraries = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(
      diagnosis.libraries.map(code),
    );
    return `${pronoun} needs ${libraries}, which the sandbox's image doesn't have`;
  }
  if (diagnosis._tag === 'TimedOut') return `${pronoun} ran past the sandbox's time limit`;
  return outputTail.trim() === '' ? `${pronoun} printed no output` : "the output doesn't say why";
};

/** What to change, for the diagnosis: the allow-list, where to write, a faster command, or the common causes. */
const environmentAdvice = (stage: EnvironmentFailure['stage'], diagnosis: Diagnosis): string => {
  const { key, alternative } = STAGE[stage];
  const command = `${code(key)} in ${code('.codetinder/config.json')}`;
  const allowList = `${code('network_policy.allowed_domains')} in ${code('.gitlab/duo/agent-config.yml')}`;
  if (diagnosis._tag === 'BlockedHosts') {
    const them = diagnosis.hosts.length === 1 ? 'it' : 'them';
    return `Add ${them} to ${allowList}, or point ${command} at ${alternative}.`;
  }
  if (diagnosis._tag === 'ReadOnlyPaths') {
    return `The sandbox lets a command write only to the checkout and ${code('/tmp')}; point the cache or output it writes elsewhere at ${code('/tmp')}, for example with an environment variable in ${command}.`;
  }
  if (diagnosis._tag === 'MissingLibraries') {
    const packages = diagnosis.libraries.map(library => library.replace(/\.so.*$/, '')).join(' ');
    const it = diagnosis.libraries.length === 1 ? 'it' : 'them';
    return `Install ${it} before the sandbox starts, with ${code('setup_script')} in ${code('.gitlab/duo/agent-config.yml')} (for example ${code(`microdnf install -y ${packages}`)}), or point the project's Node at a version that doesn't need ${it}.`;
  }
  if (diagnosis._tag === 'TimedOut') return `Point ${command} at a faster command.`;
  return `Common causes: a host the sandbox blocks (allow it in ${allowList}); a secret or environment variable that isn't set here (CI/CD variables aren't available); a service that isn't running here, such as a database; a command that runs past the time limit (point ${command} at a faster one).`;
};

/**
 * What ran and how it ended, as one line: the command is the project's own config, and the exit code
 * says what an empty output can't. Nothing for a check stopped at its deadline, which has no one command.
 */
const environmentCommand = ({ command, exitCode }: EnvironmentFailure): string =>
  command === undefined || exitCode === undefined
    ? ''
    : `It ran ${code(command)} and exited with code ${exitCode}.`;

/**
 * `user:password@` in a URL, which the sandbox's proxy variables carry and a failing tool may print
 * back; the note is public and the credentials are the job's.
 */
const URL_CREDENTIALS = /(\/\/)[^\s/@]+:[^\s/@]*@/g;

/** The output a failure left, collapsed under a details block; nothing when it left none. */
const environmentOutput = (outputTail: string): string =>
  outputTail.trim() === ''
    ? ''
    : `<details><summary>Output</summary>\n\n${fence(defuse(outputTail.replaceAll(URL_CREDENTIALS, '$1***@')))}\n\n</details>`;

/** Blocks separated by a blank line, leaving out the empty ones. */
const paragraphs = (blocks: readonly string[]): string =>
  blocks.filter(block => block !== '').join('\n\n');

/** Where the fix for the sandbox waits: nothing when CodeTinder proposed none. */
const sandboxFixLine = (
  tone: ProjectConfig['tone'],
  sandboxFix: SandboxFixMergeRequest | undefined,
): string => {
  if (sandboxFix === undefined) return '';
  const fix = `**!${sandboxFix.iid}**`;
  if (tone === 'mischievous') {
    return sandboxFix.isNew
      ? `I opened ${fix} with the fix. Merge it and your next MR gets a round. 🔧`
      : `The fix is in ${fix}. Merge it and your next MR gets a round. 🔧`;
  }
  return sandboxFix.isNew
    ? `CodeTinder opened ${fix} with the fix: merge it and the next merge request gets a round.`
    : `The fix is in ${fix}: merge it and the next merge request gets a round.`;
};

/** A round skipped because the sandbox, not the change, made its install or tests fail. */
const environmentNote = ({
  tone,
  environment,
  sandboxFix,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly environment: EnvironmentFailure;
  readonly sandboxFix: SandboxFixMergeRequest | undefined;
}): string => {
  const { stage, diagnosis, outputTail } = environment;
  const { noun, verb, pronoun } = STAGE[stage];
  const cause = diagnosisCause(pronoun, environment);
  const advice = environmentAdvice(stage, diagnosis);

  if (tone === 'mischievous') {
    return paragraphs([
      `💔 **Your ${noun} can't run in my sandbox**`,
      `${formatSentence(`${pronoun} ${verb} before I change a thing: ${cause}`)} ${advice}`,
      sandboxFixLine(tone, sandboxFix),
      "Nothing on this MR changed. I'll try again on your next one.",
      environmentCommand(environment),
      environmentOutput(outputTail),
    ]);
  }

  return paragraphs([
    `**CodeTinder could not run the ${noun} in its sandbox**`,
    `${formatSentence(`the ${noun} ${verb} before any change: ${cause}`)} ${advice}`,
    sandboxFixLine(tone, sandboxFix),
    'Nothing on this MR was changed.',
    environmentCommand(environment),
    environmentOutput(outputTail),
  ]);
};

export const skippedNote = ({
  tone,
  reason,
  environment,
  sandboxFix,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly reason: string;
  readonly environment?: EnvironmentFailure;
  /** The MR fixing the sandbox for `environment`'s failure, when CodeTinder proposed one. */
  readonly sandboxFix?: SandboxFixMergeRequest;
}): string => {
  if (environment !== undefined) return environmentNote({ tone, environment, sandboxFix });

  const formattedReason = formatSentence(plain(reason));

  if (tone === 'mischievous') {
    return `💔 **No round this time**

${formattedReason}

Nothing on this MR changed. I'll try again on your next one.`;
  }

  return `**CodeTinder skipped this merge request**

${formattedReason}

Nothing on this MR was changed.`;
};

/** The note on a merge request from a fork: the flow never runs a fork's code, so it stops there. */
export const forkNote = ({ tone }: { readonly tone: ProjectConfig['tone'] }): string => {
  if (tone === 'mischievous') {
    return `💔 **I only swipe on this project's branches**

This merge request comes from a fork, and I never run a fork's code, so I'm passing on it. Nothing on this MR changed.`;
  }

  return `**CodeTinder skipped this merge request**

CodeTinder only runs on merge requests from branches in this project, not from forks, because it never runs a fork's code.

Nothing on this MR was changed.`;
};

/**
 * The note on a merge request that changes no code, which the flow passes on before the agent runs.
 * `files` are the changed files, named up to a few.
 */
export const noCodeNote = ({
  tone,
  files,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly files: readonly string[];
}): string => {
  const NAMED = 3;
  const named = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format([
    ...files.slice(0, NAMED).map(code),
    ...(files.length > NAMED ? [`${files.length - NAMED} more`] : []),
  ]);
  if (tone === 'mischievous') {
    return `💔 **No round this time**

This merge request changes no code, only ${named}, so I have no function to rewrite. I'll try again on your next one.`;
  }

  return `**CodeTinder skipped this merge request**

This merge request changes no code, only ${named}, so there is no function to make cards from.

Nothing on this MR was changed.`;
};

/**
 * The reply **Done** posts in the round's thread, as the developer: mentioning the flow's service
 * account with `learn <round id>` is what starts the learn run.
 */
export const learnReply = ({
  serviceAccount,
  roundId,
}: {
  readonly serviceAccount: string;
  readonly roundId: string;
}): string =>
  `Swiped 💘 Now show me you were paying attention:\n\n@${serviceAccount} learn ${roundId}`;

type Proposal = Omit<Extract<LearnOutcome, { readonly _tag: 'Proposed' }>, '_tag' | 'delivery'>;

const principleLine = ({ id, section, strength, statement, parentId }: Rule): string => {
  const labels = [
    strength,
    ...(section === 'General' ? [] : [section]),
    ...(parentId === undefined ? [] : [`exception to ${code(parentId)}`]),
  ];
  return `${code(id)} (${labels.join(', ')}): ${plain(statement)}`;
};

const changeLine = (change: PrincipleChange): string => {
  if (change._tag === 'Narrowed') {
    const { principle, exception } = change;
    return `- **Narrowed** ${principleLine(principle)} Except ${code(exception.id)} (${exception.strength}): ${plain(exception.statement)}`;
  }
  const { _tag, principle } = change;
  return `- **${_tag === 'Moved' ? `Moved to ${principle.section}` : _tag}** ${principleLine(principle)}`;
};

const principlesSection = ({
  tone,
  principles,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly principles: PrinciplesUpdate;
}): string => {
  if (principles._tag === 'Converted') {
    const path = code(PRINCIPLES_PATH);
    const lines = rulesOf(principles.principles)
      .map(rule => `- ${principleLine(rule)}`)
      .join('\n');
    return tone === 'mischievous'
      ? `Your ${path} had wandered out of my format, so I put it back, kept every rule, and added what your swipes taught me:\n\n${lines}`
      : `Converted ${path} back into CodeTinder's format, keeping its rules, and updated it from the swipes:\n\n${lines}`;
  }
  const learned = (() => {
    if (principles.changes.length === 0) {
      return tone === 'mischievous'
        ? 'Your swipes confirmed the principles you already had, so nothing new there.'
        : 'The swipes confirmed the current principles; none changed.';
    }
    const lines = principles.changes.map(changeLine).join('\n');
    return tone === 'mischievous' ? `What I learned:\n\n${lines}` : `Principles:\n\n${lines}`;
  })();
  if (principles._tag === 'Learned') return learned;
  const path = code(PRINCIPLES_PATH);
  return `${learned}\n\n${
    tone === 'mischievous'
      ? `I also tidied ${path} into my current format: general principles first, then one section per language.`
      : `Rewrote ${path} in CodeTinder's current format: general principles, then one section per language.`
  }`;
};

/** The operations learn answered that weren't applied, and why; nothing when every one was. */
const skippedSection = ({
  tone,
  skipped,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly skipped: readonly SkippedOperation[];
}): string => {
  if (skipped.length === 0) return '';
  const lines = skipped
    .map(({ operation, reason }) => `- ${operation.op} ${code(operation.id)}: ${plain(reason)}`)
    .join('\n');
  return tone === 'mischievous'
    ? `A few of my ideas didn't make the cut:\n\n${lines}`
    : `Not applied:\n\n${lines}`;
};

/** A rule as the notes quote it: one line, defused, cut short past a sentence or two. */
const quote = (rule: string): string => {
  const line = plain(rule);
  return `“${line.length > 140 ? `${line.slice(0, 139)}…` : line}”`;
};

const writtenRuleLine = (update: WrittenRuleUpdate): string => {
  const { path, rule, replacement, principleId } = update.edit;
  const file = code(path);
  const principle = code(principleId);
  if (update._tag === 'Skipped') {
    return `- Couldn't update ${file} (${plain(update.reason)}): its rule ${quote(rule)} contradicts ${principle}, so it's worth a look.`;
  }
  if (replacement.trim() === '') {
    return `- Updated ${file}: removed the rule ${quote(rule)}, which ${principle} contradicts.`;
  }
  return `- Updated ${file}: the rule ${quote(rule)} now reads ${quote(replacement)}, as ${principle} has it.`;
};

/** How the team's written rules were brought in line with the principles; nothing when untouched. */
const writtenRulesSection = ({
  tone,
  writtenRules,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly writtenRules: readonly WrittenRuleUpdate[];
}): string => {
  if (writtenRules.length === 0) return '';
  const lines = writtenRules.map(writtenRuleLine).join('\n');
  return tone === 'mischievous'
    ? `Your written rules now agree with your swipes, so your agents hear one story:\n\n${lines}`
    : `Written rules:\n\n${lines}`;
};

/** `target` is how the copy names the merge request the round was on: "this MR" or its reference. */
const rewriteSection = ({
  tone,
  rewrite,
  target,
  isPrinciplesProposed = true,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly rewrite: RewriteOutcome;
  readonly target: string;
  /** Whether the proposal still has the principles in it, which a dropped rewrite says it falls back to. */
  readonly isPrinciplesProposed?: boolean;
}): string => {
  const onlyPrinciples = (() => {
    if (!isPrinciplesProposed) return tone === 'mischievous' ? ' 💔' : '';
    return tone === 'mischievous'
      ? ' Just the principles this time. 💔'
      : ' Only the principles are proposed.';
  })();
  if (rewrite._tag === 'Unchanged') {
    return tone === 'mischievous'
      ? 'Your code already follows them, so I left it alone. 😌'
      : 'The code already follows them, so it was not rewritten.';
  }
  if (rewrite._tag === 'Dropped' && rewrite.environment !== undefined) {
    const { stage, diagnosis, outputTail } = rewrite.environment;
    const { noun, verb, pronoun } = STAGE[stage];
    const sentence =
      tone === 'mischievous'
        ? `I couldn't rewrite ${target} your way: the ${noun} ${verb} in my sandbox before any change, so there was nothing to check it against.${onlyPrinciples}`
        : `The rewrite was dropped: the ${noun} ${verb} in the sandbox before any change, so it could not be checked.${onlyPrinciples}`;
    return paragraphs([
      sentence,
      `${formatSentence(diagnosisCause(pronoun, { diagnosis, outputTail }))} ${environmentAdvice(stage, diagnosis)}`,
      sandboxFixLine(tone, rewrite.sandboxFix),
      environmentCommand(rewrite.environment),
      environmentOutput(outputTail),
    ]);
  }
  if (rewrite._tag === 'Dropped') {
    const reason = formatSentence(plain(rewrite.reason));
    return tone === 'mischievous'
      ? `I tried rewriting ${target} your way, but it didn't work out: ${reason}${isPrinciplesProposed ? " So it's just the principles this time. 💔" : ' 💔'}`
      : `The rewrite was dropped: ${reason}${onlyPrinciples}`;
  }
  const summary = formatSentence(plain(rewrite.summary));
  // The command is the MR's own config, so it is untrusted text as the summary is.
  const testCommand = code(plain(rewrite.testCommand));
  const checked =
    tone === 'mischievous'
      ? `I ran ${testCommand} on it, and it passed. 😌`
      : `CodeTinder ran ${testCommand} on it, and it passed.`;
  const files = rewrite.files.map(code).join(', ');
  return tone === 'mischievous'
    ? `Then I rewrote ${target} your way. ${summary} ${checked}\n\nFiles I touched 😏: ${files}`
    : `Rewrite: ${summary} ${checked}\n\nFiles changed: ${files}`;
};

const deliverySection = ({
  tone,
  delivery,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly delivery: Delivery;
}): string => {
  if (delivery._tag === 'Pushed') {
    const link = `**[See the commit →](${delivery.commitUrl})**`;
    return tone === 'mischievous'
      ? `${link}\n\nI pushed it onto this MR as its own commit. Not feeling it? It reverts cleanly.`
      : `${link}\n\nPushed to this MR's branch as a separate commit, easy to revert.`;
  }
  // GitLab links `!n` itself, and shows the MR's title and state on hover.
  const proposal = `**!${delivery.iid}**`;
  if (delivery._tag === 'MergeRequestInsteadOfPush') {
    return tone === 'mischievous'
      ? `You asked me to push, but GitLab turned me down (a file changed while I was learning, or the branch is protected), so I opened ${proposal} instead. No pushing in on anyone. 😇`
      : `GitLab refused the push (a file changed since the run started, or the branch is protected), so CodeTinder opened ${proposal} instead.`;
  }
  return tone === 'mischievous'
    ? `I put it all in ${proposal}. Merge it and it's a match. 💘`
    : `Proposed in ${proposal}: merging it applies the change to this MR's branch.`;
};

/** The note the learn run posts in the round's thread. */
export const learnNote = ({
  tone,
  outcome,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly outcome: LearnOutcome;
}): string => {
  if (outcome._tag === 'Failed') {
    const reason = formatSentence(plain(outcome.reason));
    return paragraphs([
      tone === 'mischievous'
        ? `💔 **I couldn't learn from your swipes**\n\n${reason}\n\nNothing on this MR changed. Press **Done** on the round again and I'll give it another go.`
        : `**CodeTinder could not learn from this round**\n\n${reason}\n\nNothing on this MR was changed. Press **Done** on the round again to retry.`,
      writtenRulesSection({ tone, writtenRules: outcome.writtenRules }),
    ]);
  }
  if (outcome._tag === 'NothingToPropose' && outcome.rewrite._tag === 'Unchanged') {
    return paragraphs([
      tone === 'mischievous'
        ? `💘 **Nothing to change: you were already my type**\n\nYour swipes confirmed the principles as they are, and this MR's code already follows them. No proposal this time.`
        : `**CodeTinder has nothing to propose**\n\nThe swipes confirmed the current principles, and this MR's code already follows them.`,
      skippedSection({ tone, skipped: outcome.skipped }),
      writtenRulesSection({ tone, writtenRules: outcome.writtenRules }),
    ]);
  }
  if (outcome._tag === 'NothingToPropose') {
    return paragraphs([
      tone === 'mischievous'
        ? `💔 **Nothing to propose this time**\n\nYour swipes confirmed the principles as they are.`
        : `**CodeTinder has nothing to propose**\n\nThe swipes confirmed the current principles.`,
      rewriteSection({
        tone,
        rewrite: outcome.rewrite,
        target: 'this MR',
        isPrinciplesProposed: false,
      }),
      skippedSection({ tone, skipped: outcome.skipped }),
      writtenRulesSection({ tone, writtenRules: outcome.writtenRules }),
    ]);
  }
  return paragraphs([
    tone === 'mischievous'
      ? '💘 **I learned your type from your swipes**'
      : '**CodeTinder learned from this round**',
    principlesSection({ tone, principles: outcome.principles }),
    skippedSection({ tone, skipped: outcome.skipped }),
    writtenRulesSection({ tone, writtenRules: outcome.writtenRules }),
    rewriteSection({ tone, rewrite: outcome.rewrite, target: 'this MR' }),
    deliverySection({ tone, delivery: outcome.delivery }),
  ]);
};

export const proposalTitle = ({
  tone,
  mergeRequestIid,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly mergeRequestIid: number;
}): string =>
  tone === 'mischievous'
    ? `💘 What I learned from your swipes on !${mergeRequestIid}`
    : `Apply the coding principles learned on !${mergeRequestIid}`;

/** The proposal merge request's description; it references the round's MR so GitLab links the two. */
export const proposalDescription = ({
  tone,
  mergeRequestIid,
  proposal,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly mergeRequestIid: number;
  readonly proposal: Proposal;
}): string => {
  const target = `!${mergeRequestIid}`;
  return paragraphs([
    tone === 'mischievous'
      ? `💘 **What I learned from your swipes on ${target}**`
      : `**CodeTinder proposal for ${target}**`,
    principlesSection({ tone, principles: proposal.principles }),
    skippedSection({ tone, skipped: proposal.skipped }),
    writtenRulesSection({ tone, writtenRules: proposal.writtenRules }),
    rewriteSection({ tone, rewrite: proposal.rewrite, target }),
    tone === 'mischievous'
      ? `Merge this into ${target} and it's a match. 💘`
      : `Merging this applies the change to ${target}.`,
  ]);
};

export const proposalCommitMessage = ({
  roundId,
  mergeRequestIid,
  principles,
  writtenRules,
}: {
  readonly roundId: string;
  readonly mergeRequestIid: number;
  readonly principles: PrinciplesUpdate;
  readonly writtenRules: readonly WrittenRuleUpdate[];
}): string => {
  const updated = writtenRules.flatMap(({ _tag, edit }) =>
    _tag === 'Updated'
      ? [
          `- ${edit.replacement.trim() === '' ? 'removed' : 'reworded'} a rule in ${edit.path} that ${edit.principleId} contradicts`,
        ]
      : [],
  );
  const rules =
    updated.length === 0 ? '' : `\n\nBrought the written rules in line:\n${updated.join('\n')}`;
  return `${principlesCommitMessage({ roundId, mergeRequestIid, principles })}${rules}`;
};

const principlesCommitMessage = ({
  roundId,
  mergeRequestIid,
  principles,
}: {
  readonly roundId: string;
  readonly mergeRequestIid: number;
  readonly principles: PrinciplesUpdate;
}): string => {
  const subject = `style: apply the coding principles learned in round ${roundId}`;
  if (principles._tag === 'Converted') {
    const lines = principles.principles.map(({ id, strength }) => `- ${id} (${strength})`);
    return `${subject}\n\nConverted ${PRINCIPLES_PATH} back into CodeTinder's format and learned from the swipes on !${mergeRequestIid}:\n${lines.join('\n')}`;
  }
  const reformatted =
    principles._tag === 'Reformatted'
      ? `\n\nRewrote ${PRINCIPLES_PATH} in CodeTinder's current format.`
      : '';
  if (principles.changes.length === 0) {
    return `${subject}\n\nThe swipes on !${mergeRequestIid} confirmed the principles as they are.${reformatted}`;
  }
  const lines = principles.changes.map(
    ({ _tag, principle }) => `- ${_tag.toLowerCase()} ${principle.id} (${principle.strength})`,
  );
  return `${subject}\n\nLearned from the swipes on !${mergeRequestIid}:\n${lines.join('\n')}${reformatted}`;
};
