import type { Card } from '@codetinder/core';

/** The function the demo round picked, as it is in the merge request. */
const target = `function summarize(
  todos: Todo[]
): string {
  let left = 0;
  for (const t of todos) {
    if (!t.done) {
      left++;
    }
  }
  return left === 0
    ? 'All done!'
    : \`\${left} to go\`;
}`;

const pipeline: Card = {
  id: 'c1',
  operation: 'Replace Loop with Pipeline',
  change: 'Counts the open todos with filter instead of a loop.',
  principle: {
    id: 'pipelines-over-loops',
    statement: 'Count and collect with array pipelines (`filter`, `map`), not hand-written loops.',
  },
  stance: 'supports',
  kind: 'explore',
  after: `function summarize(
  todos: Todo[]
): string {
  const left = todos.filter(
    t => !t.done
  ).length;
  return left === 0
    ? 'All done!'
    : \`\${left} to go\`;
}`,
};

const descriptiveNames = {
  id: 'descriptive-names',
  statement: 'Name a variable for what it holds, even in a short scope.',
};

/**
 * The landing page's demo round: one function from the `todo-demo` project and six one-change
 * cards on it, in the shape of a real round, with one consistency pair (`descriptive-names`, once
 * each way). Each line fits the phone's card unwrapped. Labelled as a demo wherever it shows.
 */
export const DEMO_ROUND = {
  mergeRequestIid: 12,
  target: { file: 'src/summary.ts', symbol: 'summarize', text: target },
  symbols: ['Todo'],
  cards: [
    pipeline,
    {
      id: 'c2',
      operation: 'Rename Variable',
      change: 'Renames the loop variable t to todo.',
      principle: descriptiveNames,
      stance: 'supports',
      kind: 'consistency',
      after: target.replace('const t of', 'const todo of').replace('!t.done', '!todo.done'),
    },
    {
      id: 'c3',
      operation: 'Replace Ternary with If Statement',
      change: 'Returns each message from its own branch instead of a ternary.',
      principle: {
        id: 'ternary-returns',
        statement: 'Return a choice between two values as one ternary.',
      },
      stance: 'opposes',
      kind: 'explore',
      after: target.replace(
        `  return left === 0
    ? 'All done!'
    : \`\${left} to go\`;`,
        `  if (left === 0) {
    return 'All done!';
  }
  return \`\${left} to go\`;`,
      ),
    },
    {
      id: 'c4',
      operation: 'Function Declaration to Arrow Function',
      change: 'Declares summarize as an arrow function.',
      principle: {
        id: 'function-declarations',
        statement: 'Declare named functions with `function`, not as arrow constants.',
      },
      stance: 'opposes',
      kind: 'explore',
      after: `${target
        .replace('function summarize(', 'const summarize = (')
        .replace('): string {', '): string => {')};`,
    },
    {
      id: 'c5',
      operation: 'Replace Nested Conditional with Guard Clause',
      change: 'Skips done todos with continue instead of nesting the count.',
      principle: {
        id: 'guard-clauses',
        statement:
          'Skip the cases a loop or function leaves alone first, instead of nesting the rest.',
      },
      stance: 'supports',
      kind: 'explore',
      after: target.replace(
        `    if (!t.done) {
      left++;
    }`,
        `    if (t.done) {
      continue;
    }
    left++;`,
      ),
    },
    {
      id: 'c6',
      operation: 'Rename Variable',
      change: 'Renames left to n.',
      principle: descriptiveNames,
      stance: 'opposes',
      kind: 'consistency',
      after: target.replaceAll('left', 'n'),
    },
  ] satisfies Card[],
} as const;

/** The card the landing's How it works pictures mid-like. */
export const STILL_CARD = pipeline;
