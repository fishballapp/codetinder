import { code } from './fence';
import { plain } from './notes';
import { type Principle, rulesOf } from './principles';
import type { ProjectConfig } from './project-config';
import type { SweepFinding } from './sweep';

const functionsCount = (count: number) => `${count} function${count === 1 ? '' : 's'}`;

/** The sweep MR's title. */
export const sweepTitle = ({
  tone,
  count,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly count: number;
}): string =>
  tone === 'mischievous'
    ? `💘 CodeTinder sweep: ${functionsCount(count)} brought in line with your principles`
    : `CodeTinder sweep: ${functionsCount(count)} brought in line with your principles`;

const findingLines = (
  { file, name, principleIds, why }: SweepFinding,
  principles: readonly Principle[],
): string => {
  const followed = principleIds.flatMap(id => {
    const principle = rulesOf(principles).find(candidate => candidate.id === id);
    return principle === undefined ? [] : [`  - ${code(id)}: ${plain(principle.statement)}`];
  });
  return [`- ${code(name)} in ${code(file)}: ${plain(why)}`, ...followed].join('\n');
};

/** The paragraph saying how many functions wait for the next sweep; none when none do. */
const leftParagraphs = (tone: ProjectConfig['tone'], leftCount: number): string[] => {
  if (leftCount === 0) return [];
  const more = `${functionsCount(leftCount)} more`;
  if (tone === 'mischievous') return [`${more} left for the next sweep. I'll be back. 😘`];
  return [`${more} left for the next sweep.`];
};

/**
 * The sweep MR's description: each function it rewrote, the principles it now follows and why it
 * didn't, a link to the principles doc, and how many functions wait for the next sweep.
 */
export const sweepDescription = ({
  tone,
  functions,
  principles,
  principlesUrl,
  leftCount,
}: {
  readonly tone: ProjectConfig['tone'];
  readonly functions: readonly SweepFinding[];
  readonly principles: readonly Principle[];
  readonly principlesUrl: string;
  readonly leftCount: number;
}): string => {
  const doc = `[your coding principles](${principlesUrl})`;
  const intro =
    tone === 'mischievous'
      ? `💘 Your code's been seeing other styles. I brought ${functionsCount(functions.length)} changed since the last sweep back in line with ${doc}; each is meant to behave as before, and your tests pass on them all.`
      : `This rewrites ${functionsCount(functions.length)} changed since the last sweep to follow ${doc}. Each is meant to behave as before, and the project's tests pass on the rewrite.`;
  const findings = functions.map(finding => findingLines(finding, principles)).join('\n');
  return [intro, findings, ...leftParagraphs(tone, leftCount)].join('\n\n');
};

/** The sweep's commit message: what it rewrote, one function a line. */
export const sweepCommitMessage = (functions: readonly SweepFinding[]): string =>
  [
    `style: bring ${functionsCount(functions.length)} in line with the coding principles`,
    functions
      .map(({ file, name, principleIds }) => `- ${file}: ${name} (${principleIds.join(', ')})`)
      .join('\n'),
  ].join('\n\n');
