import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

/**
 * The versions a project's commands run on, read from its root: a Node above the default image's
 * 20, and the package manager its lockfile names. A missing field is a version Duo's image has.
 */
export type Pins = {
  readonly nodeMajor?: number;
  readonly packageManager?: string;
};

const DEFAULT_NODE_MAJOR = 20;

const PNPM_PIN = /^pnpm@(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\+|$)/;
const YARN_1_PIN = /^yarn@(1\.\d+\.\d+(?:-[\w.]+)?)(?:\+|$)/;

// Only the fields read here; a package.json that fails to decode counts as unknown.
const PackageJsonSchema = Schema.Struct({
  packageManager: Schema.optionalKey(Schema.String),
  engines: Schema.optionalKey(Schema.Struct({ node: Schema.optionalKey(Schema.String) })),
});

const parsePackageJson = (text: string | undefined) =>
  text === undefined
    ? undefined
    : Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.fromJsonString(PackageJsonSchema))(text),
      );

/** The major of a `.nvmrc` / `.node-version` pin such as `26` or `v26.1.0`; `lts/*` has none. */
const nodeMajorFromVersionFile = (text: string | undefined): number | undefined => {
  const major = /^v?(\d+)(?:\.[\dx]+)*$/.exec(text?.trim() ?? '')?.[1];
  return major === undefined ? undefined : Number(major);
};

/** The first number in an `engines.node` range, so `>=26`, `^24.1` and `>=22 <27` read as 26, 24, 22. */
const nodeMajorFromEngines = (range: string | undefined): number | undefined => {
  const major = /\d+/.exec(range ?? '')?.[0];
  return major === undefined ? undefined : Number(major);
};

/**
 * The package manager a root lockfile belongs to, in the order the setup guesses the toolchain. npm
 * is in Duo's image, so it has no pin; pnpm and Yarn 1 aren't, so they default to a version.
 */
const packageManagerFor = (fileNames: ReadonlySet<string>, packageManager: string | undefined) => {
  if (fileNames.has('pnpm-lock.yaml')) {
    return `pnpm@${PNPM_PIN.exec(packageManager ?? '')?.[1] ?? '10'}`;
  }
  if (fileNames.has('package-lock.json')) return undefined;
  if (fileNames.has('yarn.lock')) {
    return `yarn@${YARN_1_PIN.exec(packageManager ?? '')?.[1] ?? '1'}`;
  }
  return undefined;
};

/**
 * Reads the pins from the repo root: `.nvmrc` / `.node-version` wins over `engines.node` for Node,
 * and `packageManager` pins the package manager its lockfile names.
 */
export const readPins = ({
  fileNames,
  packageJson,
  nodeVersionFile,
}: {
  readonly fileNames: ReadonlyArray<string>;
  readonly packageJson?: string;
  readonly nodeVersionFile?: string;
}): Pins => {
  const pkg = parsePackageJson(packageJson);
  const nodeMajor =
    nodeMajorFromVersionFile(nodeVersionFile) ?? nodeMajorFromEngines(pkg?.engines?.node);
  const packageManager = packageManagerFor(new Set(fileNames), pkg?.packageManager);
  return {
    ...(nodeMajor !== undefined && nodeMajor > DEFAULT_NODE_MAJOR ? { nodeMajor } : {}),
    ...(packageManager === undefined ? {} : { packageManager }),
  };
};

/** `text` as one single-quoted word for `sh`: each embedded quote closed, escaped, and reopened. */
const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The command run on the pinned versions: `npx` puts each package's bin on PATH, and `sh -c` keeps
 * the command's own env prefixes and `&&`. Unchanged when nothing is pinned. Foreground scripts,
 * because npm otherwise hides a failing install script's output, and a package that can't run its
 * own postinstall (a Node the image lacks a library for) would fail without a word.
 *
 * ponytail: verified under `srt` with Duo's settings and environment in a container, not yet in a Duo
 * job.
 */
export const pinnedCommand = (command: string, pins: Pins): string => {
  const packages = [
    ...(pins.nodeMajor === undefined ? [] : [`node@${pins.nodeMajor}`]),
    ...(pins.packageManager === undefined ? [] : [pins.packageManager]),
  ];
  if (packages.length === 0) return command;
  const flags = packages.map(pkg => `-p ${pkg}`).join(' ');
  return `npx --yes --foreground-scripts ${flags} -- sh -c ${shellQuote(command)}`;
};
