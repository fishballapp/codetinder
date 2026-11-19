import * as Schema from 'effect/Schema';

/**
 * The languages a principles doc has a section for, in the doc's order. A file's language comes
 * from its extension; code in any other language follows the general principles only.
 */
export const LanguageSchema = Schema.Literals([
  'TypeScript',
  'JavaScript',
  'Python',
  'Go',
  'Rust',
  'Java',
  'Kotlin',
  'Swift',
  'C#',
  'C++',
  'C',
  'Ruby',
  'PHP',
  'Scala',
  'Elixir',
  'Shell',
]);
export type Language = typeof LanguageSchema.Type;

const EXTENSIONS: Record<Language, readonly string[]> = {
  TypeScript: ['.ts', '.tsx', '.mts', '.cts'],
  JavaScript: ['.js', '.jsx', '.mjs', '.cjs'],
  Python: ['.py', '.pyi'],
  Go: ['.go'],
  Rust: ['.rs'],
  Java: ['.java'],
  Kotlin: ['.kt', '.kts'],
  Swift: ['.swift'],
  'C#': ['.cs'],
  // A `.h` header is C or C++, which its extension can't tell apart: it counts as both.
  'C++': ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'],
  C: ['.c', '.h'],
  Ruby: ['.rb'],
  PHP: ['.php'],
  Scala: ['.scala'],
  Elixir: ['.ex', '.exs'],
  Shell: ['.sh', '.bash'],
};

/**
 * The languages of the files at `paths`, by their extensions, in the doc's order; none for a file
 * in a language without a section.
 */
export const languagesOf = (paths: readonly string[]): Set<Language> => {
  const extensions = new Set(
    paths.flatMap(path => /\.[^./]+$/.exec(path)?.[0]?.toLowerCase() ?? []),
  );
  return new Set(
    LanguageSchema.literals.filter(language =>
      EXTENSIONS[language].some(extension => extensions.has(extension)),
    ),
  );
};
