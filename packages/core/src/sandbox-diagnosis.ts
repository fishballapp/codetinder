import * as Schema from 'effect/Schema';

/**
 * What a failed command's output says about the sandbox it ran in. A command that fails before any
 * change is made failed for the environment, not for the change.
 */
const BlockedHostsSchema = Schema.Struct({
  _tag: Schema.Literal('BlockedHosts'),
  hosts: Schema.Array(Schema.String),
});
const ReadOnlyPathsSchema = Schema.Struct({
  _tag: Schema.Literal('ReadOnlyPaths'),
  paths: Schema.Array(Schema.String),
});
const MissingLibrariesSchema = Schema.Struct({
  _tag: Schema.Literal('MissingLibraries'),
  libraries: Schema.Array(Schema.String),
});
const TimedOutSchema = Schema.Struct({ _tag: Schema.Literal('TimedOut') });
const UnknownSchema = Schema.Struct({ _tag: Schema.Literal('Unknown') });
export const DiagnosisSchema = Schema.Union([
  BlockedHostsSchema,
  ReadOnlyPathsSchema,
  MissingLibrariesSchema,
  TimedOutSchema,
  UnknownSchema,
]);
export type Diagnosis = typeof DiagnosisSchema.Type;

/** A hostname, or an IPv4 address: the shapes the sandbox's refusals print. */
const HOST = String.raw`([\w-]+(?:\.[\w-]+)*)`;

/** Each pattern takes the refused host from one line of output. */
const REFUSED_HOST_PATTERNS: readonly RegExp[] = [
  // npm and pnpm: `403 Forbidden - GET https://host/path`.
  new RegExp(String.raw`\b403 Forbidden - [A-Z]+ https?://${HOST}`),
  // The egress proxy refusing a tunnel: `CONNECT host:443` on a line that also has the 403.
  new RegExp(String.raw`\bCONNECT ${HOST}:\d+(?=.*\b403\b)`),
  // The sandbox doesn't resolve the hosts it blocks: `getaddrinfo ENOTFOUND host`.
  new RegExp(String.raw`\b(?:ENOTFOUND|EAI_AGAIN) ${HOST}`),
  // A connection refused: `connect ECONNREFUSED host:5432`.
  new RegExp(String.raw`\bECONNREFUSED ${HOST}:\d+`),
];

/** A service on this machine refusing the tests is not the sandbox's doing. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

const hostOfLine = (line: string): string | undefined =>
  REFUSED_HOST_PATTERNS.map(pattern => pattern.exec(line)?.[1]).find(
    host => host !== undefined && !LOCAL_HOSTS.has(host),
  );

/** Each pattern takes the path a write was refused from one line of output. */
const READ_ONLY_PATH_PATTERNS: readonly RegExp[] = [
  // Node, so npm and pnpm: `EROFS: read-only file system, mkdir '/var/lib/x/.gitlab'`.
  /\bEROFS: read-only file system, \w+ '([^']+)'/,
  // Coreutils: `cannot create directory '/var/lib/x': Read-only file system`; Go: `open /w/f: read-only file system`.
  /'?(\/[^\s']*)'?: [Rr]ead-only file system/,
];

const readOnlyPathOfLine = (line: string): string | undefined =>
  READ_ONLY_PATH_PATTERNS.map(pattern => pattern.exec(line)?.[1]).find(path => path !== undefined);

/** The loader's report of a binary that needs a system library the image lacks. */
const MISSING_LIBRARY =
  /\berror while loading shared libraries: (\S+): cannot open shared object file/;

/** How the tests or install timed out: a test runner's report, or a process killed for it. */
const TIMED_OUT =
  /\btimed out\b|\bExceeded timeout\b|\bTimeout of \d+ms exceeded\b|\bETIMEDOUT\b|\bSIGTERM\b/i;

/** What `find` takes from each line of output, once each, in the order first seen. */
const distinctFromLines = (
  outputTail: string,
  find: (line: string) => string | undefined,
): string[] => [
  ...new Set(
    outputTail
      .split('\n')
      .map(find)
      .filter(found => found !== undefined),
  ),
];

/**
 * Why a command failed, from its output tail. A blocked host wins over a timeout, since a sandbox
 * that refuses a host often also leaves the test waiting; a refused write wins over it too, as a
 * tool that can't write its cache dies before it gets that far, and so does one that can't load a
 * system library. Hosts, paths and libraries keep the order they first appear.
 */
export const diagnoseFailure = (outputTail: string): Diagnosis => {
  const hosts = distinctFromLines(outputTail, hostOfLine);
  if (hosts.length > 0) return { _tag: 'BlockedHosts', hosts };
  const paths = distinctFromLines(outputTail, readOnlyPathOfLine);
  if (paths.length > 0) return { _tag: 'ReadOnlyPaths', paths };
  const libraries = distinctFromLines(outputTail, line => MISSING_LIBRARY.exec(line)?.[1]);
  if (libraries.length > 0) return { _tag: 'MissingLibraries', libraries };
  if (TIMED_OUT.test(outputTail)) return { _tag: 'TimedOut' };
  return { _tag: 'Unknown' };
};

/** A stage of the flow's checks that failed before any change: the install, or the tests. */
export const EnvironmentFailureSchema = Schema.Struct({
  stage: Schema.Literals(['install', 'tests']),
  diagnosis: DiagnosisSchema,
  outputTail: Schema.String,
  // Absent for a check stopped at its deadline, which has no one command to blame.
  command: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Int),
});
export type EnvironmentFailure = typeof EnvironmentFailureSchema.Type;
