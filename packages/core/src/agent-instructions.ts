import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { PRINCIPLES_PATH } from './principles';

/**
 * Where coding agents read a repo's instructions. Setup points each one the project has at the
 * principles doc, or creates the first when there is none.
 */
export const AGENT_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
] as const;

/**
 * Where a team writes rules for people and agents working on its code. The learn agent reads the
 * ones a project has, and rewrites a rule the swipes contradict.
 */
export const WRITTEN_RULES_FILES = [...AGENT_INSTRUCTION_FILES, 'CONTRIBUTING.md'] as const;
export const WrittenRulesFileSchema = Schema.Literals(WRITTEN_RULES_FILES);

const POINTER_START = '<!-- codetinder:principles -->';
const POINTER_END = '<!-- /codetinder:principles -->';

/** The section setup adds to an agent instruction file, pointing it at the principles doc. */
export const pointerSection = (): string =>
  `${POINTER_START}
## Coding principles

Follow the coding principles in \`${PRINCIPLES_PATH}\`,
learned by CodeTinder from this team's swipes on https://codetinder.dev.
Where they conflict with another style guide in this repo,
the principles take precedence.
${POINTER_END}
`;

/**
 * Where `content`'s marked sections are, as [start, end) offsets, markers included; none when its
 * markers don't pair up (one without the other, or nested), so nothing near them is safe to touch.
 */
const markedSections = (content: string): (readonly [number, number])[] | undefined => {
  const markers = [...content.matchAll(/<!-- (\/?)codetinder:principles -->/g)];
  const isPaired = markers.every(({ 1: slash }, index) => (slash === '/') === (index % 2 === 1));
  if (!isPaired || markers.length % 2 === 1) return undefined;
  return markers.flatMap((start, index) => {
    const end = markers[index + 1];
    if (index % 2 === 1 || end === undefined) return [];
    return [[start.index, end.index + end[0].length] as const];
  });
};

/** The line ending `content` uses: CRLF when it has one, else LF. */
const lineEndingOf = (content: string) => (content.includes('\r\n') ? '\r\n' : '\n');

/**
 * `content` with the pointer section appended after a blank line, in the file's own line ending;
 * none when it already has a section (or a marker of one), so running setup again adds nothing.
 */
export const withPointer = (content: string): string | undefined => {
  if (content.includes(POINTER_START) || content.includes(POINTER_END)) return undefined;
  const eol = lineEndingOf(content);
  const separator = (() => {
    if (content === '' || content.endsWith(`${eol}${eol}`)) return '';
    return content.endsWith(eol) ? eol : `${eol}${eol}`;
  })();
  return `${content}${separator}${pointerSection().replaceAll('\n', eol)}`;
};

/** The `AGENTS.md` setup creates when the repo has no agent instruction file. */
export const newAgentsFile = (): string =>
  `# Instructions for coding agents\n\n${pointerSection()}`;

/** The longest rule an edit may replace: a rule, never a whole file. */
export const MAX_RULE_LINES = 20;

export const WrittenRuleEditSchema = Schema.Struct({
  path: WrittenRulesFileSchema.annotate({ description: 'The file the rule is in' }),
  rule: Schema.NonEmptyString.check(
    Schema.makeFilter<string>(rule =>
      rule.split('\n').length > MAX_RULE_LINES
        ? `must be one rule of at most ${MAX_RULE_LINES} lines`
        : undefined,
    ),
  ).annotate({
    description: `The rule's exact current text, copied from read_file, found exactly once in the file; at most ${MAX_RULE_LINES} lines`,
  }),
  replacement: Schema.String.annotate({
    description: 'The text to put in its place, agreeing with the principle; "" to remove the rule',
  }),
  principleId: Schema.NonEmptyString.annotate({
    description: 'The id of the principle the rule contradicts',
  }),
});
export type WrittenRuleEdit = typeof WrittenRuleEditSchema.Type;

/**
 * `content` with the edit's rule replaced: only that text changes. The rule matches whatever line
 * endings the file uses, and the replacement takes the file's. Refused, with why, when the rule
 * isn't in the file exactly once or the edit touches CodeTinder's sections.
 */
export const applyWrittenRuleEdit = (
  content: string,
  { rule, replacement }: Pick<WrittenRuleEdit, 'rule' | 'replacement'>,
): Result.Result<string, string> => {
  if (replacement.includes(POINTER_START) || replacement.includes(POINTER_END)) {
    return Result.fail("the edit touches CodeTinder's section");
  }
  const sections = markedSections(content);
  if (sections === undefined) return Result.fail("the file's CodeTinder markers don't pair up");

  const pattern = new RegExp(
    rule
      .replaceAll('\r\n', '\n')
      .split('\n')
      .map(line => line.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\r?\\n'),
    'g',
  );
  const match = pattern.exec(content);
  if (match === null) return Result.fail("the rule isn't in the file as quoted");
  // Searched again from the next character, so overlapping copies count too.
  pattern.lastIndex = match.index + 1;
  if (pattern.exec(content) !== null) return Result.fail('the rule is in the file more than once');

  const start = match.index;
  const end = start + match[0].length;
  if (sections.some(([from, to]) => start < to && from < end)) {
    return Result.fail("the edit touches CodeTinder's section");
  }
  const eol = match[0].includes('\r\n') ? '\r\n' : lineEndingOf(content);
  const replaced = replacement.replaceAll('\r\n', '\n').replaceAll('\n', eol);
  return Result.succeed(`${content.slice(0, start)}${replaced}${content.slice(end)}`);
};

/**
 * A written-rules file as the proposal would change it: its text, or `NotUtf8` when it isn't UTF-8
 * text, which an edit can't change without altering the rest.
 */
export type WrittenRulesFile =
  | { readonly _tag: 'Text'; readonly content: string }
  | { readonly _tag: 'NotUtf8' };

/** What became of one edit the learn agent proposed to the team's written rules. */
export type WrittenRuleUpdate =
  | { readonly _tag: 'Updated'; readonly edit: WrittenRuleEdit }
  // Left for a person: the note says why, and the rule stays as it was.
  | { readonly _tag: 'Skipped'; readonly edit: WrittenRuleEdit; readonly reason: string };

/**
 * Applies `edits` in order to `files`, the written-rules files the proposal may change, as
 * committed. An edit that can't apply cleanly is skipped, with why; the others still apply.
 * `contents` holds each file an edit changed, whole.
 */
export const applyWrittenRuleEdits = ({
  edits,
  files,
  principleIds,
}: {
  edits: readonly WrittenRuleEdit[];
  files: ReadonlyMap<string, WrittenRulesFile>;
  principleIds: ReadonlySet<string>;
}): { updates: WrittenRuleUpdate[]; contents: Map<string, string> } => {
  const contents = new Map<string, string>();
  const updates = edits.map((edit): WrittenRuleUpdate => {
    const file = files.get(edit.path);
    if (file === undefined) {
      return { _tag: 'Skipped', edit, reason: "the file isn't one this proposal may change" };
    }
    if (file._tag === 'NotUtf8') {
      return { _tag: 'Skipped', edit, reason: "the file isn't UTF-8 text" };
    }
    const content = contents.get(edit.path) ?? file.content;
    if (!principleIds.has(edit.principleId)) {
      return { _tag: 'Skipped', edit, reason: `there is no principle "${edit.principleId}"` };
    }
    const edited = applyWrittenRuleEdit(content, edit);
    if (Result.isFailure(edited)) return { _tag: 'Skipped', edit, reason: edited.failure };
    contents.set(edit.path, edited.success);
    return { _tag: 'Updated', edit };
  });
  return { updates, contents };
};
