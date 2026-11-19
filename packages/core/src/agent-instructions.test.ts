import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import {
  applyWrittenRuleEdit,
  applyWrittenRuleEdits,
  pointerSection,
  WrittenRuleEditSchema,
  type WrittenRulesFile,
  withPointer,
} from './agent-instructions';

const pointer = pointerSection();

describe('pointerSection', () => {
  it('points at the doc and puts its principles ahead of other style guides', () => {
    expect(pointer).toBe(`<!-- codetinder:principles -->
## Coding principles

Follow the coding principles in \`.codetinder/principles.md\`,
learned by CodeTinder from this team's swipes on https://codetinder.dev.
Where they conflict with another style guide in this repo,
the principles take precedence.
<!-- /codetinder:principles -->
`);
  });
});

describe('withPointer', () => {
  it('appends the section after a blank line, whatever the file ends with', () => {
    expect(withPointer('# A\n')).toBe(`# A\n\n${pointer}`);
    expect(withPointer('# A')).toBe(`# A\n\n${pointer}`);
    expect(withPointer('# A\n\n')).toBe(`# A\n\n${pointer}`);
    expect(withPointer('')).toBe(pointer);
  });

  it("appends in the file's own line ending", () => {
    expect(withPointer('# A\r\n')).toBe(`# A\r\n\r\n${pointer.replaceAll('\n', '\r\n')}`);
  });

  it('adds nothing to a file that already has it', () => {
    expect(withPointer(`# A\n\n${pointer}\nMore.\n`)).toBeUndefined();
    expect(withPointer(`# A\n\n${pointerSection()}`)).toBeUndefined();
  });
});

const contributing = `# Contributing

- Always write an \`else\` branch, even after a return.
- Name things clearly.

${pointer}`;

const edit = (overrides: Partial<Schema.Schema.Type<typeof WrittenRuleEditSchema>> = {}) => ({
  path: 'CONTRIBUTING.md' as const,
  rule: '- Always write an `else` branch, even after a return.\n',
  replacement: '',
  principleId: 'early-returns',
  ...overrides,
});

describe('applyWrittenRuleEdit', () => {
  it('removes or rewrites only the quoted rule', () => {
    expect(applyWrittenRuleEdit(contributing, edit())).toEqual(
      Result.succeed(
        contributing.replace('- Always write an `else` branch, even after a return.\n', ''),
      ),
    );
    expect(
      applyWrittenRuleEdit(
        contributing,
        edit({ replacement: '- Return early instead of `else`.\n' }),
      ),
    ).toEqual(
      Result.succeed(
        contributing.replace(
          'Always write an `else` branch, even after a return.',
          'Return early instead of `else`.',
        ),
      ),
    );
  });

  it('refuses a rule that is not in the file, or is in it twice', () => {
    expect(applyWrittenRuleEdit(contributing, edit({ rule: 'Never use else.' }))).toEqual(
      Result.fail("the rule isn't in the file as quoted"),
    );
    expect(
      applyWrittenRuleEdit(
        `${contributing}\n- Name things clearly.\n`,
        edit({ rule: '- Name things clearly.' }),
      ),
    ).toEqual(Result.fail('the rule is in the file more than once'));
  });

  it("matches a rule quoted with LF in a CRLF file, keeping the file's line endings", () => {
    const crlf = contributing.replaceAll('\n', '\r\n');
    expect(
      applyWrittenRuleEdit(
        crlf,
        edit({
          rule: '- Always write an `else` branch, even after a return.\n- Name things clearly.\n',
          replacement: '- Return early.\n- Name things clearly.\n',
        }),
      ),
    ).toEqual(
      Result.succeed(
        crlf.replace(
          '- Always write an `else` branch, even after a return.\r\n',
          '- Return early.\r\n',
        ),
      ),
    );
  });

  it('refuses overlapping copies of a rule too', () => {
    expect(applyWrittenRuleEdit('aaa', edit({ rule: 'aa' }))).toEqual(
      Result.fail('the rule is in the file more than once'),
    );
  });

  it('guards every marked section, and refuses markers that do not pair up', () => {
    const twice = `${contributing}\n- Late rule.\n\n${pointer}`;
    expect(
      applyWrittenRuleEdit(twice, edit({ rule: 'repo,\nthe principles take precedence.' })),
    ).toEqual(Result.fail('the rule is in the file more than once'));
    expect(applyWrittenRuleEdit(twice, edit({ rule: '- Late rule.\n\n<!--' }))).toEqual(
      Result.fail("the edit touches CodeTinder's section"),
    );
    expect(applyWrittenRuleEdit(twice, edit({ rule: '- Late rule.\n' }))).toEqual(
      Result.succeed(twice.replace('- Late rule.\n', '')),
    );
    const unpaired = `${contributing}\n<!-- codetinder:principles -->\n`;
    expect(applyWrittenRuleEdit(unpaired, edit())).toEqual(
      Result.fail("the file's CodeTinder markers don't pair up"),
    );
  });

  it('refuses a replacement that carries a marker', () => {
    expect(
      applyWrittenRuleEdit(contributing, edit({ replacement: '<!-- /codetinder:principles -->' })),
    ).toEqual(Result.fail("the edit touches CodeTinder's section"));
  });

  it("refuses an edit that touches CodeTinder's section", () => {
    expect(
      applyWrittenRuleEdit(contributing, edit({ rule: 'repo,\nthe principles take precedence.' })),
    ).toEqual(Result.fail("the edit touches CodeTinder's section"));
    expect(
      applyWrittenRuleEdit(contributing, edit({ rule: '<!-- /codetinder:principles -->' })),
    ).toEqual(Result.fail("the edit touches CodeTinder's section"));
  });
});

describe('WrittenRuleEditSchema', () => {
  const decode = Schema.decodeUnknownResult(WrittenRuleEditSchema);

  it('takes a rule from a written-rules file, never another file or a whole file', () => {
    expect(Result.isSuccess(decode(edit()))).toBe(true);
    expect(Result.isFailure(decode(edit({ path: 'src/index.ts' as 'AGENTS.md' })))).toBe(true);
    expect(
      Result.isFailure(decode(edit({ path: '.codetinder/principles.md' as 'AGENTS.md' }))),
    ).toBe(true);
    expect(Result.isFailure(decode(edit({ rule: '' })))).toBe(true);
    expect(Result.isFailure(decode(edit({ rule: 'line\n'.repeat(21) })))).toBe(true);
  });
});

describe('applyWrittenRuleEdits', () => {
  const files = new Map<string, WrittenRulesFile>([
    ['CONTRIBUTING.md', { _tag: 'Text', content: contributing }],
    ['AGENTS.md', { _tag: 'Text', content: '# Agents\n\n- Prefer nested ternaries.\n' }],
    ['GEMINI.md', { _tag: 'NotUtf8' }],
  ]);

  it('applies each edit in turn, skipping the ones that cannot apply, with why', () => {
    const edits = [
      edit(),
      edit({ rule: '- Name things clearly.', replacement: '- Name things for what they hold.' }),
      edit({
        path: 'AGENTS.md',
        rule: '- Prefer nested ternaries.\n',
        principleId: 'no-such-principle',
      }),
      edit({ path: 'CLAUDE.md', rule: 'Anything.' }),
      edit({ path: 'GEMINI.md', rule: 'Anything.' }),
      edit({ rule: 'Not there.' }),
    ];
    const { updates, contents } = applyWrittenRuleEdits({
      edits,
      files,
      principleIds: new Set(['early-returns']),
    });
    expect(updates.map(update => (update._tag === 'Skipped' ? update.reason : 'Updated'))).toEqual([
      'Updated',
      'Updated',
      'there is no principle "no-such-principle"',
      "the file isn't one this proposal may change",
      "the file isn't UTF-8 text",
      "the rule isn't in the file as quoted",
    ]);
    expect([...contents.keys()]).toEqual(['CONTRIBUTING.md']);
    expect(contents.get('CONTRIBUTING.md')).toBe(`# Contributing

- Name things for what they hold.

${pointer}`);
  });
});
