import { parseDocument } from 'yaml';
import type { AgentConfigNeeds } from './agent-config';
import { code } from './fence';
import type { Diagnosis } from './sandbox-diagnosis';

/**
 * What each fix branch's name starts with. Every new fix MR gets a branch of its own, so a branch
 * someone else wrote to is never overwritten.
 */
export const SANDBOX_FIX_BRANCH_PREFIX = 'codetinder/sandbox-fix-';

/** What a fix MR's description has, for finding the fix MRs among the project's. */
export const SANDBOX_FIX_SEARCH = 'codetinder:sandbox-fix';

/** Whether a merge request is one of CodeTinder's sandbox fixes: its branch and its markers. */
export const isSandboxFixMergeRequest = ({
  sourceBranch,
  description,
}: {
  readonly sourceBranch: string;
  readonly description: string;
}): boolean =>
  sourceBranch.startsWith(SANDBOX_FIX_BRANCH_PREFIX) &&
  description.includes(`<!-- ${SANDBOX_FIX_SEARCH} `);

/**
 * The package that provides each shared library on Duo's default image (RHEL 9, `microdnf` over
 * the public UBI 9 repos), checked against the UBI 9 x86_64 BaseOS and AppStream metadata. The
 * libraries Node's newer builds and headless browsers (Puppeteer, Playwright's Chromium) ask for.
 */
const LIBRARY_PACKAGES: Readonly<Record<string, string>> = {
  'libatomic.so.1': 'libatomic',
  'libstdc++.so.6': 'libstdc++',
  'libgomp.so.1': 'libgomp',
  'libz.so.1': 'zlib',
  'libuuid.so.1': 'libuuid',
  'libexpat.so.1': 'expat',
  'libffi.so.8': 'libffi',
  'libssl.so.1.1': 'compat-openssl11',
  'libcrypto.so.1.1': 'compat-openssl11',
  'libnss3.so': 'nss',
  'libsmime3.so': 'nss',
  'libnssutil3.so': 'nss-util',
  'libnspr4.so': 'nspr',
  'libatk-1.0.so.0': 'atk',
  'libatk-bridge-2.0.so.0': 'at-spi2-atk',
  'libatspi.so.0': 'at-spi2-core',
  'libcups.so.2': 'cups-libs',
  'libdbus-1.so.3': 'dbus-libs',
  'libdrm.so.2': 'libdrm',
  'libgbm.so.1': 'mesa-libgbm',
  'libasound.so.2': 'alsa-lib',
  'libxkbcommon.so.0': 'libxkbcommon',
  'libX11.so.6': 'libX11',
  'libX11-xcb.so.1': 'libX11-xcb',
  'libxcb.so.1': 'libxcb',
  'libXcomposite.so.1': 'libXcomposite',
  'libXdamage.so.1': 'libXdamage',
  'libXext.so.6': 'libXext',
  'libXfixes.so.3': 'libXfixes',
  'libXrandr.so.2': 'libXrandr',
  'libXrender.so.1': 'libXrender',
  'libXi.so.6': 'libXi',
  'libXtst.so.6': 'libXtst',
  'libXss.so.1': 'libXScrnSaver',
  'libXcursor.so.1': 'libXcursor',
  'libxshmfence.so.1': 'libxshmfence',
  'libpango-1.0.so.0': 'pango',
  'libcairo.so.2': 'cairo',
  'libgtk-3.so.0': 'gtk3',
  'libgdk-3.so.0': 'gtk3',
  'libglib-2.0.so.0': 'glib2',
  'libgobject-2.0.so.0': 'glib2',
  'libgio-2.0.so.0': 'glib2',
  'libfontconfig.so.1': 'fontconfig',
  'libfreetype.so.6': 'freetype',
  'libEGL.so.1': 'libglvnd-egl',
  'libGL.so.1': 'libglvnd-glx',
  'libwayland-client.so.0': 'libwayland-client',
};

/** One change a sandbox fix makes: a host to allow, or a library to install from its package. */
export type SandboxFixItem =
  | { readonly _tag: 'Host'; readonly host: string }
  | { readonly _tag: 'Library'; readonly library: string; readonly package: string };

/**
 * What would fix the sandbox for `diagnosis`: the hosts it blocked, or the packages of the libraries
 * it lacked. None for another diagnosis, or a library with no known package: a fix that leaves one
 * out wouldn't make the run work.
 */
export const sandboxFixItems = (diagnosis: Diagnosis): SandboxFixItem[] => {
  if (diagnosis._tag === 'BlockedHosts') {
    return diagnosis.hosts.map(host => ({ _tag: 'Host', host }));
  }
  if (diagnosis._tag !== 'MissingLibraries') return [];
  const items = diagnosis.libraries.flatMap((library): SandboxFixItem[] => {
    const pkg = LIBRARY_PACKAGES[library];
    return pkg === undefined ? [] : [{ _tag: 'Library', library, package: pkg }];
  });
  return items.length === diagnosis.libraries.length ? items : [];
};

/** An item's marker in the fix MR's description: how a later run knows what it proposed. */
const markerOf = (item: SandboxFixItem): string =>
  item._tag === 'Host'
    ? `<!-- codetinder:sandbox-fix host=${item.host} -->`
    : `<!-- codetinder:sandbox-fix library=${item.library} -->`;

/** Whether a fix MR's `description` proposed `item`. */
export const isProposedIn = (description: string, item: SandboxFixItem): boolean =>
  description.includes(markerOf(item));

/** The items a fix MR's `description` proposed, read back from their markers. */
export const sandboxFixItemsOf = (description: string): SandboxFixItem[] =>
  [...description.matchAll(/<!-- codetinder:sandbox-fix (host|library)=(\S+) -->/g)].flatMap(
    ([, kind, value]): SandboxFixItem[] => {
      if (value === undefined) return [];
      if (kind === 'host') return [{ _tag: 'Host', host: value }];
      const pkg = LIBRARY_PACKAGES[value];
      return pkg === undefined ? [] : [{ _tag: 'Library', library: value, package: pkg }];
    },
  );

/** Whether two items fix the same thing. */
export const isSameSandboxFixItem = (a: SandboxFixItem, b: SandboxFixItem): boolean =>
  markerOf(a) === markerOf(b);

/**
 * Which of `items` the agent config `content` already has: the host in its allow-list, the package
 * in a `microdnf install` line of its `setup_script`. A config that doesn't parse has none.
 */
export const sandboxFixItemsIn = (
  content: string,
  items: readonly SandboxFixItem[],
): SandboxFixItem[] => {
  const config = (() => {
    try {
      const value: unknown = parseDocument(content).toJS();
      return typeof value === 'object' && value !== null ? value : {};
    } catch {
      return {};
    }
  })();
  const strings = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  };
  const policy = 'network_policy' in config ? config.network_policy : undefined;
  const domains = strings(
    typeof policy === 'object' && policy !== null && 'allowed_domains' in policy
      ? policy.allowed_domains
      : undefined,
  );
  const installed = strings('setup_script' in config ? config.setup_script : undefined).flatMap(
    command => /^\s*microdnf install -y (.+)$/.exec(command)?.[1]?.split(/\s+/) ?? [],
  );
  return items.filter(item =>
    item._tag === 'Host' ? domains.includes(item.host) : installed.includes(item.package),
  );
};

/** The fix MR a failure's note points at: one CodeTinder just opened, or the open one it added to. */
export type SandboxFixMergeRequest = { readonly iid: number; readonly isNew: boolean };

/** What the agent config needs for `items`. */
export const sandboxFixNeeds = (items: readonly SandboxFixItem[]): AgentConfigNeeds => {
  const libraries = items.flatMap(item => (item._tag === 'Library' ? [item] : []));
  const packages = [...new Set(libraries.map(item => item.package))];
  return {
    allowedDomains: items.flatMap(item => (item._tag === 'Host' ? [item.host] : [])),
    setupScript:
      packages.length === 0
        ? []
        : [
            {
              command: `microdnf install -y ${packages.join(' ')}`,
              why: `Added by CodeTinder: the project's install or tests load ${libraries
                .map(item => item.library)
                .join(', ')}, which Duo's default image lacks.`,
              isForDefaultImage: true,
            },
          ],
  };
};

export const SANDBOX_FIX_TITLE = "Fix CodeTinder's sandbox 🔧";

const itemLine = (item: SandboxFixItem): string =>
  item._tag === 'Host'
    ? `- Allow ${code(item.host)} in ${code('network_policy.allowed_domains')}, which the sandbox blocked. ${markerOf(item)}`
    : `- Install ${code(item.package)} in ${code('setup_script')}, for ${code(item.library)}, which the image lacks. ${markerOf(item)}`;

/**
 * The fix MR's description, listing every item it proposes, each with its marker. Closing it says
 * no to them: CodeTinder doesn't propose them again.
 */
export const sandboxFixDescription = (items: readonly SandboxFixItem[]): string =>
  `🔧 **CodeTinder's sandbox needs a hand**

A CodeTinder run failed before it changed anything: the sandbox Duo runs flows in is missing something your project needs. Merging this adds it to \`.gitlab/duo/agent-config.yml\`, which Duo reads from the default branch:

${items.map(itemLine).join('\n')}

Merge it and the next merge request gets a round. Close it if you'd rather not: CodeTinder won't propose these again.
`;
