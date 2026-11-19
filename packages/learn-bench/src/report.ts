import type { RunRecord } from './record';
import { type RunScore, scoreRun } from './score';

const percent = (share: number) => `${Math.round(share * 100)}%`;
const decimal = (value: number) => value.toFixed(2);

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

/** A column: its heading, and its cell from a group's run scores, averaged over the runs. */
const COLUMNS: readonly {
  readonly heading: string;
  readonly cell: (scores: readonly RunScore[]) => string;
}[] = [
  { heading: 'runs', cell: scores => String(scores.length) },
  { heading: 'net', cell: scores => decimal(mean(scores.map(({ prediction }) => prediction.net))) },
  {
    heading: 'net range',
    cell: scores => {
      const nets = scores.map(({ prediction }) => prediction.net);
      return `${decimal(Math.min(...nets))}–${decimal(Math.max(...nets))}`;
    },
  },
  {
    heading: 'accuracy',
    cell: scores => percent(mean(scores.map(({ prediction }) => prediction.accuracy))),
  },
  {
    heading: 'coverage',
    cell: scores => percent(mean(scores.map(({ prediction }) => prediction.coverage))),
  },
  {
    heading: 'rule-card net',
    cell: scores => {
      const ruled = scores.filter(
        ({ ruleCards }) => ruleCards.correct + ruleCards.wrong + ruleCards.abstained > 0,
      );
      return ruled.length === 0 ? '-' : decimal(mean(ruled.map(({ ruleCards }) => ruleCards.net)));
    },
  },
  {
    heading: 'principles',
    cell: scores => decimal(mean(scores.map(({ finalDoc }) => finalDoc.principles))),
  },
  { heading: 'lines', cell: scores => decimal(mean(scores.map(({ finalDoc }) => finalDoc.lines))) },
  {
    heading: 'exceptions/principle',
    cell: scores => decimal(mean(scores.map(({ finalDoc }) => finalDoc.qualifiersPerPrinciple))),
  },
  {
    heading: 'max exceptions',
    cell: scores => String(Math.max(0, ...scores.map(({ finalDoc }) => finalDoc.maxQualifiers))),
  },
  {
    heading: 'flip-flops',
    cell: scores => decimal(mean(scores.map(({ churn }) => churn.flipFlops))),
  },
  { heading: 're-added', cell: scores => decimal(mean(scores.map(({ churn }) => churn.readded))) },
  {
    heading: 'rewordings',
    cell: scores => decimal(mean(scores.map(({ churn }) => churn.rewordings))),
  },
  {
    heading: 'learn failures',
    cell: scores => decimal(mean(scores.map(({ learnFailures }) => learnFailures))),
  },
];

const groupKey = ({ label, learner, developer, noise }: RunRecord) =>
  `${label} · ${learner} · ${developer}${noise > 0 ? ` · noise ${percent(noise)}` : ''}`;

/** A markdown table, one row per label, learner, developer and noise, its runs averaged. */
export const renderReport = (records: readonly RunRecord[]): string => {
  const groups = Map.groupBy(records, groupKey);
  const rows = [...groups].map(([key, group]) => {
    const scores = group.map(scoreRun);
    return [key, ...COLUMNS.map(({ cell }) => cell(scores))];
  });
  const header = ['run', ...COLUMNS.map(({ heading }) => heading)];
  return [header, header.map(() => '---'), ...rows]
    .map(cells => `| ${cells.join(' | ')} |`)
    .join('\n');
};
