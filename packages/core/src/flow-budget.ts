import * as Duration from 'effect/Duration';

/**
 * What each kind of step in packages/flows/codetinder.yml is given: a command `run_command`'s 120 seconds,
 * a test step its `timeout: "1800"`, and an agent its prompt's `timeout: 300`. That one bounds each
 * of the agent's model requests, not the agent's whole run: 300 seconds is what an agent has taken
 * in every run seen, not a limit.
 */
export const STEP_TIMEOUTS = {
  command: Duration.seconds(120),
  agent: Duration.seconds(300),
  tests: Duration.seconds(1800),
} as const;

/** For the gaps the steps' timeouts don't count: the session starting, the saves, the routers. */
const RUN_MARGIN = Duration.minutes(5);

/**
 * How long a run of these steps takes at most, from the first to the last that needs its claim,
 * as far as the runs seen go: a claim's hold. A slower live run loses its claim; the API then
 * refuses what it would publish, so the cost is a run billed twice, never two records.
 */
export const runTimeout = ({
  commands,
  agents,
  testSteps,
}: {
  readonly commands: number;
  readonly agents: number;
  readonly testSteps: number;
}): Duration.Duration =>
  [
    Duration.times(STEP_TIMEOUTS.command, commands),
    Duration.times(STEP_TIMEOUTS.agent, agents),
    Duration.times(STEP_TIMEOUTS.tests, testSteps),
  ].reduce((total, steps) => Duration.sum(total, steps), RUN_MARGIN);
