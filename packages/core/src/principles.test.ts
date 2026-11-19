import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import {
  groupBySection,
  type Principle,
  PrinciplesSchema,
  parsePrinciplesDoc,
  principlesFor,
  readCurrentPrinciples,
  renderPrinciplesDoc,
} from './principles';

const principles: Principle[] = [
  {
    id: 'early-returns',
    section: 'General',
    strength: 'strong',
    statement: 'Return early on a failed check instead of nesting the happy path in `if` blocks.',
  },
  {
    id: 'no-nested-ternary',
    section: 'General',
    strength: 'tentative',
    statement: 'Use an `if` or a lookup object when a choice has more than two outcomes.',
  },
  {
    id: 'discriminated-unions',
    section: 'TypeScript',
    strength: 'moderate',
    statement: 'Model variants as a discriminated union on `_tag`.',
  },
  {
    id: 'comprehensions',
    section: 'Python',
    strength: 'tentative',
    statement: 'Build lists with a comprehension, not a loop of appends.',
  },
];

const INTRO = "Learned from this project's swipes on https://codetinder.dev";

const general = (id: string, statement = 'S.'): Principle => ({
  id,
  section: 'General',
  strength: 'strong',
  statement,
});

const doc = (...sections: string[]) =>
  ['<!-- codetinder principles · format 2 -->\n# Coding principles', INTRO, ...sections].join(
    '\n\n',
  );

const format1Doc = (...sections: string[]) =>
  ['<!-- codetinder principles · format 1 -->\n# Coding principles', INTRO, ...sections].join(
    '\n\n',
  );

const failure = (text: string) => {
  const result = parsePrinciplesDoc(text);
  if (Result.isSuccess(result)) throw new Error('expected the doc to be rejected');
  return { line: result.failure.line, message: result.failure.message };
};

describe('renderPrinciplesDoc', () => {
  it('renders the documented layout: General first, then each language in the list order', () => {
    expect(renderPrinciplesDoc(principles)).toBe(
      `<!-- codetinder principles · format 3 · edit freely, keep the ids -->
# Coding principles

Learned from this project's swipes on https://codetinder.dev

## General

### early-returns · strong
Return early on a failed check instead of nesting the happy path in \`if\` blocks.

### no-nested-ternary · tentative
Use an \`if\` or a lookup object when a choice has more than two outcomes.

## TypeScript

### discriminated-unions · moderate
Model variants as a discriminated union on \`_tag\`.

## Python

### comprehensions · tentative
Build lists with a comprehension, not a loop of appends.
`,
    );
  });

  it('groups principles by section whatever their order, keeping the order within one', () => {
    const [earlyReturns, noNestedTernary, unions, comprehensions] = principles;
    const shuffled = [comprehensions!, earlyReturns!, unions!, noNestedTernary!];
    expect(renderPrinciplesDoc(shuffled)).toBe(renderPrinciplesDoc(principles));
  });

  it('renders the header alone when there are no principles yet', () => {
    expect(renderPrinciplesDoc([])).toMatch(/swipes on https:\/\/codetinder\.dev\n$/);
  });
});

describe('parsePrinciplesDoc', () => {
  it('reads back what render writes', () => {
    for (const list of [principles, []]) {
      expect(parsePrinciplesDoc(renderPrinciplesDoc(list))).toEqual(Result.succeed(list));
    }
  });

  it('reads an empty file as no principles', () => {
    expect(parsePrinciplesDoc('')).toEqual(Result.succeed([]));
    expect(parsePrinciplesDoc(' \n\t\n')).toEqual(Result.succeed([]));
  });

  it('reads a format 1 doc, every principle under General', () => {
    const text = format1Doc('## early-returns · strong\nS.', '## readonly · moderate\nT.');
    expect(parsePrinciplesDoc(text)).toEqual(
      Result.succeed([
        general('early-returns'),
        { id: 'readonly', section: 'General', strength: 'moderate', statement: 'T.' },
      ]),
    );
  });

  it('rejects a format 1 doc with a section heading', () => {
    expect(failure(format1Doc('## a · strong\nS.', '### early-returns · strong\nS.'))).toEqual({
      line: 9,
      message: 'expected "## <id> · <strength>"',
    });
  });

  it('joins a statement across lines, with CRLF line endings and trailing spaces', () => {
    const text = doc(
      '## General  \n\n### early-returns · strong  \nReturn early\non a failed check.\n\n',
    ).replaceAll('\n', '\r\n');
    expect(parsePrinciplesDoc(text)).toEqual(
      Result.succeed([general('early-returns', 'Return early on a failed check.')]),
    );
  });

  it('reads sections in any order, and an empty one', () => {
    expect(
      parsePrinciplesDoc(
        doc('## Go\n\n### a · strong\nS.', '## Python', '## General\n\n### b · strong\nS.'),
      ),
    ).toEqual(
      Result.succeed([
        { id: 'a', section: 'Go', strength: 'strong', statement: 'S.' },
        general('b'),
      ]),
    );
  });

  it('rejects a doc without the format comment, or of a newer format', () => {
    expect(failure('# Coding principles\n')).toMatchObject({ line: 1 });
    expect(failure('<!-- codetinder principles · format 4 -->\n# Coding principles\n')).toEqual({
      line: 1,
      message: 'format 4 is newer than this release reads (3)',
    });
    expect(failure('<!-- codetinder principles · format 0 -->\n# Coding principles\n')).toEqual({
      line: 1,
      message: 'there is no format 0',
    });
  });

  it('rejects a doc without its title', () => {
    expect(failure('<!-- codetinder principles · format 2 -->\n\n# Principles\n')).toMatchObject({
      line: 3,
    });
    expect(failure('<!-- codetinder principles · format 2 -->\n')).toMatchObject({ line: 1 });
  });

  it('rejects a section that is not General or a known language', () => {
    expect(failure(doc('## Haskell\n\n### a · strong\nS.'))).toEqual({
      line: 6,
      message: expect.stringMatching(
        /^"Haskell" is not a section: General, or one of TypeScript, /,
      ),
    });
  });

  it('rejects a section heading used twice', () => {
    expect(
      failure(doc('## General\n\n### a · strong\nS.', '## General\n\n### b · strong\nS.')),
    ).toEqual({
      line: 11,
      message: '"## General" is an earlier section\'s heading too',
    });
  });

  it('rejects a principle outside a section, and text under a section heading', () => {
    expect(failure(doc('### a · strong\nS.'))).toEqual({
      line: 6,
      message: `expected only "${INTRO}" above the first "## " heading`,
    });
    expect(failure(doc('## General\n\nSome prose.\n\n### a · strong\nS.'))).toEqual({
      line: 8,
      message: 'expected "### <id> · <strength>"',
    });
  });

  it('rejects anything but the intro above the first heading, rather than drop it', () => {
    expect(failure(doc('Our own notes.', '## General\n\n### a · strong\nS.'))).toEqual({
      line: 6,
      message: `expected only "${INTRO}" above the first "## " heading`,
    });
    expect(failure(format1Doc('- Never log secrets.', '## a · strong\nS.'))).toMatchObject({
      line: 6,
    });
  });

  it('rejects an indented heading rather than read it as prose', () => {
    const indented = doc('  ## General\n\n  ### no-secrets · strong\nNever log secrets.');
    expect(failure(indented)).toEqual({
      line: 6,
      message: 'a heading must start at the beginning of its line',
    });
    expect(failure(doc('## General\n\n### a · strong\nS.\n   #### Note'))).toMatchObject({
      line: 10,
    });
    expect(failure(format1Doc(' ## a · strong\nS.'))).toMatchObject({ line: 6 });
  });

  it('rejects a heading that is neither a section nor a principle', () => {
    expect(failure(doc('# Another title'))).toMatchObject({ line: 6 });
    expect(failure(doc('## General\n\n#### a · strong\nS.'))).toMatchObject({ line: 8 });
    expect(failure(doc('## General\n\n### a - strong\nS.'))).toMatchObject({ line: 8 });
    expect(failure(doc('## General\n\n### a\nS.'))).toMatchObject({ line: 8 });
  });

  it('rejects an id that is not kebab-case, and an unknown strength', () => {
    expect(failure(doc('## General\n\n### Early_Returns · strong\nS.'))).toEqual({
      line: 8,
      message: '"Early_Returns" is not a kebab-case id',
    });
    expect(failure(doc('## General\n\n### early-returns · extreme\nS.'))).toEqual({
      line: 8,
      message: '"extreme" is not a strength: tentative, moderate or strong',
    });
  });

  it('rejects an id used twice, even across sections, at its second heading', () => {
    expect(
      failure(doc('## General\n\n### a · strong\nS.', '## Go\n\n### a · moderate\nS.')),
    ).toEqual({
      line: 13,
      message: '"a" is used by an earlier principle',
    });
  });

  it('reads a statement line that starts with # but is not a heading', () => {
    expect(
      parsePrinciplesDoc(doc('## General\n\n### a · strong\n#private fields stay private.')),
    ).toEqual(Result.succeed([general('a', '#private fields stay private.')]));
  });

  it('rejects a principle with no statement, or two paragraphs', () => {
    expect(failure(doc('## General\n\n### a · strong', '### b · strong\nS.'))).toEqual({
      line: 8,
      message: '"a" has no statement',
    });
    expect(failure(doc('## General\n\n### a · strong\nOne.\n\nTwo.'))).toEqual({
      line: 11,
      message: '"a" must be stated in one paragraph',
    });
  });
});

describe('exceptions', () => {
  const narrowed: Principle = {
    ...general('name-values', 'Name a non-trivial value.'),
    exception: {
      id: 'inline-single-use',
      strength: 'tentative',
      statement: 'Inline a value used once that is a single call.',
    },
  };
  const doc3 = (...sections: string[]) =>
    ['<!-- codetinder principles · format 3 -->\n# Coding principles', INTRO, ...sections].join(
      '\n\n',
    );

  it('renders an exception under its principle, and reads it back', () => {
    const text = renderPrinciplesDoc([narrowed]);
    expect(text).toContain(
      '### name-values · strong\nName a non-trivial value.\n\n#### Exception · inline-single-use · tentative\nInline a value used once that is a single call.\n',
    );
    expect(parsePrinciplesDoc(text)).toEqual(Result.succeed([narrowed]));
  });

  it('rejects a second exception under one principle', () => {
    expect(
      failure(
        doc3(
          '## General',
          '### a · strong\nA.',
          '#### Exception · b · tentative\nB.',
          '#### Exception · c · tentative\nC.',
        ),
      ),
    ).toEqual({ line: 14, message: 'a principle holds at most one exception' });
  });

  it("rejects an exception's id used by a principle, and an exception in format 2", () => {
    expect(
      failure(doc3('## General', '### a · strong\nA.', '#### Exception · a · tentative\nB.')),
    ).toMatchObject({ message: '"a" is used by an earlier principle' });
    expect(
      failure(doc('## General', '### a · strong\nA.', '#### Exception · b · tentative\nB.')),
    ).toMatchObject({ message: 'expected "## <section>" or "### <id> · <strength>"' });
  });

  it('reads a format 2 doc, not normalised, so learn rewrites it in format 3', () => {
    const current = readCurrentPrinciples(doc('## General', '### a · strong\nA.'));
    expect(current).toEqual(
      Result.succeed({ _tag: 'Parsed', principles: [general('a', 'A.')], isNormalised: false }),
    );
  });

  it('counts an exception among the ids that must be distinct', () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(PrinciplesSchema)([narrowed, general('inline-single-use')]),
      ),
    ).toBe(true);
  });
});

describe('groupBySection', () => {
  it('groups in the doc order, leaving out empty sections', () => {
    const [earlyReturns, noNestedTernary, unions, comprehensions] = principles;
    expect(groupBySection([comprehensions!, earlyReturns!, unions!, noNestedTernary!])).toEqual([
      { section: 'General', principles: [earlyReturns, noNestedTernary] },
      { section: 'TypeScript', principles: [unions] },
      { section: 'Python', principles: [comprehensions] },
    ]);
  });
});

describe('principlesFor', () => {
  it('keeps the general principles and those of the given languages', () => {
    expect(principlesFor(principles, new Set(['TypeScript'])).map(({ id }) => id)).toEqual([
      'early-returns',
      'no-nested-ternary',
      'discriminated-unions',
    ]);
    expect(principlesFor(principles, new Set()).map(({ id }) => id)).toEqual([
      'early-returns',
      'no-nested-ternary',
    ]);
  });
});

describe('PrinciplesSchema and the doc', () => {
  // Every list the schema accepts must render to a doc that reads back equal.
  const accepted: Principle[][] = [
    [],
    [
      {
        id: 'hashes',
        section: 'General',
        strength: 'moderate',
        statement: '#private fields are fine here.',
      },
    ],
    [
      {
        id: 'double-hash',
        section: 'General',
        strength: 'strong',
        statement: '##no-space is prose, not a heading.',
      },
    ],
    [
      {
        id: 'code',
        section: 'General',
        strength: 'tentative',
        statement: 'Write `# x` only inside code, e.g. `#`.',
      },
    ],
    [
      {
        id: 'unicode',
        section: 'General',
        strength: 'strong',
        statement: 'Prefer “plain” names — even in café.',
      },
    ],
    [
      { id: 'a', section: 'General', strength: 'strong', statement: 'First.' },
      {
        id: 'a-1',
        section: 'General',
        strength: 'moderate',
        statement: 'Second, with a `#` in it.',
      },
    ],
  ];

  it.each(accepted.map(principles => ({ principles })))(
    'reads back the doc it renders: $principles',
    ({ principles }) => {
      const decode = Schema.decodeUnknownResult(PrinciplesSchema);
      expect(Result.isSuccess(decode(principles))).toBe(true);
      expect(parsePrinciplesDoc(renderPrinciplesDoc(principles))).toEqual(
        Result.succeed(principles),
      );
    },
  );

  const rejected: { name: string; principles: unknown[] }[] = [
    {
      name: 'a statement of two paragraphs',
      principles: [{ id: 'a', section: 'General', strength: 'strong', statement: 'One.\n\nTwo.' }],
    },
    {
      name: 'a statement across lines',
      principles: [{ id: 'a', section: 'General', strength: 'strong', statement: 'One.\nTwo.' }],
    },
    {
      name: 'a whitespace-only statement',
      principles: [{ id: 'a', section: 'General', strength: 'strong', statement: '  \t ' }],
    },
    {
      name: 'a statement that is a heading',
      principles: [
        { id: 'a', section: 'General', strength: 'strong', statement: '# Coding principles' },
      ],
    },
    {
      name: 'a statement that is an empty heading',
      principles: [{ id: 'a', section: 'General', strength: 'strong', statement: '#' }],
    },
    {
      name: 'a repeated id',
      principles: [
        { id: 'a', section: 'General', strength: 'strong', statement: 'One.' },
        { id: 'a', section: 'General', strength: 'tentative', statement: 'Two.' },
      ],
    },
  ];

  it.each(rejected)('rejects $name', ({ principles }) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(PrinciplesSchema)(principles))).toBe(true);
  });
});

describe('readCurrentPrinciples', () => {
  it('parses a doc as render writes it, normalised', () => {
    expect(readCurrentPrinciples(renderPrinciplesDoc(principles))).toEqual(
      Result.succeed({ _tag: 'Parsed', principles, isNormalised: true }),
    );
    expect(readCurrentPrinciples('')).toEqual(
      Result.succeed({ _tag: 'Parsed', principles: [], isNormalised: true }),
    );
  });

  it('parses a format 1 doc, not normalised, so learn rewrites it in format 3', () => {
    expect(readCurrentPrinciples(format1Doc('## a · strong\nS.'))).toEqual(
      Result.succeed({ _tag: 'Parsed', principles: [general('a')], isNormalised: false }),
    );
  });

  it('finds a doc edited out of the layout but still readable not normalised', () => {
    const rendered = renderPrinciplesDoc(principles);
    const drifted = [
      rendered.replace('Return early on a failed check', 'Return early\non a failed check'),
      rendered.replace('\n## General\n', '\n## General\n\n'),
      rendered.trimEnd(),
      doc('## Python\n\n### a · strong\nS.', '## General\n\n### b · strong\nS.'),
    ];
    for (const text of drifted) {
      const result = readCurrentPrinciples(text);
      expect(result).toMatchObject(Result.succeed({ _tag: 'Parsed', isNormalised: false }));
    }
  });

  it('hands over a doc in another format, or ours edited out of shape, to convert', () => {
    const unreadable = [
      '# Style guide\n\n- Never use `var`.',
      doc('#### Extra section'),
      doc('  ## General\n\n  ### no-secrets · strong\nNever log secrets.'),
      doc('Never log secrets.', '## General\n\n### a · strong\nS.'),
      renderPrinciplesDoc(principles).replace("Learned from this project's swipes", 'Our own'),
    ];
    for (const text of unreadable) {
      expect(readCurrentPrinciples(text)).toEqual(Result.succeed({ _tag: 'Unconverted', text }));
    }
  });

  it('still rejects a newer format of ours, which converting would lose', () => {
    const newer = '<!-- codetinder principles · format 4 -->\n# Coding principles';
    const result = readCurrentPrinciples(newer);
    if (Result.isSuccess(result)) throw new Error('expected the doc to be rejected');
    expect(result.failure.message).toBe('format 4 is newer than this release reads (3)');
  });
});
