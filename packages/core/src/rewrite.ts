/**
 * The rewrite agents' answers, saved in the repo beside `.codetinder/task.md`: Duo's file tools
 * only write there. A run rewrites for learn or for a sweep, never both, so they share these. None
 * is ever committed: a proposal commits only the files it names.
 */
export const REWRITE_RUN_FILES = {
  rewriteAnswer: '.codetinder/rewrite-answer.json',
  // Duo's `create_file_with_contents` refuses a file that exists, so the retry answers to its own.
  retryAnswer: '.codetinder/rewrite-retry-answer.json',
} as const;

/**
 * What `flow-steps` keeps of a rewrite for its later steps, outside the repo, where the rewrite
 * agent's file tools can't reach it: the agent edits files, and a prompt in the code could aim it
 * at these.
 */
export const REWRITE_STATE_FILES = {
  // The untracked paths before the rewrite, NUL-terminated: the runner's own dotfiles among them,
  // which `verify` must not delete as the rewrite's.
  untrackedBefore: '/tmp/codetinder/untracked-before.txt',
  // The last `verify` verdict line, and the tail of its failing test output for the retry.
  verdict: '/tmp/codetinder/rewrite-verdict.txt',
  testOutput: '/tmp/codetinder/rewrite-test-output.txt',
  // Set only when the last verdict is `verified`: the project's test command, as its config names
  // it, which the rewrite's note says passed.
  testCommand: '/tmp/codetinder/rewrite-test-command.txt',
  // Set only when the last verdict is an environment failure: `propose` says why in its note.
  environment: '/tmp/codetinder/rewrite-environment.json',
} as const;

/**
 * What decides whether the tests pass, which a rewrite must never touch: CodeTinder's and GitLab's
 * config, CI, manifests and lockfiles, tool config, and the tests themselves. Otherwise a retry
 * could make the tests pass by changing them.
 */
const PROTECTED = [
  /^\.(codetinder|gitlab)\//,
  /^\.gitlab-ci\.yml$/,
  /(^|\/)(package\.json|tsconfig[^/]*\.json|Makefile|justfile|pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|Cargo\.toml|go\.mod|go\.sum|Gemfile|[^/]*\.gemspec|build\.gradle(\.kts)?|pom\.xml)$/,
  /(^|\/)[^/]*(lock\.json|lock\.yaml|\.lock|\.lockb)$/,
  /(^|\/)[^/]*\.config\.[^/]+$/,
  /(^|\/)[^/]*\.(conf|setup)\.[^/]+$/,
  /(^|\/)(conftest|noxfile|setup)\.py$/,
  /(^|\/)\.[^/]*rc(\.[^/]+)?$/,
  /(^|\/)(__tests__|__mocks__|tests?|spec|specs)\//,
  /[._-](test|spec)s?\.[^/]+$/,
  /(^|\/)test_[^/]+$/,
];

/**
 * Whether a rewrite may change `file`: only a file in its scope (the code a merge request changes,
 * or a sweep's functions' files), and never what decides whether the tests pass.
 */
export const isRewritable = (file: string, scope: ReadonlySet<string>): boolean =>
  scope.has(file) && !PROTECTED.some(pattern => pattern.test(file));
