import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { type Language, LanguageSchema } from './languages';

export const StrengthSchema = Schema.Literals(['tentative', 'moderate', 'strong']);
export type Strength = typeof StrengthSchema.Type;

export const PrincipleIdSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/));

/** A markdown heading line: one to six `#`, then a space or the end of the line. */
const HEADING = /^#{1,6}(?:\s|$)/;

const statementChecks = [
  Schema.isPattern(/^\S(?:[^\r\n]*\S)?$/, { message: 'must be one trimmed, non-empty line' }),
  Schema.makeFilter<string>(statement =>
    HEADING.test(statement) ? 'must not start like a heading' : undefined,
  ),
] as const;

/** One trimmed, non-empty line that doesn't read as a heading, so the doc keeps its shape. */
export const StatementSchema = Schema.String.check(...statementChecks);

/**
 * A statement described for the agent. The description goes before the checks: one set after a
 * custom check is lost from the JSON Schema.
 */
export const describedStatement = (description: string) =>
  Schema.String.annotate({ description }).check(...statementChecks);

/**
 * Where a principle holds: in any language (`General`), or only in one language's code. The doc
 * has a section for each, General first.
 */
export const SectionSchema = Schema.Literals(['General', ...LanguageSchema.literals]);
export type Section = typeof SectionSchema.Type;

const idField = PrincipleIdSchema.annotate({
  description:
    'A stable kebab-case id, unique across the whole doc, e.g. "early-returns". Keep an ' +
    "existing principle's id unchanged.",
});

const strengthField = StrengthSchema.annotate({
  description:
    'How firmly the swipes support it: "tentative" for one round, "strong" once it holds ' +
    'across several',
});

/**
 * Where a principle stops applying: its own principle, in its parent's section, with its own
 * strength, so one that later rounds don't confirm drops out the usual way.
 */
export const ExceptionSchema = Schema.Struct({
  id: idField,
  strength: strengthField,
  statement: describedStatement(
    'Where the principle does not hold and what to do there instead, on one line',
  ),
});
export type Exception = typeof ExceptionSchema.Type;

export const PrincipleSchema = Schema.Struct({
  id: idField,
  section: SectionSchema.annotate({
    description:
      '"General" for a principle that holds in any language; a language for one that only makes ' +
      "sense in that language's code",
  }),
  strength: strengthField,
  statement: describedStatement('One plain instruction a coding agent can follow, on one line'),
  exception: Schema.optionalKey(
    ExceptionSchema.annotate({ description: 'Where it stops applying, if the swipes show one' }),
  ),
});
export type Principle = typeof PrincipleSchema.Type;

/** A principle or an exception, on its own: an exception in its principle's section. */
export type Rule = {
  readonly id: string;
  readonly section: Section;
  readonly strength: Strength;
  readonly statement: string;
  /** The principle an exception is to; none on a principle. */
  readonly parentId?: string;
};

/** Every rule of the doc, in its order: each principle, then its exception. */
export const rulesOf = (principles: readonly Principle[]): Rule[] =>
  principles.flatMap(({ id, section, strength, statement, exception }) => [
    { id, section, strength, statement },
    ...(exception === undefined ? [] : [{ ...exception, section, parentId: id }]),
  ]);

/** The principles of one doc, with distinct ids, exceptions' included: the doc is read back by id. */
export const PrinciplesSchema = Schema.Array(PrincipleSchema).check(
  Schema.makeFilter<readonly Principle[]>(principles => {
    const ids = rulesOf(principles).map(({ id }) => id);
    const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
    return repeated === undefined ? undefined : `"${repeated}" is used by more than one principle`;
  }),
);

/** Where CodeTinder keeps a project's principles doc, relative to the repo root. */
export const PRINCIPLES_PATH = '.codetinder/principles.md';

/** `.codetinder/principles.md` breaks the format; `line` is 1-based. */
export class PrinciplesDocError extends Schema.TaggedError<PrinciplesDocError>()(
  'PrinciplesDocError',
  { line: Schema.Int, message: Schema.String },
) {}

/** The doc's principles by section, in the doc's order, leaving out the empty ones. */
export const groupBySection = (principles: readonly Principle[]) =>
  SectionSchema.literals.flatMap(section => {
    const inSection = principles.filter(principle => principle.section === section);
    return inSection.length === 0 ? [] : [{ section, principles: inSection }];
  });

/** The principles for code in `languages`: the general ones and those languages' sections. */
export const principlesFor = (
  principles: readonly Principle[],
  languages: ReadonlySet<Language>,
): Principle[] =>
  principles.filter(({ section }) => section === 'General' || languages.has(section));

const FORMAT = 3;
const FORMAT_COMMENT = /^<!-- codetinder principles · format (\d+)\b.*-->$/;
const TITLE = '# Coding principles';
const INTRO = "Learned from this project's swipes on https://codetinder.dev";

type Line = { readonly text: string; readonly number: number };
type ParsedPrinciple = {
  readonly principle: Principle;
  readonly line: number;
  readonly exceptionLine?: number;
};

const fail = (line: number, message: string) =>
  Result.fail(new PrinciplesDocError({ line, message }));

const formatOf = (text: string): number | undefined => {
  const format = FORMAT_COMMENT.exec(text.split(/\r?\n/, 1)[0] ?? '')?.[1];
  return format === undefined ? undefined : Number(format);
};

/** `lines` cut before each line `isStart` accepts: the lines before the first, then each block. */
const cutBefore = (lines: readonly Line[], isStart: (line: Line) => boolean) => {
  const starts = lines.flatMap((line, index) => (isStart(line) ? [index] : []));
  return {
    preamble: lines.slice(0, starts[0] ?? lines.length),
    blocks: starts.map((start, index) => lines.slice(start, starts[index + 1])),
  };
};

/**
 * Reads the principles doc, of this format or an older one. An empty file has no principles yet.
 * Anything the doc says that this can't read back fails, never dropped: the learn agent then
 * converts the doc, keeping it.
 */
export const parsePrinciplesDoc = (
  text: string,
): Result.Result<Principle[], PrinciplesDocError> => {
  if (text.trim() === '') return Result.succeed([]);

  const format = formatOf(text);
  if (format === undefined) {
    return fail(1, `expected the comment "<!-- codetinder principles · format ${FORMAT} … -->"`);
  }
  if (format > FORMAT) {
    return fail(1, `format ${format} is newer than this release reads (${FORMAT})`);
  }
  if (format < 1) return fail(1, `there is no format ${format}`);

  const lines = text.split(/\r?\n/).map((line, index) => ({ text: line, number: index + 1 }));
  const title = lines.slice(1).find(line => line.text.trim() !== '');
  if (title?.text !== TITLE) return fail(title?.number ?? 1, `expected "${TITLE}"`);

  const body = lines.slice(title.number);
  // A heading is a heading even indented; read as prose, it would hide a section or a principle.
  const indentedHeading = body.find(
    line => /^\s+#/.test(line.text) && HEADING.test(line.text.trimStart()),
  );
  if (indentedHeading !== undefined) {
    return fail(indentedHeading.number, 'a heading must start at the beginning of its line');
  }
  // Above the first `## ` heading, only the intro render writes, which every format shares.
  const { preamble } = cutBefore(body, line => line.text.startsWith('## '));
  const stray = preamble.find(line => line.text.trim() !== '' && line.text.trim() !== INTRO);
  if (stray !== undefined) {
    return fail(stray.number, `expected only "${INTRO}" above the first "## " heading`);
  }

  return Result.flatMap(
    format === 1 ? parseFormat1Body(body) : parseSections(body, format),
    principles => {
      const ids = principles.flatMap(({ principle, line, exceptionLine }) => [
        { id: principle.id, line },
        ...(principle.exception === undefined
          ? []
          : [{ id: principle.exception.id, line: exceptionLine ?? line }]),
      ]);
      const duplicate = ids.find(
        ({ id }, index) => ids.findIndex(other => other.id === id) !== index,
      );
      if (duplicate !== undefined) {
        return fail(duplicate.line, `"${duplicate.id}" is used by an earlier principle`);
      }
      return Result.succeed(principles.map(({ principle }) => principle));
    },
  );
};

/** Format 1 had no sections: a `## <id> · <strength>` per principle, all of them general. */
const parseFormat1Body = (
  body: readonly Line[],
): Result.Result<ParsedPrinciple[], PrinciplesDocError> => {
  const strayHeading = body.find(line => HEADING.test(line.text) && !line.text.startsWith('## '));
  if (strayHeading !== undefined) {
    return fail(strayHeading.number, 'expected "## <id> · <strength>"');
  }
  const { blocks } = cutBefore(body, line => line.text.startsWith('## '));
  return Result.all(blocks.map(block => parsePrinciple(block, '##', 'General')));
};

const parseSections = (
  body: readonly Line[],
  format: number,
): Result.Result<ParsedPrinciple[], PrinciplesDocError> => {
  // Format 3 adds an exception under its principle.
  const headings = format >= 3 ? /^#{2,4} / : /^#{2,3} /;
  const strayHeading = body.find(line => HEADING.test(line.text) && !headings.test(line.text));
  if (strayHeading !== undefined) {
    return fail(
      strayHeading.number,
      format >= 3
        ? `expected "## <section>", "### <id> · <strength>" or "${EXCEPTION_MARKER} <id> · <strength>"`
        : 'expected "## <section>" or "### <id> · <strength>"',
    );
  }
  const { blocks } = cutBefore(body, line => line.text.startsWith('## '));
  return Result.flatMap(Result.all(blocks.map(parseSection)), sections => {
    const repeated = sections.find(
      ({ section }, index) => sections.findIndex(other => other.section === section) !== index,
    );
    if (repeated !== undefined) {
      return fail(repeated.line, `"## ${repeated.section}" is an earlier section's heading too`);
    }
    return Result.succeed(sections.flatMap(({ principles }) => principles));
  });
};

const parseSection = ([heading, ...content]: readonly Line[]): Result.Result<
  { section: Section; line: number; principles: ParsedPrinciple[] },
  PrinciplesDocError
> => {
  if (heading === undefined) throw new Error('a section starts with its heading');

  const section = heading.text.slice('## '.length).trim();
  if (!Schema.is(SectionSchema)(section)) {
    return fail(
      heading.number,
      `"${section}" is not a section: General, or one of ${LanguageSchema.literals.join(', ')}`,
    );
  }
  const { preamble, blocks } = cutBefore(content, line => line.text.startsWith('### '));
  const stray = preamble.find(line => line.text.trim() !== '');
  if (stray !== undefined) return fail(stray.number, 'expected "### <id> · <strength>"');

  return Result.map(
    Result.all(blocks.map(block => parsePrincipleWithException(block, section))),
    principles => ({ section, line: heading.number, principles }),
  );
};

/** How an exception's heading starts, under its principle's. */
const EXCEPTION_MARKER = '#### Exception ·';

/** A `###` principle, and the `####` exception under it, if it has one. */
const parsePrincipleWithException = (
  block: readonly Line[],
  section: Section,
): Result.Result<ParsedPrinciple, PrinciplesDocError> => {
  const {
    preamble,
    blocks: [exceptionBlock, secondException],
  } = cutBefore(block, line => line.text.startsWith('#### '));
  if (secondException?.[0] !== undefined) {
    return fail(secondException[0].number, 'a principle holds at most one exception');
  }
  return Result.flatMap(parsePrinciple(preamble, '###', section), parsed => {
    if (exceptionBlock === undefined) return Result.succeed(parsed);
    return Result.map(
      parsePrinciple(exceptionBlock, EXCEPTION_MARKER, section),
      ({ principle: { id, strength, statement }, line }) => ({
        principle: { ...parsed.principle, exception: { id, strength, statement } },
        line: parsed.line,
        exceptionLine: line,
      }),
    );
  });
};

const parsePrinciple = (
  [heading, ...content]: readonly Line[],
  marker: '##' | '###' | typeof EXCEPTION_MARKER,
  section: Section,
): Result.Result<ParsedPrinciple, PrinciplesDocError> => {
  if (heading === undefined) throw new Error('a principle starts with its heading');

  const [, id, strength] =
    new RegExp(`^${marker} (\\S+) · (\\S+)$`).exec(heading.text.trimEnd()) ?? [];
  if (id === undefined || strength === undefined) {
    return fail(heading.number, `expected "${marker} <id> · <strength>"`);
  }
  if (!Schema.is(PrincipleIdSchema)(id)) {
    return fail(heading.number, `"${id}" is not a kebab-case id`);
  }
  if (!Schema.is(StrengthSchema)(strength)) {
    return fail(heading.number, `"${strength}" is not a strength: tentative, moderate or strong`);
  }

  const filled = content.filter(line => line.text.trim() !== '');
  const [first] = filled;
  if (first === undefined) return fail(heading.number, `"${id}" has no statement`);
  // One paragraph: the filled lines are consecutive.
  const secondParagraph = filled.find((line, index) => line.number !== first.number + index);
  if (secondParagraph !== undefined) {
    return fail(secondParagraph.number, `"${id}" must be stated in one paragraph`);
  }

  return Result.succeed({
    principle: {
      id,
      section,
      strength,
      statement: filled.map(line => line.text.trim()).join(' '),
    },
    line: heading.number,
  });
};

export const renderPrinciplesDoc = (principles: readonly Principle[]): string =>
  `${[
    `<!-- codetinder principles · format ${FORMAT} · edit freely, keep the ids -->\n${TITLE}`,
    INTRO,
    ...groupBySection(principles).flatMap(({ section, principles }) => [
      `## ${section}`,
      ...principles.flatMap(({ id, strength, statement, exception }) => [
        `### ${id} · ${strength}\n${statement}`,
        ...(exception === undefined
          ? []
          : [
              `${EXCEPTION_MARKER} ${exception.id} · ${exception.strength}\n${exception.statement}`,
            ]),
      ]),
    ]),
  ].join('\n\n')}\n`;

/**
 * The doc a learn run starts from. `isNormalised` says whether it reads exactly as render writes
 * it; one that doesn't (an older format, or edited by hand) is rewritten by the run. One in another
 * format (a team's own style guide, or ours edited out of shape) is `Unconverted`: the learn agent
 * converts it.
 */
export type CurrentPrinciples =
  | {
      readonly _tag: 'Parsed';
      readonly principles: readonly Principle[];
      readonly isNormalised: boolean;
    }
  | { readonly _tag: 'Unconverted'; readonly text: string };

/**
 * Reads the doc a learn run starts from. A newer format of ours still fails: converting it would
 * lose what the newer release wrote.
 */
export const readCurrentPrinciples = (
  text: string,
): Result.Result<CurrentPrinciples, PrinciplesDocError> => {
  const parsed = parsePrinciplesDoc(text);
  if (Result.isSuccess(parsed)) {
    const principles = parsed.success;
    return Result.succeed({
      _tag: 'Parsed',
      principles,
      isNormalised: text.trim() === '' || text === renderPrinciplesDoc(principles),
    });
  }
  const format = formatOf(text);
  if (format !== undefined && format > FORMAT) return Result.fail(parsed.failure);
  return Result.succeed({ _tag: 'Unconverted', text });
};
