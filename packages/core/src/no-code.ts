/** Extensions of files that hold no code: prose and images. */
const NOT_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
]);

const LOCKFILES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
]);

/**
 * Whether a changed file clearly holds no code. A merge request whose files all do has no function
 * to rewrite, so the flow stops before the agent, which is billed per call.
 */
export const isNotCode = (path: string): boolean => {
  const name = path.split('/').at(-1) ?? path;
  if (LOCKFILES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0;
  if (!hasExtension) return false;
  const extension = name.slice(dot).toLowerCase();
  return NOT_CODE_EXTENSIONS.has(extension);
};
